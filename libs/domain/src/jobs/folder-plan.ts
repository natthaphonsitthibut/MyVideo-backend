/**
 * The plan panel of a project folder (E12-F05): an ordered list of steps with a state, derived ONLY from the real
 * state of the footage and of the runs the folder edit started — never a timer or a guess. Pure, so the API, the
 * orchestrator and tests all read the same answer.
 */

export type RunState = 'none' | 'running' | 'succeeded' | 'failed';

export type FolderSourceFacts = {
  id: string;
  /** Upload/ingest state of the source. */
  ingest: 'processing' | 'ready' | 'failed';
  kind: 'video' | 'photo';
  hasAudio: boolean;
  /** Newest transcript of the source. */
  transcript: 'none' | 'running' | 'ready' | 'failed';
  /** Newest highlight analysis (live_to_clips run) and the edit built from it (build_clips run). */
  analysis: RunState;
  build: RunState;
};

export type FolderFacts = {
  /** The merchant pressed "start" (a folder_edit run exists). */
  started: boolean;
  /** The chosen (or locked) style; null while the merchant has not picked one. */
  styleId: string | null;
  sources: FolderSourceFacts[];
  /** A visual montage for selected pictures/silent footage, when needed. */
  visualBuild?: RunState;
};

export const PLAN_STEP_IDS = ['prepare', 'transcribe', 'analyse', 'style', 'edit'] as const;
export type PlanStepId = (typeof PLAN_STEP_IDS)[number];
export type PlanStepState = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
export type PlanStep = {
  id: PlanStepId;
  label: string;
  state: PlanStepState;
  detail: string | null;
  /** Plain Thai reason when failed. */
  error: string | null;
};
export type FolderPlan = {
  steps: PlanStep[];
  done: number;
  total: number;
  finished: boolean;
  failed: boolean;
  /** What the merchant must do for the plan to continue. */
  needs: 'style' | null;
};

const LABELS: Record<PlanStepId, string> = {
  prepare: 'ดูฟุตเทจ',
  transcribe: 'ถอดเสียงทุกคำ',
  analyse: 'หาช่วงที่ดีที่สุด + เสนอสไตล์',
  style: 'เลือกสไตล์',
  edit: 'ตัดเทคที่ดีที่สุด + ซับ + กราฟิก + เสียง',
};

type Agg = { state: PlanStepState; detail: string | null; error: string | null };

/** All-of aggregation over the items one step works on. */
function aggregate(
  items: { s: 'none' | 'running' | 'done' | 'failed' }[],
  noun: string,
  failTh: string,
): Agg {
  const n = items.length;
  const done = items.filter((i) => i.s === 'done').length;
  const failed = items.filter((i) => i.s === 'failed').length;
  const detail = `เสร็จ ${done}/${n} ${noun}`;
  if (failed) return { state: 'failed', detail, error: `${failTh} ${failed} ${noun}` };
  if (done === n) return { state: 'done', detail, error: null };
  if (items.some((i) => i.s !== 'none')) return { state: 'running', detail, error: null };
  return { state: 'pending', detail, error: null };
}

const run = (r: RunState): 'done' | 'failed' | 'running' | 'none' =>
  r === 'succeeded' ? 'done' : r === 'failed' ? 'failed' : r === 'running' ? 'running' : 'none';

export function folderPlan(f: FolderFacts): FolderPlan {
  const speech = f.sources.filter((s) => s.kind === 'video' && s.hasAudio);
  const out: Record<PlanStepId, Agg> = {
    prepare: { state: 'pending', detail: null, error: null },
    transcribe: { state: 'pending', detail: null, error: null },
    analyse: { state: 'pending', detail: null, error: null },
    style: { state: 'pending', detail: null, error: null },
    edit: { state: 'pending', detail: null, error: null },
  };

  // 1. footage
  const failedIngest = f.sources.filter((s) => s.ingest === 'failed').length;
  out.prepare = {
    state: !f.sources.length
      ? 'pending'
      : failedIngest
        ? 'failed'
        : f.sources.every((s) => s.ingest === 'ready')
          ? 'done'
          : 'running',
    detail: f.sources.length ? `${f.sources.length} ไฟล์` : 'ยังไม่มีฟุตเทจ',
    error: failedIngest ? `ฟุตเทจเสีย ${failedIngest} ไฟล์ — ลบออกหรืออัปโหลดใหม่` : null,
  };

  if (f.started) {
    // 2–3. speech steps (only footage with sound)
    if (speech.length) {
      out.transcribe = aggregate(
        speech.map((s) => ({
          s:
            s.transcript === 'ready'
              ? 'done'
              : s.transcript === 'failed'
                ? 'failed'
                : s.transcript === 'running'
                  ? 'running'
                  : 'none',
        })),
        'วิดีโอ',
        'ถอดเสียงไม่สำเร็จ',
      );
      out.analyse = aggregate(
        speech.map((s) => ({ s: run(s.analysis) })),
        'วิดีโอ',
        'วิเคราะห์ไม่สำเร็จ',
      );
    } else {
      out.transcribe = { state: 'skipped', detail: 'ไม่มีวิดีโอที่มีเสียงพูด', error: null };
      out.analyse = { state: 'skipped', detail: null, error: null };
    }
    // 4. style: the merchant picks once the analysis is in (or at once when there is no speech)
    const analysed = out.analyse.state === 'done' || out.analyse.state === 'skipped';
    if (f.styleId) out.style = { state: 'done', detail: f.styleId, error: null };
    else if (analysed && out.prepare.state === 'done')
      out.style = { state: 'waiting', detail: 'รอคุณเลือก', error: null };
    // 5. edit
    if (f.styleId && (speech.length || f.visualBuild !== undefined))
      out.edit = aggregate(
        [
          ...speech.map((s) => ({ s: run(s.build) })),
          ...(f.visualBuild !== undefined ? [{ s: run(f.visualBuild) }] : []),
        ],
        'วิดีโอ',
        'ตัดต่อไม่สำเร็จ',
      );
  }

  // a failure stops the line: nothing after it is shown as running/done
  let stopped = false;
  const steps: PlanStep[] = PLAN_STEP_IDS.map((id) => {
    const a = out[id];
    const state = stopped && a.state !== 'skipped' ? 'pending' : a.state;
    if (a.state === 'failed') stopped = true;
    return { id, label: LABELS[id], state, detail: a.detail, error: state === 'failed' ? a.error : null };
  });
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  return {
    steps,
    done,
    total: steps.length,
    finished: steps.every((s) => s.state === 'done' || s.state === 'skipped'),
    failed: steps.some((s) => s.state === 'failed'),
    needs: steps.some((s) => s.id === 'style' && s.state === 'waiting') ? 'style' : null,
  };
}
