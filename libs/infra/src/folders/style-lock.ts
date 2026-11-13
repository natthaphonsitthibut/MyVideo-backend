import { FrozenStyle, STYLE_PACKS } from '@myvideo/contracts';
import { uuidv7 } from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
export function freezeStyle(styleId: string, seed: string): FrozenStyle {
  const pack = STYLE_PACKS.find((p) => p.id === styleId);
  if (!pack) throw new Error(`Unknown style ${styleId}`);
  return FrozenStyle.parse({ version: 1, seed, pack });
}
export async function getStyleLock(
  db: DataSource | EntityManager,
  merchantId: string,
): Promise<FrozenStyle | null> {
  const [row] = (await db.query(`SELECT snapshot FROM merchant_style_locks WHERE merchant_id=$1`, [
    merchantId,
  ])) as { snapshot: unknown }[];
  return row ? FrozenStyle.parse(row.snapshot) : null;
}
export async function lockStyle(
  ds: DataSource | EntityManager,
  merchantId: string,
  styleId: string,
): Promise<FrozenStyle> {
  return ds.transaction(async (em) => {
    await em.query(`SELECT id FROM merchants WHERE id=$1 FOR UPDATE`, [merchantId]);
    const existing = await getStyleLock(em, merchantId);
    if (existing?.pack.id === styleId) return existing;
    const snapshot = freezeStyle(styleId, uuidv7());
    await em.query(
      `INSERT INTO merchant_style_locks(merchant_id,snapshot) VALUES($1,$2) ON CONFLICT(merchant_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,updated_at=now()`,
      [merchantId, JSON.stringify(snapshot)],
    );
    return snapshot;
  });
}
export async function unlockStyle(ds: DataSource, merchantId: string): Promise<void> {
  await ds.query(`DELETE FROM merchant_style_locks WHERE merchant_id=$1`, [merchantId]);
}
