import itertools
import json
import unicodedata
from pathlib import Path

from myvideo_ai.thai import graphemes, normalize_text, segment_words

DTW = json.loads((Path(__file__).parent / "fixtures" / "asr-dtw-real.json").read_text())["segments"]


def dtw_tokens(seg: dict) -> list[tuple[str, int]]:
    return [(w["word"], w["t_dtw"] * 10) for w in seg["words"]]


def ms(seg: dict, key: str) -> int:
    return round(seg[key] * 1000)


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


def test_price_word_is_not_cut_by_an_idiom_in_the_dictionary():
    # real ASR lines of the 30-min live (L02): newmm read "ราคาที่" as รา|คาที่ (คาที่ = "on the spot")
    for line in ["จากราคาที่ผมตั้งใจว่ารุ่นนี้จะทำราคา 9,989", "เป็นราคาที่ดีที่สุดแล้วก็เลือก"]:
        words = [w["text"] for w in segment_words(line, 0, 6000)]
        assert "ราคา" in words and "รา" not in words, words


def test_kinds():
    words = segment_words("ลด 50% iPhone ครับ", 0, 4000)
    assert [w["kind"] for w in words] == ["th", "number", "latin", "th"]


def test_real_price_phrase_from_live():
    seg = next(s for s in FIX["live-tiedye-th-vertical-b"]["segments"] if "100 บาท" in s["text"])
    words = [w["text"] for w in segment_words(seg["text"], seg["start_ms"], seg["end_ms"])]
    assert "100" in words and "บาท" in words


def test_dtw_word_start_is_the_time_of_the_token_holding_its_first_char():
    seg = next(s for s in DTW if s["text"].startswith("ด้านหลัง"))  # real: 28-31 s segment
    words = segment_words(seg["text"], ms(seg, "start"), ms(seg, "end"), dtw_tokens(seg))
    assert words[0]["text"] == "ด้านหลัง" and words[0]["start_ms"] == 28720
    # without DTW the second word would sit at a character share of the 3-s span
    assert words[1]["start_ms"] != segment_words(seg["text"], 28000, 31000)[1]["start_ms"]


def test_dtw_times_are_contiguous_monotonic_and_inside_the_segment_on_real_output():
    for seg in DTW:
        start, end = ms(seg, "start"), ms(seg, "end")
        words = segment_words(seg["text"], start, end, dtw_tokens(seg))
        plain = segment_words(seg["text"], start, end)
        assert [w["text"] for w in words] == [w["text"] for w in plain]
        assert start <= words[0]["start_ms"] < end
        assert words[-1]["end_ms"] == end
        for a, b in itertools.pairwise(words):
            assert a["end_ms"] == b["start_ms"]
            assert a["start_ms"] < a["end_ms"]


def test_dtw_token_before_the_segment_is_clamped_to_its_start():
    seg = next(s for s in DTW if s["text"] == "100...")  # t_dtw 3.78 s, segment starts at 4.0 s
    words = segment_words(seg["text"], 4000, 6000, dtw_tokens(seg))
    assert words[0]["start_ms"] == 4000


def test_words_sharing_one_token_split_its_span():
    words = segment_words("ราคา 100 บาท", 0, 3000, [("ราคา", 500), (" 100 บาท", 1500)])
    assert [w["text"] for w in words] == ["ราคา", "100", "บาท"]
    assert words[0]["start_ms"] == 500
    assert words[1]["start_ms"] == 1500
    assert 1500 < words[2]["start_ms"] < 3000


def test_tokens_that_do_not_match_the_text_fall_back_to_the_spread():
    assert segment_words("ราคา", 0, 1000, [("ราคม", 300)]) == segment_words("ราคา", 0, 1000)
