/**
 * Read-only report for one live_to_clips run. DATABASE_URL must already be in the environment;
 * this entry point never loads .env files. IDs select an administrative report, not an HTTP auth context.
 * usage: report:live-to-clips (--run <uuid> | --source <uuid>) [--labels <json>]
 *        [--mode-label <text>] --out <markdown-path>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createDataSource } from '../db/data-source.js';
import { ClipSuggestionEntity } from '../db/entities/clip-suggestion.entity.js';
import { JobEntity } from '../db/entities/job.entity.js';
import { JobAttemptEntity } from '../db/entities/job-attempt.entity.js';
import { LlmCallEntity } from '../db/entities/llm-call.entity.js';
import { VideoSourceEntity } from '../db/entities/video-source.entity.js';
import { WorkflowRunEntity } from '../db/entities/workflow-run.entity.js';
import {
  computeLiveToClipsReport,
  type ReportLabels,
  renderLiveToClipsReport,
} from '../highlights/live-to-clips-report.js';

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      source: { type: 'string' },
      labels: { type: 'string' },
      'mode-label': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const id = values.run ?? values.source;
  if (
    Boolean(values.run) === Boolean(values.source) ||
    !values.out ||
    !id ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)
  ) {
    console.error(
      'usage: report:live-to-clips (--run <uuid> | --source <uuid>) [--labels <json>] [--mode-label <text>] --out <md path>',
    );
    process.exitCode = 2;
    return;
  }
  let labels: ReportLabels | undefined;
  if (values.labels) {
    const raw: unknown = JSON.parse(await readFile(values.labels, 'utf8'));
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('labelled_by' in raw) ||
      typeof raw.labelled_by !== 'string' ||
      !('highlights' in raw) ||
      !Array.isArray(raw.highlights)
    )
      throw new Error('Invalid labels');
    for (const label of raw.highlights) {
      if (
        !label ||
        typeof label !== 'object' ||
        !Number.isFinite(label.startS) ||
        !Number.isFinite(label.endS) ||
        label.startS < 0 ||
        label.endS <= label.startS ||
        ![1, 2].includes(label.grade)
      )
        throw new Error('Invalid label span or grade');
    }
    labels = raw as ReportLabels;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set; supply it in the process environment. No .env file is loaded.');
    process.exitCode = 2;
    return;
  }
  const ds = createDataSource(url);
  try {
    await ds.initialize();
    const markdown = await ds.transaction('REPEATABLE READ', async (em) => {
      await em.query('SET TRANSACTION READ ONLY');
      // Bootstrap the tenant from the explicitly selected UUID. The join enforces source ownership;
      // every subsequent lookup is scoped to this merchant and this run/source.
      const query = em
        .getRepository(WorkflowRunEntity)
        .createQueryBuilder('run')
        .innerJoin(
          VideoSourceEntity,
          'source',
          'source.id = run.subject_id AND source.merchant_id = run.merchant_id',
        )
        .where('run.kind = :kind AND run.subject_type = :subjectType', {
          kind: 'live_to_clips',
          subjectType: 'source',
        });
      if (values.run) query.andWhere('run.id = :id', { id });
      else query.andWhere('source.id = :id', { id });
      const run = await query.orderBy('run.created_at', 'DESC').addOrderBy('run.id', 'DESC').getOne();
      if (!run?.subjectId) throw new Error('Run not found');
      const source = await em
        .getRepository(VideoSourceEntity)
        .findOneByOrFail({ id: run.subjectId, merchantId: run.merchantId });
      const durationMs = source.probe?.durationMs;
      if (typeof durationMs !== 'number') throw new Error('Source duration is not recorded');
      if (labels?.sha256 && labels.sha256 !== source.sha256)
        throw new Error('Labels checksum does not match source');
      const jobs = await em
        .getRepository(JobEntity)
        .find({ where: { workflowRunId: run.id, merchantId: run.merchantId } });
      const attempts = await em
        .getRepository(JobAttemptEntity)
        .createQueryBuilder('attempt')
        .innerJoin(JobEntity, 'job', 'job.id = attempt.job_id AND job.merchant_id = attempt.merchant_id')
        .where('job.workflow_run_id = :runId AND attempt.merchant_id = :merchantId', {
          runId: run.id,
          merchantId: run.merchantId,
        })
        .orderBy('attempt.started_at', 'ASC')
        .addOrderBy('attempt.id', 'ASC')
        .getMany();
      const names = new Map(jobs.map((j) => [j.id, j.type]));
      const calls = await em.getRepository(LlmCallEntity).find({
        where: { workflowRunId: run.id, merchantId: run.merchantId },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      const clips = await em.getRepository(ClipSuggestionEntity).find({
        where: { workflowRunId: run.id, merchantId: run.merchantId, sourceId: source.id },
        order: { rank: 'ASC' },
      });
      const report = computeLiveToClipsReport({
        durationMs,
        attempts: attempts.map((a) => {
          const jobName = names.get(a.jobId);
          if (!jobName) throw new Error('Attempt job not found');
          return { ...a, jobName };
        }),
        calls,
        clips,
        labels,
      });
      return renderLiveToClipsReport(report, {
        runId: run.id,
        sourceId: source.id,
        status: run.status,
        runError: run.error,
        modeLabel: values['mode-label'],
        labels,
      });
    });
    await mkdir(dirname(values.out), { recursive: true });
    // Also redact the exact connection string if a stored failure happened to include it.
    await writeFile(values.out, markdown.replaceAll(url, '[DATABASE_URL redacted]'), 'utf8');
    console.log(
      'Report written. Metrics are from a read-only database snapshot; cost is an estimate (list price).',
    );
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

// Driver errors can contain credentials/connection details. Do not print arbitrary exception text.
await main().catch(() => {
  console.error(
    'Report failed: check arguments, labels/checksum, database access, run/source and recorded duration. Connection details are suppressed.',
  );
  process.exitCode = 1;
});
