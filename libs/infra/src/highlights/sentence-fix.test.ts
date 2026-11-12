import { describe, expect, it } from 'vitest';
import { alignSentence, validSentence } from './sentence-fix.js';

// Real S01a lines (whisper tokens) and what the seller said (merchant's listened labels, 2026-11-12).
describe('alignSentence: a corrected sentence back onto the heard word slots', () => {
  it('merges a word split over several heard tokens into the first slot (empty = continuation)', () => {
    expect(alignSentence(['วัน', 'พุ้', 'นรา', 'หัด', 'นะ', 'ส่ง', 'ของ'], 'วันพฤหัสนะ ส่งของ')).toEqual([
      'วัน',
      'พฤหัส',
      '',
      '',
      'นะ',
      'ส่ง',
      'ของ',
    ]);
  });

  it('fixes words beyond a few characters (เคย → เคลียร์, ภัย → ภาย)', () => {
    expect(alignSentence(['เคย', 'ยอด', 'ให้'], 'เคลียร์ยอดให้')).toEqual(['เคลียร์', 'ยอด', 'ให้']);
    expect(alignSentence(['หมด', 'ภัย', 'ใน'], 'หมดภายใน')).toEqual(['หมด', 'ภายใน', '']);
  });

  it('keeps a spaced size letter in one slot and leaves unchanged words as they are', () => {
    expect(alignSentence(['ป้าย', 'กิลเด้น', 'ไซม'], 'ป้ายกิลเด้น ไซซ์ M')).toEqual(['ป้าย', 'กิลเด้น', 'ไซซ์ M']);
    expect(alignSentence(['50 บาท', 'ตัว', 'ตัว', 'ไป'], '50 บาท ตัวต่อไป')).toEqual([
      '50 บาท',
      'ตัว',
      'ต่อ',
      'ไป',
    ]);
  });

  it('a glossary name stays whole in one slot (English brand over garbled Thai tokens)', () => {
    expect(alignSentence(['ของ', 'ควิก', 'บู', 'นะ'], 'ของ Liquid Blue นะ', ['Liquid Blue'])).toEqual([
      'ของ',
      'Liquid Blue',
      '',
      'นะ',
    ]);
  });

  it('a dropped first token gives its slot to the next text (never a continuation with no head)', () => {
    const slots = alignSentence(['เอ่อ', 'ตัว', 'นี้'], 'ตัวนี้');
    expect(slots?.[0]).not.toBe('');
    expect(slots?.join('')).toBe('ตัวนี้');
  });
});

describe('validSentence: what a rewrite may not do', () => {
  it('rejects a changed or invented number/price', () => {
    expect(validSentence('80 บาท ค่ะ', '90 บาทค่ะ', [])).toBe(false);
    expect(validSentence('ตัวนี้ ค่ะ', 'ตัวนี้ 80 บาทค่ะ', [])).toBe(false);
    expect(validSentence('80 บาท ค่ะ', '80 บาทค่ะ', [])).toBe(true);
  });

  it('rejects a paraphrase (too much changed) but allows real fixes and glossary names', () => {
    expect(validSentence('ส่ง ของ วัน พุ้ นรา หัด', 'ส่งของวันพฤหัส', [])).toBe(true);
    expect(validSentence('ส่ง ของ วัน พุ้ นรา หัด', 'จัดส่งสินค้าภายในสัปดาห์หน้าแน่นอน', [])).toBe(false);
    expect(validSentence('ลิ ควิด บู สวย มาก', 'Liquid Blue สวยมาก', ['Liquid Blue'])).toBe(true);
  });

  it('rejects a rewrite that drops heard words (real S01a: the set phrase รับพิมรับมา dropped)', () => {
    const glossary = [{ term: 'รับพิมพ์รับมา', heardAs: ['รับ พิม รับ มา', 'แล้ว พิม ลับ มา'] }];
    const heard = 'ตอนนี้ รับ พิม รับ มา 1,500 บาท นะ ครับผม';
    expect(validSentence(heard, 'ตอนนี้รับมา 1,500 บาทนะครับผม', [], glossary)).toBe(false);
    expect(validSentence(heard, 'ตอนนี้รับพิมพ์รับมา 1,500 บาทนะครับผม', [], glossary)).toBe(true);
  });

  it('a glossary phrase spelled with ไซส์ is kept when the model writes ไซซ์ (one size spelling)', () => {
    const glossary = [{ term: 'ไซส์เสีย', heardAs: ['ไซส์ เสีย'] }];
    expect(validSentence('บอ กว่า ไซส์ เสีย ค่ะ', 'บอกว่าไซซ์เสียค่ะ', [], glossary)).toBe(true);
  });

  it('rejects an added health/guarantee claim that was not heard', () => {
    expect(validSentence('ผ้า ดี มาก', 'ผ้าดีมาก ของแท้100%', [])).toBe(false);
  });
});
