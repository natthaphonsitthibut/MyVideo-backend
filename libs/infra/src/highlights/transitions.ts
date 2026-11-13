import type { StylePack, TransitionKind } from '@myvideo/contracts';

/** Transitions that draw attention; a clip gets at most two of them. */
export const LOUD_TRANSITIONS: readonly TransitionKind[] = ['flash', 'slide-push'];
const MAX_LOUD = 2;

export type PlannedTransition = { index: number; kind: TransitionKind; why: 'price' | 'cta' | 'cut' };

/**
 * Pure (E13-F05): which jump cuts get a transition. Motivated first — the cut into a shot where a price or call to
 * action is said gets the pack's `onMoment` kind — then plain cuts in turn from `kinds`, each at least `minGapMs`
 * after the previous transition. Budget: `maxShare` of the cuts at most (the spec caps special transitions at ¼),
 * and at most two loud ones. `shots[i].startFrame` is where shot i starts on the output timeline.
 */
export function planTransitions(
  pack: StylePack['transitions'],
  shots: readonly { startFrame: number; moment: 'price' | 'cta' | null }[],
  fps: number,
): PlannedTransition[] {
  if (!pack || shots.length < 2) return [];
  const cuts = shots.length - 1;
  const budget = Math.floor(cuts * Math.min(pack.maxShare, 0.25));
  if (budget < 1) return [];
  const gapFrames = Math.round((pack.minGapMs * fps) / 1000);
  const chosen = new Map<number, PlannedTransition>();
  let loud = 0;
  const fits = (i: number, kind: TransitionKind) => {
    const at = shots[i]?.startFrame ?? 0;
    if (LOUD_TRANSITIONS.includes(kind) && loud >= MAX_LOUD) return false;
    for (const j of chosen.keys()) if (Math.abs((shots[j]?.startFrame ?? 0) - at) < gapFrames) return false;
    return true;
  };
  const take = (t: PlannedTransition) => {
    chosen.set(t.index, t);
    if (LOUD_TRANSITIONS.includes(t.kind)) loud++;
  };
  // 1. motivated cuts (price / call to action said in the next shot)
  if (pack.onMoment)
    for (let i = 1; i < shots.length && chosen.size < budget; i++) {
      const m = shots[i]?.moment;
      if (m && fits(i, pack.onMoment)) take({ index: i, kind: pack.onMoment, why: m });
    }
  // 2. plain cuts, kinds in turn
  let turn = 0;
  for (let i = 1; i < shots.length && chosen.size < budget && pack.kinds.length; i++) {
    if (chosen.has(i)) continue;
    for (let k = 0; k < pack.kinds.length; k++) {
      const kind = pack.kinds[(turn + k) % pack.kinds.length] as TransitionKind;
      if (fits(i, kind)) {
        take({ index: i, kind, why: 'cut' });
        turn = (turn + k + 1) % pack.kinds.length;
        break;
      }
    }
  }
  return [...chosen.values()].sort((a, b) => a.index - b.index);
}
