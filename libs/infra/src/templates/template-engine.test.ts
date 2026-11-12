import { templateVersion } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import { planTemplate, type TemplateShot } from './template-engine.js';

/**
 * Shot boundaries are real: C05 (= S05 0–30 s, GPU unboxing, cut times from labels L03, agent-counted) and C03 (one
 * continuous talking-head shot, 54.5 s). Roles here are the INPUT of the engine (what classification would say).
 */
const C05 = '00000000-0000-4000-8000-0000000000c5';
const C03 = '00000000-0000-4000-8000-0000000000c3';
const gpu: [number, number, TemplateShot['role']][] = [
  [0, 4_750, 'broll'],
  [4_750, 10_250, 'unboxing'],
  [10_250, 12_250, 'product_closeup'],
  [12_250, 13_250, 'product_closeup'],
  [13_250, 14_250, 'product_closeup'],
  [14_250, 16_750, 'product_closeup'],
  [16_750, 20_250, 'demo'],
  [20_250, 23_250, 'product_closeup'],
  [23_250, 27_750, 'demo'],
  [27_750, 30_000, 'broll'],
];
const shots = (withTalk: boolean): TemplateShot[] => [
  ...gpu.map(([startMs, endMs, role], i) => ({
    sourceId: C05,
    index: i,
    startMs,
    endMs,
    role,
    confidence: 0.8,
    words: [],
  })),
  ...(withTalk
    ? [
        {
          sourceId: C03,
          index: 0,
          startMs: 0,
          endMs: 54_500,
          role: 'talking_head' as const,
          confidence: 0.9,
          // real-like word timing: a sentence ends at 6.4 s, the next starts at 6.9 s
          words: [
            { text: 'สวัสดี', startMs: 400, endMs: 1_100 },
            { text: 'วันนี้', startMs: 1_100, endMs: 1_700 },
            { text: 'มารีวิว', startMs: 1_700, endMs: 2_600 },
            { text: 'การ์ดจอ', startMs: 2_600, endMs: 3_400 },
            { text: 'ตัวใหม่', startMs: 3_400, endMs: 4_200 },
            { text: 'กันค่ะ', startMs: 4_200, endMs: 6_400 },
            { text: 'ตัวนี้', startMs: 6_900, endMs: 7_600 },
            { text: 'เงียบมาก', startMs: 7_600, endMs: 9_000 },
          ],
        },
      ]
    : []),
];
const product = { name: 'การ์ดจอ ProArt', points: ['เงียบ ไม่ร้อน', 'ต่อจอได้ 4 จอ'] };

describe('template engine', () => {
  it('review: fills slots in order with the best shot of an accepted role, never reusing a shot', () => {
    const t = templateVersion('review', 1);
    if (!t) throw new Error('no template');
    const r = planTemplate(t, shots(true), product);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    expect(r.pieces.map((p) => [p.slot, p.role])).toEqual([
      [0, 'talking_head'],
      [1, 'product_closeup'],
      [2, 'demo'],
      [4, 'product_closeup'],
    ]);
    // the talking head ends at a word end inside the slot's 8 s: "กันค่ะ" ends at 6.4 s (+ 300 ms tail)
    expect(r.pieces[0]).toMatchObject({ sourceId: C03, inMs: 400, outMs: 6_700 });
    // no shot used twice
    const keys = r.pieces.map((p) => `${p.sourceId}:${p.shotIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    // every piece inside its shot and within the slot limits
    for (const p of r.pieces) {
      const slot = t.slots[p.slot];
      expect(p.outMs - p.inMs).toBeLessThanOrEqual(slot?.maxMs ?? 0);
      expect(p.outMs - p.inMs).toBeGreaterThanOrEqual(slot?.minMs ?? 0);
    }
    // texts: product name on the first slot, then the merchant's points in order, nothing invented
    expect(r.pieces.map((p) => p.text)).toEqual([
      { kind: 'title', value: 'การ์ดจอ ProArt' },
      { kind: 'point', value: 'เงียบ ไม่ร้อน' },
      { kind: 'point', value: 'ต่อจอได้ 4 จอ' },
      null,
    ]);
    expect(r.durationMs).toBe(r.pieces.reduce((n, p) => n + p.outMs - p.inMs, 0));
  });

  it('review without a talking head reports exactly what to shoot (no faked role)', () => {
    const t = templateVersion('review', 1);
    if (!t) throw new Error('no template');
    const r = planTemplate(t, shots(false), product);
    expect(r).toEqual({
      ok: false,
      missing: [{ slot: 0, roles: ['talking_head'], hint: expect.stringContaining('พูด') }],
    });
  });

  it('showcase works on silent product footage alone; unboxing uses the unboxing shot first', () => {
    const show = templateVersion('showcase', 1);
    const unbox = templateVersion('unboxing', 1);
    if (!show || !unbox) throw new Error('no template');
    const a = planTemplate(show, shots(false), { name: 'การ์ดจอ', points: [] });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.pieces.every((p) => p.text?.kind !== 'point')).toBe(true); // no points typed → none shown
    const b = planTemplate(unbox, shots(false), product);
    expect(b.ok && b.pieces[0]).toMatchObject({ role: 'unboxing', sourceId: C05, shotIndex: 1 });
  });

  it('too little footage for the template length is reported, not padded', () => {
    const show = templateVersion('showcase', 1);
    if (!show) throw new Error('no template');
    const two: TemplateShot[] = shots(false).filter((s) => s.index === 2 || s.index === 6);
    const r = planTemplate(show, two, product);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.some((m) => m.slot === -1)).toBe(true);
  });
});
