import { describe, expect, it } from 'vitest';
import { findRestarts, isFiller, isKeyMoment, planJumpCuts, splitLongShots } from './jump-cuts.js';

const cuts = { maxPauseMs: 300, keepPauseMs: 100, removeFillers: true };
const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe('planJumpCuts', () => {
  it('keeps the whole clip when there is no long pause and no filler', () => {
    const words = [w('ตัว', 0, 400), w('นี้', 400, 900), w('80', 900, 1300), w('บาท', 1300, 1800)];
    const r = planJumpCuts({ startMs: 0, endMs: 1800 }, words, [{ startMs: 0, endMs: 1800 }], cuts);
    expect(r.segments).toEqual([{ startMs: 0, endMs: 1800 }]);
    expect(r.words.map((x) => x.text)).toEqual(['ตัว', 'นี้', '80', 'บาท']);
  });

  it('shrinks a long silence between speech spans to keepPauseMs', () => {
    const words = [w('รับ', 0, 500), w('พิมพ์', 500, 2000), w('กลับ', 2000, 2400), w('มา', 2400, 3000)];
    // VAD: speech 0–1000 ms, silence 1000–2000 ms, speech 2000–3000 ms
    const speech = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ];
    const r = planJumpCuts({ startMs: 0, endMs: 3000 }, words, speech, cuts);
    expect(r.segments).toEqual([
      { startMs: 0, endMs: 1050 },
      { startMs: 1950, endMs: 3000 },
    ]);
    expect(r.durationMs).toBe(2100);
    // a word that straddles the cut keeps its start; times map onto the output timeline
    expect(r.toOutputMs(2000)).toBe(1100);
    expect(r.toOutputMs(500)).toBe(500);
  });

  it('keeps a pause shorter than maxPauseMs', () => {
    const speech = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1250, endMs: 2000 },
    ];
    const r = planJumpCuts({ startMs: 0, endMs: 2000 }, [w('ก', 0, 1250), w('ข', 1250, 2000)], speech, cuts);
    expect(r.segments).toEqual([{ startMs: 0, endMs: 2000 }]);
  });

  it('removes filler words with their audio and drops them from the captions', () => {
    const words = [w('ตัว', 0, 400), w('เอ่อ', 400, 1000), w('นี้', 1000, 1400)];
    const r = planJumpCuts({ startMs: 0, endMs: 1400 }, words, [{ startMs: 0, endMs: 1400 }], cuts);
    expect(r.segments).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 1000, endMs: 1400 },
    ]);
    expect(r.words.map((x) => x.text)).toEqual(['ตัว', 'นี้']);
    expect(r.toOutputMs(1000)).toBe(400);
  });

  it('keeps fillers when the style says so', () => {
    const words = [w('ตัว', 0, 400), w('เอ่อ', 400, 1000), w('นี้', 1000, 1400)];
    const r = planJumpCuts({ startMs: 0, endMs: 1400 }, words, [{ startMs: 0, endMs: 1400 }], {
      ...cuts,
      removeFillers: false,
    });
    expect(r.segments).toEqual([{ startMs: 0, endMs: 1400 }]);
    expect(r.words).toHaveLength(3);
  });

  it('does not make a cut for a removal shorter than 120 ms', () => {
    const speech = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1400, endMs: 2000 },
    ];
    // 400 ms silence, maxPause 300, keep 300 → only 100 ms would go: not worth a visible jump
    const r = planJumpCuts({ startMs: 0, endMs: 2000 }, [w('ก', 0, 1400), w('ข', 1400, 2000)], speech, {
      ...cuts,
      keepPauseMs: 300,
    });
    expect(r.segments).toEqual([{ startMs: 0, endMs: 2000 }]);
  });

  it('without speech spans only fillers are cut (word times alone do not show pauses)', () => {
    const words = [w('ตัว', 0, 400), w('อ่า', 400, 900), w('นี้', 900, 3000)];
    const r = planJumpCuts({ startMs: 0, endMs: 3000 }, words, [], cuts);
    expect(r.segments).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 900, endMs: 3000 },
    ]);
  });

  it('a clip that is all filler keeps the original range instead of an empty clip', () => {
    const r = planJumpCuts(
      { startMs: 0, endMs: 600 },
      [w('เอ่อ', 0, 600)],
      [{ startMs: 0, endMs: 600 }],
      cuts,
    );
    expect(r.segments).toEqual([{ startMs: 0, endMs: 600 }]);
  });
});

describe('splitLongShots', () => {
  const words = Array.from({ length: 20 }, (_, i) => w(`ค${i}`, i * 500, i * 500 + 500));

  it('splits a 10-s shot at word starts so no shot is longer than maxShotMs', () => {
    const shots = splitLongShots([{ startMs: 0, endMs: 10_000 }], words, 3000);
    expect(shots.every((s) => s.endMs - s.startMs <= 3000)).toBe(true);
    // contiguous: no time removed
    expect(shots[0]?.startMs).toBe(0);
    expect(shots[shots.length - 1]?.endMs).toBe(10_000);
    for (let i = 1; i < shots.length; i++) expect(shots[i]?.startMs).toBe(shots[i - 1]?.endMs);
    // every split is a word start
    const starts = new Set(words.map((x) => x.startMs));
    expect(shots.slice(1).every((s) => starts.has(s.startMs))).toBe(true);
    // even pieces: 10 s / 4 = 2.5 s
    expect(shots).toHaveLength(4);
  });

  it('leaves short shots and a null limit alone', () => {
    expect(splitLongShots([{ startMs: 0, endMs: 2500 }], words, 3000)).toEqual([{ startMs: 0, endMs: 2500 }]);
    expect(splitLongShots([{ startMs: 0, endMs: 10_000 }], words, null)).toEqual([
      { startMs: 0, endMs: 10_000 },
    ]);
  });

  it('does not split where no word starts inside the shot', () => {
    const one = [w('ยาววววว', 0, 9000)];
    expect(splitLongShots([{ startMs: 0, endMs: 9000 }], one, 3000)).toEqual([{ startMs: 0, endMs: 9000 }]);
  });
});

describe('word classes', () => {
  it('fillers are hesitation sounds only, not particles', () => {
    expect(['เอ่อ', 'อ่า', 'อืม', 'เอิ่ม', 'อ้า'].every(isFiller)).toBe(true);
    expect(['อ่ะ', 'นะ', 'ค่ะ', 'เออ', 'ครับ'].some(isFiller)).toBe(false);
  });

  it('key moments are prices and calls to action', () => {
    expect(isKeyMoment(['รับ', 'พิมพ์', 'กลับ', 'มา', '80', 'บาท'])).toBe(true);
    expect(isKeyMoment(['ลด', '50%'])).toBe(true);
    expect(isKeyMoment(['กด', 'ตะกร้า', 'เลย'])).toBe(true);
    expect(isKeyMoment(['CF', 'ได้', 'เลย'])).toBe(true);
    expect(isKeyMoment(['ยาว', '29', 'นิ้ว'])).toBe(false);
    expect(isKeyMoment(['สี', 'สวย', 'มาก'])).toBe(false);
  });
});

describe('restarts (the seller says it again)', () => {
  // real S01a caption: "คุณพีแคปแล้วบอกว่าไซส์เสียค่ะไซส์เสียคุณพีแคป" (ASR tokens, 300 ms each)
  const tokens = ['คุณ', 'พี', 'แคป', 'แล้ว', 'บอก', 'ว่า', 'ไซส์', 'เสีย', 'ค่ะ', 'ไซส์', 'เสีย', 'คุณ', 'พี', 'แคป'];
  const words = tokens.map((t, i) => w(t, i * 300, i * 300 + 300));
  const all = [{ startMs: 0, endMs: tokens.length * 300 }];

  it('finds a repeated phrase and the first take to drop', () => {
    expect(findRestarts(words)).toEqual([{ fromWord: 6, toWord: 8 }]); // "ไซส์ เสีย ค่ะ" — the later take stays
  });

  it('drops the first take from picture and captions when enabled', () => {
    const r = planJumpCuts({ startMs: 0, endMs: tokens.length * 300 }, words, all, {
      ...cuts,
      removeRestarts: true,
    });
    expect(r.words.map((x) => x.text).join('')).toBe('คุณพีแคปแล้วบอกว่าไซส์เสียคุณพีแคป');
    expect(r.segments).toEqual([
      { startMs: 0, endMs: 1800 },
      { startMs: 2700, endMs: 4200 },
    ]);
  });

  it('a long word said again and again (ASR loop) keeps one; short doubled words stay', () => {
    const loop = ['ตอนนี้', 'ตอนนี้', 'ตอนนี้', 'ราคา', 'ดี', 'ดี'].map((t, i) => w(t, i * 400, i * 400 + 400));
    expect(findRestarts(loop)).toEqual([{ fromWord: 0, toWord: 1 }]);
  });

  it('a phrase repeated far apart is not a restart', () => {
    expect(findRestarts(words).some((r) => r.fromWord === 0)).toBe(false);
  });
});
