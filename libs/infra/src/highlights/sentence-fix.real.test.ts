import { describe, expect, it } from 'vitest';
import { alignSentence } from './sentence-fix.js';

// Real S01a whisper tokens (seq 21, 227, 229) and the sentence the seller said (merchant's listened labels).
describe('alignSentence on real lines', () => {
  it('seq 21: nothing the model wrote is lost', () => {
    const heard = ['ตอนนี้', 'รับ', 'พิม', 'รับ', 'มา', '1,500', 'บาท', 'นะ', 'ครับผม'];
    const out = alignSentence(heard, 'ตอนนี้รับพิมพ์รับมา 1,500 บาทนะครับผม', ['รับพิมพ์รับมา']);
    expect(out?.join('').replace(/\s/g, '')).toBe('ตอนนี้รับพิมพ์รับมา1,500บาทนะครับผม');
    expect(out?.[0]).toBe('ตอนนี้');
  });
  it('seq 227: โอ กส์ → อก', () => {
    const out = alignSentence(['ตัว', 'นี้', 'โอ', 'กส์', '19.5', 'ยาว', '29'], 'ตัวนี้ อก 19.5 ยาว 29');
    expect(out?.join('').replace(/\s/g, '')).toBe('ตัวนี้อก19.5ยาว29');
  });
  it('seq 229: ไซ ม → ไซซ์ M', () => {
    const out = alignSentence(['ป้าย', 'กิล', 'เด้', 'น', 'ไซ', 'ม'], 'ป้ายกิลเด้น ไซซ์ M');
    expect(out?.join(' ').replace(/\s+/g, ' ')).toContain('ไซซ์ M');
  });
});
