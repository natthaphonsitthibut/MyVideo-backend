/**
 * Hook/title review sheet (E07-F06): for the top-N rule windows of a stored transcript, prints rules-mode and
 * local-agent suggestions with their source quotes, for a person to read and judge.
 *
 * usage: node libs/infra/dist/cli/review-hooks.js --transcript <transcript-vN.json> [--n 10] [--product "name"]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { findHighlights, type TimedSegment } from '@myvideo/domain';
import { clipTranscript, suggestHooks, suggestHooksRules } from '../highlights/hooks.js';
import { ClaudeCliAdapter } from '../llm/local-agent-claude.js';
import { MemoryLlmCallStore, StructuredLlm } from '../llm/structured-llm.js';

const { values } = parseArgs({
  options: {
    transcript: { type: 'string' },
    n: { type: 'string', default: '10' },
    product: { type: 'string', default: '' },
  },
});
if (!values.transcript) {
  console.error('usage: review-hooks --transcript <json> [--n 10] [--product name]');
  process.exit(2);
}
const segments = (JSON.parse(readFileSync(values.transcript, 'utf8')) as { segments: TimedSegment[] })
  .segments;
const product = values.product ? { name: values.product } : {};
const store = new MemoryLlmCallStore();
const llm = new StructuredLlm(new ClaudeCliAdapter(), store, { maxCallsPerRun: 50 });
const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const picks = findHighlights({ segments }, { topN: Number(values.n) }).sort((a, b) => a.startMs - b.startMs);
let failures = 0;
const t0 = performance.now();
for (const [i, c] of picks.entries()) {
  const clip = { segments, firstSegment: c.firstSegment, lastSegment: c.lastSegment };
  console.log(`\n### Clip ${i + 1} — ${mmss(c.startMs)}–${mmss(c.endMs)}\n`);
  console.log(`Transcript:\n\n> ${clipTranscript(clip).split('\n').join(' / ')}\n`);
  console.log('| mode | kind | text | sources |');
  console.log('|---|---|---|---|');
  for (const s of suggestHooksRules(clip, product)) {
    console.log(`| rules | ${s.kind} | ${s.text} | ${s.sources.join(' · ')} |`);
  }
  try {
    for (const s of await suggestHooks(llm, clip, product, { merchantId: 'review' })) {
      console.log(`| ai | ${s.kind} | ${s.text} | ${s.sources.join(' · ')} |`);
    }
  } catch (err) {
    failures++;
    console.log(`| ai | error | ${(err as Error).message.slice(0, 200)} | |`);
  }
}
const rows = store.rows;
console.log(
  `\nLLM calls ${rows.length} (invalid answers repaired: ${rows.filter((r) => r.status === 'invalid').length}), failures ${failures}, output tokens ${rows.reduce((n, r) => n + r.usage.outputTokens, 0)}, est. list cost $${rows.reduce((n, r) => n + (r.usage.costUsdEstimate ?? 0), 0).toFixed(4)}, wall ${((performance.now() - t0) / 1000).toFixed(1)} s`,
);
