import { stylePack, TRANSITION_KINDS, type TransitionKind, validateProject } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import { buildClipProject } from './clip-project.js';
import { planJumpCuts } from './jump-cuts.js';
import { LOUD_TRANSITIONS, planTransitions, transitionViolations } from './transitions.js';

const fps = 30;
/** n shots, one every `every` seconds; `moments` marks price / CTA shots by index. */
const shots = (n: number, every: number, moments: Record<number, 'price' | 'cta'> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    startFrame: Math.round(i * every * fps),
    moment: moments[i] ?? null,
  }));

describe('transitions in a built clip', () => {
  // 40 s of speech in 2 s phrases with 0.5 s pauses: every pause is a jump cut; a price is said at 21 s
  const words = Array.from({ length: 20 }, (_, i) => ({
    text: i === 10 ? '80บาท' : `คำ${i}`,
    startMs: 1000 + i * 2000,
    endMs: 1000 + i * 2000 + 1500,
  }));
  const plan = { startMs: 1000, endMs: 41_000, title: 'ทดสอบ', words };
  const speech = words.map((w) => ({ startMs: w.startMs, endMs: w.endMs }));
  const source = {
    sourceId: '00000000-0000-4000-8000-000000000001',
    fps: { num: 30, den: 1 },
    durationFrames: 3000,
    hasAudio: true,
  };
  const build = (id: string, kind?: TransitionKind) => {
    const style = structuredClone(stylePack(id));
    if (kind) style.transitions = { kinds: [kind], onMoment: kind, maxShare: 0.25, minGapMs: 3000 };
    const cut = planJumpCuts({ startMs: plan.startMs, endMs: plan.endMs }, plan.words, speech, style.cuts);
    return buildClipProject({
      projectId: '00000000-0000-4000-8000-0000000000aa',
      merchantId: '00000000-0000-4000-8000-0000000000bb',
      source,
      plan,
      pages: [],
      edit: { style, cut },
      seed: 't',
    });
  };
  it.each(TRANSITION_KINDS)('builds editable %s transitions with motivation and a valid budget', (kind) => {
    const doc = build('sale-fast', kind);
    const transitions = Object.values(doc.elements).flatMap((e) =>
      e.transition ? [{ kind: e.transition.kind, startFrame: e.startFrame }] : [],
    );
    expect(transitions.length).toBeGreaterThan(0);
    expect(
      transitionViolations(
        transitions,
        Object.values(doc.elements).filter((e) => e.type === 'video').length - 1,
        30,
      ),
    ).toEqual([]);
    expect(validateProject(doc).ok).toBe(true);
  });

  it('sale-fast: flash shapes / zoom punches on cuts, valid, within budget; simple: none', () => {
    const p = build('sale-fast');
    expect(validateProject(p).ok).toBe(true);
    const videos = Object.values(p.elements).filter((e) => e.type === 'video');
    const flashes = Object.values(p.elements).filter((e) => e.type === 'shape' && e.fill === '#ffffff');
    const punches = videos.filter(
      (v) => (v.keyframes?.['transform.scale']?.[0]?.value ?? 0) > v.transform.scale * 1.1,
    );
    expect(flashes.length + punches.length).toBeGreaterThan(0);
    expect(flashes.length + punches.length).toBeLessThanOrEqual(Math.floor((videos.length - 1) / 4));
    // every flash starts exactly on a cut
    const cuts = new Set(videos.slice(1).map((v) => v.startFrame));
    for (const f of flashes) expect(cuts.has(f.startFrame)).toBe(true);
    const s = build('simple');
    expect(Object.values(s.elements).some((e) => e.type === 'shape')).toBe(false);
  });
});

describe('planTransitions (E13-F05: motivated, budgeted)', () => {
  it('a style without transitions keeps hard cuts', () => {
    expect(planTransitions(stylePack('simple').transitions, shots(10, 2), fps)).toEqual([]);
  });

  it('the cut where a price is said gets the moment transition, with its reason', () => {
    const t = planTransitions(stylePack('sale-fast').transitions, shots(12, 2, { 5: 'price' }), fps);
    expect(t).toContainEqual({ index: 5, kind: 'flash', why: 'price' });
  });

  it('never the first shot (that is the start, not a cut)', () => {
    const t = planTransitions(stylePack('fun').transitions, shots(10, 3, { 0: 'price' }), fps);
    expect(t.some((x) => x.index === 0)).toBe(false);
  });

  it('budget: at most a quarter of the cuts, min gap between transitions, ≤ 2 loud per clip', () => {
    for (const id of ['sale-fast', 'fun', 'premium']) {
      const pack = stylePack(id).transitions;
      const s = shots(40, 1.5, { 3: 'price', 9: 'price', 15: 'cta', 21: 'price' });
      const t = planTransitions(pack, s, fps);
      const cuts = s.length - 1;
      expect(t.length, id).toBeLessThanOrEqual(Math.floor(cuts * (pack?.maxShare ?? 0)));
      expect(t.filter((x) => LOUD_TRANSITIONS.includes(x.kind)).length, id).toBeLessThanOrEqual(2);
      for (let i = 1; i < t.length; i++) {
        const gapMs =
          (((s[t[i]?.index ?? 0]?.startFrame ?? 0) - (s[t[i - 1]?.index ?? 0]?.startFrame ?? 0)) * 1000) /
          fps;
        expect(gapMs, id).toBeGreaterThanOrEqual(pack?.minGapMs ?? 0);
      }
      expect(t.length, `${id} uses its transitions`).toBeGreaterThan(0);
    }
  });

  it('kinds take turns on plain cuts', () => {
    const t = planTransitions(stylePack('fun').transitions, shots(30, 2.5), fps);
    expect(new Set(t.map((x) => x.kind)).size).toBeGreaterThan(1);
    expect(t.every((x) => x.why === 'cut')).toBe(true);
  });
});
