import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

/** Fonts a brand kit may choose (bundled with the stage, so render and preview match). */
export const BRAND_FONT_IDS = ['noto-sans-thai'] as const;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * The merchant's brand kit (E08-F08): one per merchant. Projects reference it through style tokens
 * (`brand:primary` | `brand:accent` | `brand:text`, font `brand`), so a change restyles every project on its next
 * preview/render without editing the projects.
 */
export const BrandKit = named(
  'BrandKit',
  z.object({
    primaryColor: hex,
    accentColor: hex,
    textColor: hex,
    font: z.enum(BRAND_FONT_IDS),
    /** The shop's default call-to-action label (the merchant's own words). */
    defaultCta: z.string().min(1).max(40),
    hasLogo: z.boolean(),
    /** null = never saved (defaults shown). */
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
);
export type BrandKit = z.infer<typeof BrandKit>;

export const BrandKitBody = named(
  'BrandKitBody',
  z.object({
    primaryColor: hex,
    accentColor: hex,
    textColor: hex,
    font: z.enum(BRAND_FONT_IDS),
    defaultCta: z
      .string()
      .transform((s) => s.normalize('NFC').trim())
      .pipe(z.string().min(1).max(40)),
  }),
);
export type BrandKitBody = z.infer<typeof BrandKitBody>;

export const BRAND_DEFAULTS: Omit<BrandKit, 'hasLogo' | 'updatedAt'> = {
  primaryColor: '#111111',
  accentColor: '#facc15',
  textColor: '#ffffff',
  font: 'noto-sans-thai',
  defaultCta: 'กดตะกร้า สั่งได้เลย',
};

/** Logo upload limits: PNG/JPEG/WebP up to 2 MB. */
export const BRAND_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const BRAND_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const getBrandKit = defineRoute({
  operationId: 'getBrandKit',
  method: 'get',
  path: '/brand-kit',
  summary: "The merchant's brand kit (defaults when never saved)",
  tags: ['brand'],
  auth: true,
  responses: { 200: { description: 'Brand kit', schema: BrandKit } },
});

export const saveBrandKit = defineRoute({
  operationId: 'saveBrandKit',
  method: 'put',
  path: '/brand-kit',
  summary: 'Save colours, font and default call-to-action',
  tags: ['brand'],
  auth: true,
  request: { body: BrandKitBody },
  responses: {
    200: { description: 'Saved brand kit', schema: BrandKit },
    400: { description: 'Invalid body', schema: ApiErrorBody },
  },
});

export const uploadBrandLogo = defineRoute({
  operationId: 'uploadBrandLogo',
  method: 'put',
  path: '/brand-kit/logo',
  summary: 'Upload the logo (raw image body: PNG, JPEG or WebP, max 2 MB)',
  tags: ['brand'],
  auth: true,
  responses: {
    200: { description: 'Saved brand kit', schema: BrandKit },
    413: { description: 'Logo too large', schema: ApiErrorBody },
    415: { description: 'Not a PNG/JPEG/WebP image', schema: ApiErrorBody },
  },
});

export const getBrandLogo = defineRoute({
  operationId: 'getBrandLogo',
  method: 'get',
  path: '/brand-kit/logo',
  summary: 'The logo image',
  tags: ['brand'],
  auth: true,
  responses: {
    200: { description: 'Image' },
    404: { description: 'No logo uploaded', schema: ApiErrorBody },
  },
});
