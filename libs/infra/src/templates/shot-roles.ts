import type { ShotRole } from '@myvideo/contracts';

/** Below this the merchant is asked to pick the role (E10-F04). */
export const LOW_CONFIDENCE = 0.6;
/** Face ≥ 0.4 % of the frame (a real half-body phone shot measured ≈ 0.9 %, C03). */
const FACE_MIN = 0.004;
const UNBOXING = /แกะ|เปิดกล่อง|พัสดุ|unbox/i;

export type ShotSignals = {
  startMs: number;
  endMs: number;
  /** Largest face / frame area per keyframe (0 = no face). */
  faces: number[];
  /** Words said inside the shot (source ms). */
  words: { text: string; startMs: number; endMs: number }[];
};

export type ShotRoleGuess = { role: ShotRole; confidence: number; reason: string };

function speechRatio(s: ShotSignals): number {
  const len = Math.max(1, s.endMs - s.startMs);
  let covered = 0;
  for (const w of s.words)
    covered += Math.max(0, Math.min(w.endMs, s.endMs) - Math.max(w.startMs, s.startMs));
  return Math.min(1, covered / len);
}

/**
 * Shot role from cheap local signals (E10-F04): face presence on the keyframes, how much of the shot is speech, what
 * is said, and length. Confidence below `LOW_CONFIDENCE` → the merchant chooses (no vision model in this version).
 */
export function classifyShot(s: ShotSignals): ShotRoleGuess {
  const faced = s.faces.filter((f) => f >= FACE_MIN).length;
  const faceShare = s.faces.length ? faced / s.faces.length : 0;
  const speech = speechRatio(s);
  const len = s.endMs - s.startMs;
  const said = s.words.map((w) => w.text).join('');
  if (faceShare >= 0.5 && speech >= 0.3)
    return { role: 'talking_head', confidence: 0.9, reason: 'เห็นหน้าคนและมีเสียงพูด' };
  if (UNBOXING.test(said)) return { role: 'unboxing', confidence: 0.7, reason: 'คนขายพูดถึงการแกะกล่อง' };
  if (faceShare >= 0.5) return { role: 'talking_head', confidence: 0.5, reason: 'เห็นหน้าคนแต่ไม่ได้พูด' };
  if (speech >= 0.5 && len >= 3_000)
    return { role: 'demo', confidence: 0.65, reason: 'ไม่เห็นหน้า แต่มีเสียงอธิบายตลอดช็อต' };
  if (len < 4_000) return { role: 'product_closeup', confidence: 0.65, reason: 'ช็อตสั้น ไม่มีคน' };
  return { role: 'demo', confidence: 0.45, reason: 'ช็อตยาว ไม่มีคน — ไม่แน่ใจ' };
}
