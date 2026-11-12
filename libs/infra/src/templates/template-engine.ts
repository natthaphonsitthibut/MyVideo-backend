import { SHOT_ROLE_HINTS, type ShotRole, type TemplateVersion } from '@myvideo/contracts';

/** A detected shot of one of the merchant's clips with its role (words: what is said in it, source ms). */
export type TemplateShot = {
  sourceId: string;
  index: number;
  startMs: number;
  endMs: number;
  role: ShotRole;
  confidence: number;
  words: { text: string; startMs: number; endMs: number }[];
};

export type TemplatePiece = {
  slot: number;
  sourceId: string;
  shotIndex: number;
  role: ShotRole;
  inMs: number;
  outMs: number;
  text: { kind: 'title' | 'point'; value: string } | null;
};

/** `slot` −1 = the footage as a whole is too short for the template. */
export type MissingShot = { slot: number; roles: ShotRole[]; hint: string };

export type TemplatePlan =
  | { ok: true; pieces: TemplatePiece[]; durationMs: number }
  | { ok: false; missing: MissingShot[] };

const TAIL_MS = 300;

/** Where a talking shot is cut: from its first word, ending after a word that ends inside the limit. */
function talkSpan(shot: TemplateShot, minMs: number, maxMs: number): [number, number] {
  const first = shot.words.find((w) => w.startMs >= shot.startMs && w.endMs <= shot.endMs);
  const inMs = first ? first.startMs : shot.startMs;
  const limit = Math.min(shot.endMs, inMs + maxMs);
  let outMs = limit;
  for (const w of shot.words) {
    const end = Math.min(shot.endMs, w.endMs + TAIL_MS);
    if (w.startMs >= inMs && end <= limit && end - inMs >= minMs) outMs = end;
  }
  // prefer the end of the LAST sentence that fits: a word followed by a pause of ≥ 400 ms
  const ends = shot.words.filter((w, i) => {
    const next = shot.words[i + 1];
    const end = Math.min(shot.endMs, w.endMs + TAIL_MS);
    return end <= limit && end - inMs >= minMs && (!next || next.startMs - w.endMs >= 400);
  });
  const last = ends.at(-1);
  if (last) outMs = Math.min(shot.endMs, last.endMs + TAIL_MS);
  return [inMs, outMs];
}

/** The middle of a picture-only shot (away from its transitions). */
function middleSpan(shot: TemplateShot, maxMs: number): [number, number] {
  const len = Math.min(maxMs, shot.endMs - shot.startMs);
  const inMs = shot.startMs + Math.floor((shot.endMs - shot.startMs - len) / 2);
  return [inMs, inMs + len];
}

/**
 * Template engine (E10-F03, ARCHITECTURE §10), pure: fills the template's slots in order with the best unused shot of
 * an accepted role (role preference, then confidence, then length). Required slots without footage are reported
 * with what to shoot; optional ones are skipped; a shot is never used twice and footage is never repeated to fake a
 * role. Texts are the merchant's own: the product name and the points they typed, in order.
 */
export function planTemplate(
  t: TemplateVersion,
  shots: readonly TemplateShot[],
  product: { name: string; points: readonly string[] },
): TemplatePlan {
  const used = new Set<string>();
  const pieces: TemplatePiece[] = [];
  const missing: MissingShot[] = [];
  const points = product.points.map((p) => p.trim()).filter(Boolean);
  let nextPoint = 0;
  t.slots.forEach((slot, i) => {
    const candidates = shots
      .filter((s) => slot.accepts.includes(s.role) && !used.has(`${s.sourceId}:${s.index}`))
      .filter((s) => s.endMs - s.startMs >= slot.minMs)
      .sort(
        (a, b) =>
          slot.accepts.indexOf(a.role) - slot.accepts.indexOf(b.role) ||
          b.confidence - a.confidence ||
          b.endMs - b.startMs - (a.endMs - a.startMs) ||
          a.sourceId.localeCompare(b.sourceId) ||
          a.index - b.index,
      );
    const shot = candidates[0];
    if (!shot) {
      if (slot.required) {
        const role = slot.accepts[0] as ShotRole;
        missing.push({ slot: i, roles: [...slot.accepts], hint: SHOT_ROLE_HINTS[role] });
      }
      return;
    }
    used.add(`${shot.sourceId}:${shot.index}`);
    const [inMs, outMs] =
      shot.role === 'talking_head' ? talkSpan(shot, slot.minMs, slot.maxMs) : middleSpan(shot, slot.maxMs);
    let text: TemplatePiece['text'] = null;
    if (slot.text === 'product_name' && product.name.trim())
      text = { kind: 'title', value: product.name.trim() };
    if (slot.text === 'point' && nextPoint < points.length)
      text = { kind: 'point', value: points[nextPoint++] as string };
    pieces.push({
      slot: i,
      sourceId: shot.sourceId,
      shotIndex: shot.index,
      role: shot.role,
      inMs,
      outMs,
      text,
    });
  });
  if (missing.length > 0) return { ok: false, missing };
  // too long: drop optional pieces from the end; too short: report (never loop or slow the footage down)
  const total = () => pieces.reduce((n, p) => n + p.outMs - p.inMs, 0);
  for (let i = pieces.length - 1; i >= 0 && total() > t.durationMs.max; i--) {
    const p = pieces[i] as TemplatePiece;
    if (!t.slots[p.slot]?.required) pieces.splice(i, 1);
  }
  if (total() < t.durationMs.min) {
    const optional = t.slots.flatMap((s) => (s.required ? [] : s.accepts));
    const roles = [...new Set(optional)].slice(0, 3) as ShotRole[];
    return {
      ok: false,
      missing: [
        {
          slot: -1,
          roles,
          hint: `ฟุตเทจรวมสั้นไป (${Math.round(total() / 1000)} วินาที ต้องอย่างน้อย ${Math.round(t.durationMs.min / 1000)} วินาที) — ถ่ายเพิ่มอีก 2–3 ช็อต`,
        },
      ],
    };
  }
  return { ok: true, pieces, durationMs: total() };
}
