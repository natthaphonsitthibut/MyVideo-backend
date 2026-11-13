"""Spoken Thai numbers → digits (Typhoon ASR writes numbers as words: "แปดสิบบาท", "ยี่สิบห้าจุดห้า").

Phrases come from the real Typhoon transcript of the S01a live excerpt
(spikes/e12-asr-th/results/typhoon-turbo-live.txt). Only unambiguous numbers become digits: a price must
never change value, so anything a listener could read two ways stays as words.
"""

import itertools

import pytest

from myvideo_ai.thai import numbers_to_digits, segment_words


@pytest.mark.parametrize(
    ("spoken", "written"),
    [
        # from the S01a transcript
        ("ตัวนี้รับพิมพ์รับมาแปดสิบบาทนะ", "ตัวนี้รับพิมพ์รับมา 80 บาทนะ"),
        ("หกสิบแปด ยาว ยี่สิบห้าจุดห้า", "68 ยาว 25.5"),
        ("ยาวยี่สิบเจ็ดจุดห้านะ", "ยาว 27.5 นะ"),
        ("แปดสิบเหรอ ไม่ผิด หนึ่งร้อยได้ไหม", "80 เหรอ ไม่ผิด 100 ได้ไหม"),
        # prices and sizes
        ("ราคาสามร้อยห้าสิบบาท", "ราคา 350 บาท"),
        ("หนึ่งแสนสองหมื่น", "120000"),
        ("อกสี่สิบสองนิ้ว", "อก 42 นิ้ว"),
        ("เบอร์สาม", "เบอร์ 3"),
        ("ลดเหลือห้าบาท", "ลดเหลือ 5 บาท"),
        ("สิบเปอร์เซ็นต์", "10 เปอร์เซ็นต์"),
        # L02: the same live wrote both "รอบสอง" and "รอบ 2" — one form, digits
        ("ผมจะเปิดรอบสอง", "ผมจะเปิดรอบ 2"),
    ],
)
def test_unambiguous_spoken_numbers_become_digits(spoken: str, written: str) -> None:
    assert numbers_to_digits(spoken) == written


@pytest.mark.parametrize(
    "text",
    [
        "สองสามตัว",  # "two or three" — not 23
        "ห้ามพูด",  # ห้าม (forbid) is not ห้า
        "หกน้ำ",  # หก = spill
        "จุดเด่น",  # จุด = point/spot
        "พันผ้า",  # พัน = wrap
        "ร้อยลูกปัด",  # ร้อย = thread
        "สองพันห้า",  # 2,500 in speech, 2,005 by the rules → ambiguous, keep words
        "ร้อยห้า",  # 150 or 105
        "หนึ่งในนั้น",  # "one of them"
        "ราคา 80 บาท",  # already digits
        "ยาวยี่สหา",  # ยี่ is only a number before สิบ (real Typhoon output)
    ],
)
def test_ambiguous_or_non_numbers_stay_as_words(text: str) -> None:
    assert numbers_to_digits(text) == text


def test_segment_words_merge_a_spoken_number_into_one_timed_word() -> None:
    words = segment_words("รับมาแปดสิบบาทนะ", 1000, 2000)
    texts = [w["text"] for w in words]
    assert texts == ["รับ", "มา", "80", "บาท", "นะ"]
    n = words[2]
    assert n["kind"] == "number"
    # contiguous timings still cover the segment exactly
    assert words[0]["start_ms"] == 1000 and words[-1]["end_ms"] == 2000
    assert all(a["end_ms"] == b["start_ms"] for a, b in itertools.pairwise(words))


def test_segment_words_keep_dtw_timing_of_the_first_and_last_number_word() -> None:
    # DTW tokens as whisper.cpp gives them: the number spans "ยี่" .. "ห้า" (after จุด)
    tokens = [
        ("ยาว", 1000),
        ("ยี่", 1300),
        ("สิบ", 1450),
        ("ห้า", 1600),
        ("จุด", 1750),
        ("ห้า", 1850),
        ("นะ", 1950),
    ]
    words = segment_words("ยาวยี่สิบห้าจุดห้านะ", 1000, 2100, tokens)
    assert [w["text"] for w in words] == ["ยาว", "25.5", "นะ"]
    assert words[1]["start_ms"] == 1300
    assert words[1]["end_ms"] == words[2]["start_ms"] == 1950
