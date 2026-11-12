import {
  BRAND_DEFAULTS,
  BRAND_LOGO_MAX_BYTES,
  BRAND_LOGO_TYPES,
  type BrandKit,
  type BrandKitBody,
} from '@myvideo/contracts';
import type { StoragePort } from '@myvideo/domain';
import { BrandKitEntity } from '@myvideo/infra';
import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { STORAGE } from '../storage/storage.module.js';

/** The first bytes of each accepted image type (the content-type header alone is not trusted). */
const MAGIC: Record<(typeof BRAND_LOGO_TYPES)[number], (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
};

export function sniffLogo(bytes: Uint8Array): (typeof BRAND_LOGO_TYPES)[number] | null {
  return BRAND_LOGO_TYPES.find((t) => MAGIC[t](bytes)) ?? null;
}

@Injectable()
export class BrandService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  private dto(row: BrandKitEntity | null): BrandKit {
    if (!row) return { ...BRAND_DEFAULTS, hasLogo: false, updatedAt: null };
    return {
      primaryColor: row.primaryColor,
      accentColor: row.accentColor,
      textColor: row.textColor,
      font: row.font as BrandKit['font'],
      defaultCta: row.defaultCta,
      hasLogo: row.logoKey !== null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private find(merchantId: string) {
    return this.ds.getRepository(BrandKitEntity).findOneBy({ merchantId });
  }

  async get(merchantId: string): Promise<BrandKit> {
    return this.dto(await this.find(merchantId));
  }

  /** Upsert: one kit per merchant (unique merchant_id). */
  async save(merchantId: string, body: BrandKitBody): Promise<BrandKit> {
    await this.ds
      .createQueryBuilder()
      .insert()
      .into(BrandKitEntity)
      .values({ merchantId, ...body, logoKey: null, logoContentType: null })
      .orUpdate(
        ['primary_color', 'accent_color', 'text_color', 'font', 'default_cta', 'updated_at'],
        ['merchant_id'],
      )
      .updateEntity(false)
      .execute();
    // updated_at is not touched by an ON CONFLICT update: set it explicitly
    await this.ds.getRepository(BrandKitEntity).update({ merchantId }, { updatedAt: new Date() });
    return this.get(merchantId);
  }

  async saveLogo(merchantId: string, bytes: Uint8Array): Promise<BrandKit> {
    if (bytes.byteLength > BRAND_LOGO_MAX_BYTES)
      throw new HttpException('โลโก้ใหญ่เกิน 2 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    const type = sniffLogo(bytes);
    if (!type) throw new HttpException('โลโก้ต้องเป็นไฟล์ PNG, JPEG หรือ WebP', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    const key = `m/${merchantId}/brand/logo-${Date.now()}`;
    await this.storage.put(key, bytes, { contentType: type });
    const before = await this.find(merchantId);
    if (!before) await this.save(merchantId, { ...BRAND_DEFAULTS });
    await this.ds
      .getRepository(BrandKitEntity)
      .update({ merchantId }, { logoKey: key, logoContentType: type, updatedAt: new Date() });
    if (before?.logoKey) await this.storage.delete(before.logoKey).catch(() => undefined);
    return this.get(merchantId);
  }

  async logo(merchantId: string): Promise<{ key: string; contentType: string }> {
    const row = await this.find(merchantId);
    if (!row?.logoKey || !row.logoContentType) throw new NotFoundException('ยังไม่มีโลโก้');
    return { key: row.logoKey, contentType: row.logoContentType };
  }

  read(key: string) {
    return this.storage.read(key);
  }
}
