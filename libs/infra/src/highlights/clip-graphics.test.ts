import { describe, expect, it } from 'vitest';
import { markEmphasis, priceMentions } from './clip-graphics.js';

// caption pages as the stage builds them from real S01a tokens (frames relative to each page)
const page = (startFrame: number, texts: string[]) => ({
  startFrame,
  durationFrames: texts.length * 10,
  words: texts.map((text, i) => ({ text, startFrame: i * 10, endFrame: i * 10 + 10 })),
  lines: [texts.map((_t, i) => i)],
});

describe('markEmphasis', () => {
  it('one key word per page: price first, then the product, then a size, then a strong selling word', () => {
    const pages = markEmphasis(
      [
        page(0, ['ตัวนี้', 'ราคา 80 บาทค่ะ']),
        page(30, ['Liquid Blue', 'สีสด']),
        page(60, ['อก 22', 'ยาว 29']),
        page(90, ['สีสด', 'มาก']),
        page(120, ['แล้วก็', 'ส่งของ']),
      ],
      ['Liquid Blue'],
    );
    const keys = pages.map((p) => p.words.filter((w) => w.emphasis).map((w) => w.text));
    expect(keys).toEqual([['ราคา 80 บาทค่ะ'], ['Liquid Blue'], ['อก 22'], ['สีสด'], []]);
  });

  it('never marks more than one word on a page', () => {
    const [p] = markEmphasis([page(0, ['80 บาท', '100 บาท'])], []);
    expect(p?.words.filter((w) => w.emphasis)).toHaveLength(1);
  });
});

describe('priceMentions', () => {
  const pages = [page(0, ['ตัวนี้', 'ราคา 80 บาทค่ะ']), page(40, ['ส่ง', 'ฟรี']), page(200, ['ไซซ์ L', '100 บาท'])];

  it('takes the spoken price verbatim and where it is said (project frames)', () => {
    expect(priceMentions(pages)).toEqual([
      { text: '80 บาท', frame: 10 },
      { text: '100 บาท', frame: 210 },
    ]);
  });

  it('skips ones too close to the previous and keeps at most maxPerClip', () => {
    const close = [
      page(0, ['80 บาท']),
      page(30, ['100 บาท']),
      page(300, ['120 บาท']),
      page(600, ['150 บาท']),
    ];
    expect(priceMentions(close, { minGapFrames: 90, maxPerClip: 2 }).map((m) => m.text)).toEqual([
      '80 บาท',
      '120 บาท',
    ]);
  });
});
