import itertools
import json
import unicodedata
from pathlib import Path

from myvideo_ai.thai import graphemes, normalize_text, segment_words

FIX = json.loads((Path(__file__).parent / "fixtures" / "asr-real.json").read_text())
REAL_SEGMENTS = [s for clip in FIX.values() for s in clip["segments"]]


def is_mark(ch: str) -> bool:
    return unicodedata.category(ch) in ("Mn", "Me")


def test_graphemes_keep_marks_with_their_base():
    assert graphemes("น้ำ") == ["น้", "ำ"] or graphemes("น้ำ") == ["น้ำ"]  # sara am is a spacing vowel
    assert graphemes("ปั๊ม") == ["ปั๊", "ม"]
    assert all(not is_mark(g[0]) for g in graphemes("ที่สุดก็ได้ปั๊ม"))


def test_normalize_text():
    assert normalize_text("  ราคา\u200b  100   บาท \u00a0") == "ราคา 100 บาท"
    assert normalize_text("เ" + "็" * 0 + "ก") == "เก"
    # decomposed sara am (nikhahit + sara aa) becomes the single code point
    assert normalize_text("น้ํา") == "น้ำ"


def test_real_asr_segments_get_monotonic_word_timings_inside_the_segment():
    for seg in REAL_SEGMENTS:
        words = segment_words(seg["text"], seg["start_ms"], seg["end_ms"])
        assert words, seg
        assert words[0]["start_ms"] == seg["start_ms"]
        assert words[-1]["end_ms"] == seg["end_ms"]
        for a, b in itertools.pairwise(words):
            assert a["end_ms"] == b["start_ms"]
            assert a["start_ms"] < a["end_ms"]
        assert "".join(w["text"] for w in words).replace(" ", "") == normalize_text(seg["text"]).replace(
            " ", ""
        )


def test_no_word_starts_with_a_combining_mark_in_real_output():
    for seg in REAL_SEGMENTS:
        for w in segment_words(seg["text"], seg["start_ms"], seg["end_ms"]):
            assert not is_mark(w["text"][0]), w


def test_numbers_units_and_repetition_mark_stay_together():
    words = [w["text"] for w in segment_words("รับมา 100 บาท ลด 50% ส่งฟรี ฿39,900 ดีๆ iPhone 17", 0, 10_000)]
    assert "50%" in words
    assert "฿39,900" in words
    assert "ดีๆ" in words
    assert "iPhone" in words
    assert "100" in words


def test_kinds():
    words = segment_words("ลด 50% iPhone ครับ", 0, 4000)
    assert [w["kind"] for w in words] == ["th", "number", "latin", "th"]


def test_real_price_phrase_from_live():
    seg = next(s for s in FIX["live-tiedye-th-vertical-b"]["segments"] if "100 บาท" in s["text"])
    words = [w["text"] for w in segment_words(seg["text"], seg["start_ms"], seg["end_ms"])]
    assert "100" in words and "บาท" in words
