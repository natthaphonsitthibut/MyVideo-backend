import { expect, it } from 'vitest';
import { spokenCta } from './clip-project.js';
import { planJumpCuts, wordCutViolations } from './jump-cuts.js';
import { sentenceEndWord } from './live-to-clips.js';

// word times recorded on the 30-min live (ASR starts "Energy" 0.5 s before VAD hears speech)
const words = [
  { text: 'เลย', startMs: 1016265, endMs: 1016385 },
  { text: 'นะ', startMs: 1016385, endMs: 1016445 },
  { text: 'ครับ', startMs: 1016445, endMs: 1016525 },
  { text: 'Energy', startMs: 1016665, endMs: 1017105 },
  { text: 'แบบนี้', startMs: 1017105, endMs: 1017805 },
];

it('a clip edge or pause cut inside a kept word grows to the word edge instead of splitting it', () => {
  const plan = planJumpCuts(
    { startMs: 1016300, endMs: 1017805 },
    words,
    [
      { startMs: 1016200, endMs: 1016500 },
      { startMs: 1017175, endMs: 1017805 },
    ],
    { maxPauseMs: 300, keepPauseMs: 200, removeFillers: true },
  );
  expect(wordCutViolations(plan.segments, plan.words)).toEqual([]);
  expect(plan.segments[0]?.startMs).toBe(1016265);
});

it('the call-to-action follows how the seller takes orders, and is left out when they never say', () => {
  const cart = 'กดตะกร้าเลย!';
  const said = (t: string) => t.split(' ').map((text) => ({ text }));
  // real L02 wording: pre-order through the back-office inbox
  expect(spokenCta(said('ผม จะ ให้ ทุกคน ที่ จอง อินบ็อกซ์หลังบ้าน'), cart)).toBe('จองเลย ทักอินบ็อกซ์');
  expect(spokenCta(said('เปิด จอง เท่านั้น'), cart)).toBe('จองได้เลย');
  expect(spokenCta(said('สนใจ ทักแชท มา'), cart)).toBe('ทักแชทได้เลย');
  expect(spokenCta(said('กด ตะกร้า เลย'), cart)).toBe(cart);
  expect(spokenCta(said('ผ้า นุ่ม มาก'), cart)).toBeNull();
});

it('a clip finishes the spoken line it stops in, when the line ends soon after', () => {
  const flat = [
    { segment: 0, endMs: 1000 },
    { segment: 1, endMs: 2000 }, // "ได้ภายใน" — the chosen end
    { segment: 1, endMs: 2600 }, // "15"
    { segment: 1, endMs: 3000 }, // "วัน"
    { segment: 2, endMs: 4000 },
  ];
  expect(sentenceEndWord(flat, 1, 2000)).toBe(3);
  // a line still going on long after the chosen end is not followed
  expect(sentenceEndWord([...flat.slice(0, 3), { segment: 1, endMs: 9000 }], 1, 2000)).toBe(1);
});
