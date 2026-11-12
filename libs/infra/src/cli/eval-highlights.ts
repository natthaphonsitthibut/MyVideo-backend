/**
 * Highlight evaluation on a real recording (E07-F01/F03, extended by F09): ranks windows of a stored transcript
 * and reports precision@k against a label file (`footage/labels/highlights/*.json`).
 *
 * usage: node libs/infra/dist/cli/eval-highlights.js --transcript <transcript-vN.json> --peaks <peaks-v1.json>
 *          --labels <labels.json> [--k 5] [--products "a,b"] [--weights '{"price":2}']
 *          [--mode rules|local-agent] [--pool 12] [--model claude-sonnet-5-5] [--effort medium]
 * rules mode reads local files only (no network). local-agent mode re-ranks the top `--pool` rule windows of each
 * split with the local CLI (one model call per batch of 6, LLM_MODE=local-agent semantics, development only).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_HIGHLIGHT_OPTIONS,
  type HighlightLabel,
  pickTopCandidates,
  precisionAtK,
  scoreWindows,
  type TimedSegment,
} from '@myvideo/domain';
import {
  flattenWords,
  limitByInputShare,
  MAX_LLM_INPUT_SHARE,
  type RankedClip,
  rerankCandidates,
} from '../highlights/rerank.js';
import { ClaudeCliAdapter } from '../llm/local-agent-claude.js';
import { MemoryLlmCallStore, StructuredLlm } from '../llm/structured-llm.js';
import { loudnessFromPeaks, type PeaksJson } from '../media/peaks.js';

type LabelFile = {
  labelled_by: string;
  split?: { tune: [number, number]; eval: [number, number] };
  highlights: (HighlightLabel & { id: string; type: string; note: string })[];
};

const { values } = parseArgs({
  options: {
    transcript: { type: 'string' },
    peaks: { type: 'string' },
    labels: { type: 'string' },
    k: { type: 'string', default: '5' },
    products: { type: 'string', default: '' },
    /** JSON object merged over the default weights, e.g. '{"price":2}' */
    weights: { type: 'string', default: '{}' },
    mode: { type: 'string', default: 'rules' },
    pool: { type: 'string', default: '12' },
    model: { type: 'string', default: 'claude-sonnet-5-5' },
    effort: { type: 'string', default: 'medium' },
  },
});
if (!values.transcript || !values.labels) {
  console.error(
    'usage: eval-highlights --transcript <json> [--peaks <json>] --labels <json> [--k 5] [--mode rules]',
  );
  process.exit(2);
}

const transcript = JSON.parse(readFileSync(values.transcript, 'utf8')) as { segments: TimedSegment[] };
const peaks = values.peaks ? (JSON.parse(readFileSync(values.peaks, 'utf8')) as PeaksJson) : undefined;
const labels = JSON.parse(readFileSync(values.labels, 'utf8')) as LabelFile;
const k = Number(values.k);
const pool = Number(values.pool);
const productTerms = values.products ? values.products.split(',').map((s) => s.trim()) : [];
const segments = transcript.segments;

const t0 = performance.now();
const windows = scoreWindows(
  { segments, loudness: peaks ? loudnessFromPeaks(peaks) : undefined },
  { productTerms, weights: { ...DEFAULT_HIGHLIGHT_OPTIONS.weights, ...JSON.parse(values.weights ?? '{}') } },
);
const scoreMs = performance.now() - t0;

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
type Span = { startMs: number; endMs: number };
const labelOf = (c: Span) =>
  labels.highlights.find((l) => {
    const overlap = Math.min(c.endMs, l.endS * 1000) - Math.max(c.startMs, l.startS * 1000);
    return overlap / (c.endMs - c.startMs) >= 0.5;
  });
const f = (p: { hits: number; k: number; precision: number }) =>
  `${p.hits}/${p.k} = ${p.precision.toFixed(2)}`;
const row = (name: string, picks: Span[]) =>
  `| ${name} | ${f(precisionAtK(picks, labels.highlights, k, 1))} | ${f(precisionAtK(picks, labels.highlights, k, 2))} | ${f(precisionAtK(picks, labels.highlights, 10, 1))} | ${f(precisionAtK(picks, labels.highlights, 10, 2))} |`;

const splits: [string, number, number][] = [['all', 0, Number.POSITIVE_INFINITY]];
if (labels.split) {
  splits.push(['tune', labels.split.tune[0] * 1000, labels.split.tune[1] * 1000]);
  splits.push(['eval', labels.split.eval[0] * 1000, labels.split.eval[1] * 1000]);
}

console.log(`# Highlight eval — mode ${values.mode}`);
console.log(
  `labels: ${labels.labelled_by} (${labels.highlights.length} highlights) · windows: ${windows.length}`,
);
console.log(`rule scoring time: ${scoreMs.toFixed(0)} ms (no network)\n`);
console.log(`| split | P@${k} grade≥1 | P@${k} grade 2 | P@10 grade≥1 | P@10 grade 2 |`);
console.log('|---|---|---|---|---|');

const rulePicks = new Map<string, ReturnType<typeof pickTopCandidates>>();
for (const [name, a, b] of splits) {
  const picks = pickTopCandidates(
    windows.filter((w) => w.startMs >= a && w.endMs <= b),
    Math.max(k, 10, pool),
  );
  rulePicks.set(name, picks);
  console.log(row(`rules · ${name}`, picks));
}

const llmPicks = new Map<string, RankedClip[]>();
if (values.mode === 'local-agent') {
  const effort = values.effort as 'low' | 'medium' | 'high';
  const llm = new StructuredLlm(
    new ClaudeCliAdapter({ models: { fast: values.model, smart: values.model }, effort }),
    new MemoryLlmCallStore(),
    { maxCallsPerRun: 50 },
  );
  let inputChars = 0;
  let transcriptChars = 0;
  let calls = 0;
  let outTokens = 0;
  let cost = 0;
  let wallMs = 0;
  const words = flattenWords(segments);
  for (const [name, a, b] of splits.filter(([n]) => n !== 'all')) {
    const t = performance.now();
    const fromWord = words.findIndex((w) => w.startMs >= a);
    const after = words.findIndex((w) => w.endMs > b);
    const range = { fromWord, toWord: after === -1 ? words.length - 1 : after - 1 };
    const sent = limitByInputShare(
      (rulePicks.get(name) ?? []).slice(0, pool),
      words,
      MAX_LLM_INPUT_SHARE,
      range,
    );
    const r = await rerankCandidates(llm, segments, sent, { merchantId: 'eval' });
    wallMs += performance.now() - t;
    inputChars += r.inputChars;
    transcriptChars = r.transcriptChars;
    calls += r.calls;
    outTokens += r.usage.outputTokens;
    cost += r.usage.costUsdEstimate ?? 0;
    const kept = r.clips.filter((c) => c.keep);
    llmPicks.set(name, r.clips);
    console.log(row(`${values.model} · ${name} (kept ${kept.length}/${r.clips.length})`, kept));
  }
  console.log(
    `\nLLM input: ${inputChars} of ${transcriptChars} transcript characters = ${((100 * inputChars) / transcriptChars).toFixed(1)} % · calls ${calls} · output tokens ${outTokens} · est. list cost $${cost.toFixed(4)} · wall ${(wallMs / 1000).toFixed(1)} s`,
  );
}

for (const [name, picks] of rulePicks) {
  console.log(`\n## rules top 10 — ${name}`);
  console.log('| # | span | score | label | reason |');
  console.log('|---|---|---|---|---|');
  picks.slice(0, 10).forEach((c, i) => {
    const l = labelOf(c);
    console.log(
      `| ${i + 1} | ${mmss(c.startMs)}–${mmss(c.endMs)} | ${c.score.toFixed(1)} | ${l ? `${l.id} (g${l.grade})` : '—'} | ${c.reason.slice(0, 140)} |`,
    );
  });
}
for (const [name, clips] of llmPicks) {
  console.log(`\n## ${values.model} ranking — ${name}`);
  console.log('| # | keep | span | score | type | label | reason · quote |');
  console.log('|---|---|---|---|---|---|---|');
  clips.forEach((c, i) => {
    const l = labelOf(c);
    console.log(
      `| ${i + 1} | ${c.keep ? 'yes' : 'no'} | ${mmss(c.startMs)}–${mmss(c.endMs)} | ${c.score} | ${c.type} | ${l ? `${l.id} (g${l.grade})` : '—'} | ${c.reason} · “${c.quote}” |`,
    );
  });
}
