/**
 * Highlight evaluation on a real recording (E07-F01, extended by F03/F09): ranks windows of a stored transcript
 * and reports precision@k against a label file (`footage/labels/highlights/*.json`).
 *
 * usage: node libs/infra/dist/cli/eval-highlights.js --transcript <transcript-vN.json> --peaks <peaks-v1.json>
 *          --labels <labels.json> [--k 5] [--products "name,name"]
 * Reads local files only; no network.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_HIGHLIGHT_OPTIONS,
  type HighlightCandidate,
  type HighlightLabel,
  pickTopCandidates,
  precisionAtK,
  scoreWindows,
  type TimedSegment,
} from '@myvideo/domain';
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
  },
});
if (!values.transcript || !values.labels) {
  console.error('usage: eval-highlights --transcript <json> [--peaks <json>] --labels <json> [--k 5]');
  process.exit(2);
}

const transcript = JSON.parse(readFileSync(values.transcript, 'utf8')) as { segments: TimedSegment[] };
const peaks = values.peaks ? (JSON.parse(readFileSync(values.peaks, 'utf8')) as PeaksJson) : undefined;
const labels = JSON.parse(readFileSync(values.labels, 'utf8')) as LabelFile;
const k = Number(values.k);
const productTerms = values.products ? values.products.split(',').map((s) => s.trim()) : [];

const t0 = performance.now();
const windows = scoreWindows(
  { segments: transcript.segments, loudness: peaks ? loudnessFromPeaks(peaks) : undefined },
  { productTerms, weights: { ...DEFAULT_HIGHLIGHT_OPTIONS.weights, ...JSON.parse(values.weights ?? '{}') } },
);
const scoreMs = performance.now() - t0;

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const labelOf = (c: HighlightCandidate) =>
  labels.highlights.find((l) => {
    const overlap = Math.min(c.endMs, l.endS * 1000) - Math.max(c.startMs, l.startS * 1000);
    return overlap / (c.endMs - c.startMs) >= 0.5;
  });

const splits: [string, number, number][] = [['all', 0, Number.POSITIVE_INFINITY]];
if (labels.split) {
  splits.push(['tune', labels.split.tune[0] * 1000, labels.split.tune[1] * 1000]);
  splits.push(['eval', labels.split.eval[0] * 1000, labels.split.eval[1] * 1000]);
}

console.log(`# Highlight eval — rules mode`);
console.log(
  `labels: ${labels.labelled_by} (${labels.highlights.length} highlights) · windows: ${windows.length}`,
);
console.log(`scoring time: ${scoreMs.toFixed(0)} ms · network calls: 0 (pure function)\n`);
console.log(`| split | P@${k} grade≥1 | P@${k} grade 2 | P@10 grade≥1 | P@10 grade 2 |`);
console.log('|---|---|---|---|---|');
const picksBySplit = new Map<string, HighlightCandidate[]>();
for (const [name, a, b] of splits) {
  const inSplit = windows.filter((w) => w.startMs >= a && w.endMs <= b);
  const picks = pickTopCandidates(inSplit, Math.max(k, 10));
  picksBySplit.set(name, picks);
  const p1 = precisionAtK(picks, labels.highlights, k, 1);
  const p2 = precisionAtK(picks, labels.highlights, k, 2);
  const p10a = precisionAtK(picks, labels.highlights, 10, 1);
  const p10b = precisionAtK(picks, labels.highlights, 10, 2);
  const f = (p: { hits: number; k: number; precision: number }) =>
    `${p.hits}/${p.k} = ${p.precision.toFixed(2)}`;
  console.log(`| ${name} | ${f(p1)} | ${f(p2)} | ${f(p10a)} | ${f(p10b)} |`);
}
for (const [name, picks] of picksBySplit) {
  console.log(`\n## top 10 — ${name}`);
  console.log('| # | span | score | label | reason |');
  console.log('|---|---|---|---|---|');
  picks.forEach((c, i) => {
    const l = labelOf(c);
    const hit = l ? `${l.id} (g${l.grade})` : '—';
    console.log(
      `| ${i + 1} | ${mmss(c.startMs)}–${mmss(c.endMs)} | ${c.score.toFixed(1)} | ${hit} | ${c.reason.slice(0, 160)} |`,
    );
  });
}
