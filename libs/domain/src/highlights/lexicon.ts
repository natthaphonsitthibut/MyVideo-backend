/**
 * Thai live-selling lexicon for the rule-based highlight scorer (E07-F01). Terms are matched on the transcript's
 * words joined without spaces, lower-cased. `whole` terms must equal one ASR word (short words that would
 * otherwise match inside common words, e.g. อก inside ออก/บอก). Spelling variants the ASR really produces on
 * live selling footage are listed next to the correct spelling (e.g. ตำหนี / ตำนิด for ตำหนิ, รับพิม for รับพิมพ์).
 */
export type LexiconKind = 'promo' | 'urgency' | 'cta' | 'detail' | 'benefit';
export type LexiconTerm = { term: string; whole?: boolean };

const w = (term: string): LexiconTerm => ({ term, whole: true });
const s = (term: string): LexiconTerm => ({ term });

export const THAI_SELLING_LEXICON: Record<LexiconKind, LexiconTerm[]> = {
  promo: [
    s('ส่วนลด'),
    s('ลดราคา'),
    w('ลด'),
    s('โปรโมชั่น'),
    w('โปร'),
    s('แถม'),
    s('ส่งฟรี'),
    w('ฟรี'),
    s('ราคาพิเศษ'),
    s('คุ้ม'),
    w('ถูก'),
    s('ถูกมาก'),
    s('ลดเหลือ'),
    s('flashsale'),
  ],
  urgency: [
    s('ตัวสุดท้าย'),
    s('ชิ้นสุดท้าย'),
    s('มีตัวเดียว'),
    s('ตัวเดียว'),
    s('ชิ้นเดียว'),
    s('เหลือน้อย'),
    s('จำนวนจำกัด'),
    s('วันนี้เท่านั้น'),
    s('ก่อนหมด'),
    w('รีบ'),
    w('ด่วน'),
    w('หมด'),
  ],
  cta: [
    s('รับพิมพ์'),
    s('รับพิม'),
    s('พิมพ์ว่า'),
    s('พิมว่า'),
    s('พิมรับ'),
    s('แคป'),
    s('อินบ็อก'),
    s('อินบอก'),
    s('inbox'),
    s('ทักแชท'),
    s('คอมเมนต์'),
    s('กดสั่ง'),
    w('สั่ง'),
    s('สั่งซื้อ'),
    s('ตะกร้า'),
    w('cf'),
    s('โอนเงิน'),
    w('โอน'),
    s('ค่าส่ง'),
    s('ค่าจะส่ง'),
    s('ส่งของ'),
    s('เก็บเงินปลายทาง'),
    s('รวมยอด'),
    s('ซื้อได้'),
  ],
  detail: [
    s('ไซส์'),
    s('ไซส'),
    s('ไซต์'),
    s('ไซซ์'),
    s('size'),
    w('อก'),
    w('ยาว'),
    s('เนื้อผ้า'),
    w('ผ้า'),
    s('ป้าย'),
    s('สภาพ'),
    s('ตำหนิ'),
    s('ตำหนี'),
    s('ตำนิด'),
    s('สกรีน'),
    s('สกิน'),
    w('ลาย'),
    w('สี'),
    s('ขนาด'),
    s('แบรนด์'),
    s('madein'),
    s('สอยเดียว'),
    s('ตะเข็บ'),
    s('เข็บ'),
  ],
  benefit: [
    s('สวย'),
    s('สีสด'),
    s('แนะนำ'),
    s('นุ่ม'),
    s('นิ่ม'),
    s('สภาพใหม่'),
    s('ใหม่มาก'),
    s('เด็ด'),
    s('หายาก'),
    s('ของแท้'),
    s('คุณภาพ'),
    s('สบาย'),
    s('ไม่มีตำหนิ'),
    s('ไม่มีตำหนี'),
    s('ไม่แตก'),
  ],
};

/** Words that end a question in spoken Thai (or a literal question mark). */
export const THAI_QUESTION_ENDINGS = [
  'ไหม',
  'มั้ย',
  'หรอ',
  'เหรอ',
  'ไหน',
  'เท่าไหร่',
  'ยังไง',
  'อะไร',
  'ป่ะ',
  'ปะ',
  '?',
];

/** Words just before a number that make it a body measurement (the ASR often hears "ยาว 27" as "ยาว 27 บาท"). */
export const MEASUREMENT_WORDS = ['ยาว', 'อก', 'ออก', 'ยา'];
