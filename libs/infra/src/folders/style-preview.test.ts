import { stylePack } from '@myvideo/contracts';
import { expect, it } from 'vitest';
import { stylePreview } from './style-preview.js';

it('uses actual source words and merchant text; silent footage never gets invented captions', () => {
  const words = [
    { text: 'ราคา', startMs: 12000, endMs: 12300 },
    { text: '199', startMs: 12300, endMs: 12600 },
    { text: 'บาท', startMs: 12600, endMs: 13000 },
  ];
  const preview = stylePreview(stylePack('honest-review'), 'source', words, 'ชื่อที่ร้านพิมพ์');
  expect(preview.words).toEqual(words);
  expect(preview.timeMs).toBe(12000);
  expect(preview.productName).toBe('ชื่อที่ร้านพิมพ์');
  expect(stylePreview(stylePack('simple'), 'source', [], null).words).toEqual([]);
});
