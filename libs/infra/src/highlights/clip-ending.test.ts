import { describe, expect, it } from 'vitest';
import { clipEndWithTail, normalizeThaiSpelling, TAIL_MS } from './clip-ending.js';

describe('clip ending', () => {
  it('lets the last word breathe: up to TAIL_MS of the silence after it, never into the next word', () => {
    expect(clipEndWithTail(10_000, 12_000, 60_000)).toBe(10_000 + TAIL_MS);
    // the seller speaks again 300 ms later: stop 60 ms before that word
    expect(clipEndWithTail(10_000, 10_300, 60_000)).toBe(10_240);
    // next word immediately after: no tail, never earlier than the last word's end
    expect(clipEndWithTail(10_000, 10_020, 60_000)).toBe(10_000);
    // end of the recording
    expect(clipEndWithTail(59_800, undefined, 60_000)).toBe(60_000);
  });

  it('one spelling for size (ไซซ์) in every AI-made text; other words untouched', () => {
    expect(normalizeThaiSpelling('Liquid Blue มัดย้อมก้นหอย ไซส์ M 80 บาท')).toBe(
      'Liquid Blue มัดย้อมก้นหอย ไซซ์ M 80 บาท',
    );
    expect(normalizeThaiSpelling('ไซต์ L ไซ้ส์ XL')).toBe('ไซซ์ L ไซซ์ XL');
    expect(normalizeThaiSpelling('เว็บไซต์ของร้าน')).toBe('เว็บไซต์ของร้าน');
    // real title of a fresh S01a clip
    expect(normalizeThaiSpelling('OVP ไซซ์แอล 1,500 บาท')).toBe('OVP ไซซ์ L 1,500 บาท');
  });
});
