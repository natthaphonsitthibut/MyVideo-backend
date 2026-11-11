import type { DeepPartial, EntityManager, EntityTarget, FindOptionsWhere, ObjectLiteral } from 'typeorm';

/** Rows that belong to a merchant (every table except `merchants`). */
export type TenantRow = ObjectLiteral & { id: string; merchantId: string };
type Where<T extends TenantRow> = Omit<FindOptionsWhere<T>, 'merchantId'>;

/**
 * The only way application code reads or writes tenant rows (ARCHITECTURE §12, AGENTS.md §8.7):
 * every method adds `merchant_id = :merchantId`, so a row of another merchant behaves exactly like a
 * missing row (not found / 0 affected). Callers cannot pass `merchantId` in `where`.
 */
export class TenantRepository<T extends TenantRow> {
  constructor(
    private readonly em: EntityManager,
    private readonly target: EntityTarget<T>,
    readonly merchantId: string,
  ) {
    if (!merchantId) throw new Error('TenantRepository needs a merchantId');
  }

  private scope(where: Where<T> = {} as Where<T>): FindOptionsWhere<T> {
    return { ...where, merchantId: this.merchantId } as FindOptionsWhere<T>;
  }

  find(
    where?: Where<T>,
    opts: { take?: number; skip?: number; order?: Record<string, 'ASC' | 'DESC'> } = {},
  ) {
    return this.em.find(this.target, { where: this.scope(where), ...opts } as never) as Promise<T[]>;
  }

  findOne(where: Where<T>): Promise<T | null> {
    return this.em.findOne(this.target, { where: this.scope(where) });
  }

  findById(id: string): Promise<T | null> {
    return this.findOne({ id } as unknown as Where<T>);
  }

  count(where?: Where<T>): Promise<number> {
    return this.em.count(this.target, { where: this.scope(where) });
  }

  async insert(values: Omit<DeepPartial<T>, 'merchantId'>): Promise<T> {
    const row = this.em.create(this.target, { ...values, merchantId: this.merchantId } as DeepPartial<T>);
    return this.em.save(this.target, row);
  }

  /** Returns the number of rows changed (0 when the id belongs to another merchant). */
  async update(where: Where<T>, values: Omit<DeepPartial<T>, 'merchantId' | 'id'>): Promise<number> {
    if ('merchantId' in (values as object)) throw new Error('merchantId cannot be changed');
    const res = await this.em.update(this.target, this.scope(where), values as never);
    return res.affected ?? 0;
  }

  async delete(where: Where<T>): Promise<number> {
    const res = await this.em.delete(this.target, this.scope(where));
    return res.affected ?? 0;
  }
}
