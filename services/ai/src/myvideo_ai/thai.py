"""Thai text normalisation and word segmentation for transcripts (E04-F03).

Word boundaries come from pythainlp `newmm` (chosen over Intl.Segmenter in E01-F04). Numbers, prices and Latin
words are protected from the Thai segmenter. Word timings are spread over the segment by grapheme count:
whisper.cpp's own token timestamps are unreliable for Thai (E04-F02), its segment times are not.
"""

import re
import unicodedata

from pythainlp.tokenize import word_tokenize

_ZERO_WIDTH = re.compile("[​‌‍⁠﻿]")
_SPACES = re.compile(r"[\s\u00a0]+")
# protected chunks: prices/numbers (with ฿, separators, %), Latin words (with digits/apostrophes), Thai runs
_CHUNK = re.compile(r"(฿?\d[\d,.:]*%?)|([A-Za-z][A-Za-z0-9'\u2019\-]*)|([฀-๿]+)|(\S)")
_NUMBER = re.compile(r"^฿?\d[\d,.:]*%?$")
_REPEAT = "ๆ"


def normalize_text(text: str) -> str:
    t = unicodedata.normalize("NFC", text)
    t = _ZERO_WIDTH.sub("", t)
    t = t.replace("ํา", "ำ")  # decomposed sara am → sara am
    return _SPACES.sub(" ", t).strip()


def graphemes(text: str) -> list[str]:
    """User-perceived characters: a base character plus its combining marks (never split a cluster)."""
    out: list[str] = []
    for ch in text:
        if out and unicodedata.category(ch) in ("Mn", "Me"):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def kind_of(word: str) -> str:
    if _NUMBER.match(word):
        return "number"
    if re.match(r"[A-Za-z]", word):
        return "latin"
    if re.search("[฀-๿]", word):
        return "th"
    return "punct"


def _pieces(text: str) -> list[tuple[str, bool]]:
    """Display words of a normalised text, each with whether a space preceded it in the text."""
    t = normalize_text(text)
    words: list[tuple[str, bool]] = []
    for m in _CHUNK.finditer(t):
        number, latin, thai, other = m.groups()
        spaced = m.start() > 0 and t[m.start() - 1] == " "
        if thai:
            for i, tok in enumerate(word_tokenize(thai, engine="newmm", keep_whitespace=False)):
                if tok == _REPEAT and words:
                    words[-1] = (words[-1][0] + tok, words[-1][1])
                elif tok:
                    words.append((tok, spaced and i == 0))
        elif number or latin:
            words.append((number or latin, spaced))
        elif other:
            # punctuation and symbols ride on the previous word (no timing of their own)
            if words and not spaced:
                words[-1] = (words[-1][0] + other, words[-1][1])
            else:
                words.append((other, spaced))
    return words


def split_words(text: str) -> list[str]:
    """Display words of a normalised text, without spaces."""
    return [w for w, _ in _pieces(text)]


# --- spoken numbers → digits (Typhoon ASR writes "แปดสิบบาท", "ยี่สิบห้าจุดห้า") ---------------------------
_DIGIT_WORDS = {
    "หนึ่ง": 1, "เอ็ด": 1, "สอง": 2, "ยี่": 2, "สาม": 3, "สี่": 4, "ห้า": 5, "หก": 6, "เจ็ด": 7, "แปด": 8, "เก้า": 9,
}  # fmt: skip
_DECIMAL_WORDS = {**_DIGIT_WORDS, "ศูนย์": 0}
_NUMERAL_PIECE = re.compile(r"^(หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน)+$")
_HAS_DIGIT = re.compile("หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า")
_HAS_POWER = re.compile("สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน")
# "สองพันห้า" is 2,500 in speech but 2,005 by the rules; "ร้อยห้า" 150 or 105 → never guess a price
_AMBIGUOUS_TAIL = re.compile("(ร้อย|พัน|หมื่น|แสน|ล้าน)(หนึ่ง|เอ็ด|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า)$")
# a lone digit word ("ห้า") or power word ("ร้อย") is a number only next to a unit or after a measure word
_UNITS = {
    "บาท", "ตัว", "ชิ้น", "นิ้ว", "เปอร์เซ็นต์", "%", "โล", "กิโล", "กรัม", "เซน", "เซนติเมตร", "ซม", "เมตร",
    "ปี", "วัน", "เดือน", "ชั่วโมง", "นาที", "วินาที", "คู่", "ใบ", "อัน", "แพ็ค", "กล่อง", "ขวด", "ชุด", "เส้น",
}  # fmt: skip
_MEASURES = {"เบอร์", "ยาว", "อก", "เอว", "สะโพก", "ราคา", "ไซซ์", "ไซส์", "ไซ", "ลด", "เหลือ", "ลดเหลือ"}


def _number_groups(words: list[str]) -> list[tuple[int, int, str]]:
    """(first, last, digits) for every unambiguous spoken number in `words` (inclusive word indexes)."""
    from pythainlp.util import thaiword_to_num

    out: list[tuple[int, int, str]] = []
    i = 0
    while i < len(words):
        if not _NUMERAL_PIECE.match(words[i]):
            i += 1
            continue
        j = i
        while j + 1 < len(words) and _NUMERAL_PIECE.match(words[j + 1]):
            j += 1
        joined = "".join(words[i : j + 1])
        # decimal part: จุด + one or more single digit words
        k = j + 1
        decimals = ""
        if k < len(words) and words[k] == "จุด":
            while k + 1 < len(words) and words[k + 1] in _DECIMAL_WORDS:
                k += 1
                decimals += str(_DECIMAL_WORDS[words[k]])
        last = k if decimals else j
        nxt = words[last + 1] if last + 1 < len(words) else ""
        prev = words[i - 1] if i > 0 else ""
        has_digit, has_power = bool(_HAS_DIGIT.search(joined)), bool(_HAS_POWER.search(joined))
        try:
            value = thaiword_to_num(joined)
        except ValueError:
            value = None
        # a lone word is a number only if it is a whole one ("ห้า", "ร้อย") — never "ยี่"/"เอ็ด" alone
        lone = j == i and words[i] not in ("ยี่", "เอ็ด") and (nxt in _UNITS or prev in _MEASURES)
        ok = value is not None and not _AMBIGUOUS_TAIL.search(joined)
        ok = ok and ((has_digit and has_power) or bool(decimals) or lone)
        if ok:
            out.append((i, last, f"{value}.{decimals}" if decimals else str(value)))
            i = last + 1
        else:
            i = j + 1
    return out


def numbers_to_digits(text: str) -> str:
    """Normalised text with unambiguous spoken Thai numbers written as digits ("แปดสิบบาท" → "80 บาท")."""
    pieces = _pieces(text)
    groups = {g[0]: g for g in _number_groups([w for w, _ in pieces])}
    out: list[tuple[str, bool]] = []  # (text, space before)
    after_number = False
    i = 0
    while i < len(pieces):
        if i in groups:
            _, last, digits = groups[i]
            out.append((digits, True))
            after_number = True
            i = last + 1
            continue
        word, spaced = pieces[i]
        out.append((word, spaced or after_number))
        after_number = False
        i += 1
    return "".join((" " if sp and n else "") + w for n, (w, sp) in enumerate(out))


def _squash(text: str) -> str:
    return normalize_text(text).replace(" ", "")


def _dtw_starts(
    words: list[str], start_ms: int, end_ms: int, tokens: list[tuple[str, int]]
) -> list[int] | None:
    """Word start times from DTW token times, or None when the tokens cannot be aligned to the words.

    Character offsets are counted on the normalised, space-free text (what the words are cut from). Token k
    covers characters [b_k, b_k+1) and starts at its DTW time (clamped into the segment, made monotonic); a
    character inside a token is interpolated towards the next token's time, so several words in one token
    still get distinct starts. A word starts at the time of its first character.
    """
    full = "".join(words)
    bounds = [0]
    prefix = ""
    for text, _ in tokens:
        prefix += text
        bounds.append(max(bounds[-1], len(_squash(prefix))))
    if bounds[-1] != len(full) or _squash("".join(t for t, _ in tokens)) != full:
        return None
    times: list[int] = []
    for _, t in tokens:
        times.append(min(max(t, start_ms, times[-1] if times else start_ms), end_ms))
    times.append(end_ms)

    def at(c: int) -> int:
        for k in range(len(tokens)):
            if bounds[k] <= c < bounds[k + 1]:
                t0, t1 = times[k], times[k + 1]
                return t0 + round((t1 - t0) * (c - bounds[k]) / (bounds[k + 1] - bounds[k]))
        return end_ms

    starts: list[int] = []
    offset = 0
    for w in words:
        starts.append(at(offset))
        offset += len(w)
    # every word keeps at least 1 ms and the last one ends at end_ms
    n = len(starts)
    for i in range(n):
        lo = starts[i - 1] + 1 if i else start_ms
        starts[i] = min(max(starts[i], lo), end_ms - (n - i))
    if starts[0] < start_ms:
        return None
    return starts


def segment_words(
    text: str, start_ms: int, end_ms: int, tokens: list[tuple[str, int]] | None = None
) -> list[dict]:
    """Words with contiguous, monotonic timings ending at end_ms.

    With DTW `tokens` (text, ms) each word starts when it is spoken (the first word may start after
    start_ms). Without them — or if they do not line up with the text — timings are spread over
    [start_ms, end_ms] by grapheme count and cover it exactly.
    """
    return _merge_numbers(_timed_words(text, start_ms, end_ms, tokens))


def _merge_numbers(words: list[dict]) -> list[dict]:
    """Spoken numbers become one digit word timed from its first to its last spoken word."""
    groups = {g[0]: g for g in _number_groups([w["text"] for w in words])}
    out: list[dict] = []
    i = 0
    while i < len(words):
        if i in groups:
            _, last, digits = groups[i]
            out.append(
                {
                    "text": digits,
                    "start_ms": words[i]["start_ms"],
                    "end_ms": words[last]["end_ms"],
                    "kind": "number",
                }
            )
            i = last + 1
        else:
            out.append(words[i])
            i += 1
    return out


def _timed_words(text: str, start_ms: int, end_ms: int, tokens: list[tuple[str, int]] | None) -> list[dict]:
    words = split_words(text)
    if not words:
        return []
    if tokens and end_ms - start_ms >= len(words):
        starts = _dtw_starts(words, start_ms, end_ms, tokens)
        if starts is not None:
            ends = [*starts[1:], end_ms]
            return [
                {"text": w, "start_ms": s, "end_ms": e, "kind": kind_of(w)}
                for w, s, e in zip(words, starts, ends, strict=True)
            ]
    weights = [max(1, len([g for g in graphemes(w) if not g.isspace()])) for w in words]
    total = sum(weights)
    span = max(end_ms - start_ms, len(words))  # at least 1 ms per word
    out: list[dict] = []
    acc = 0
    prev = start_ms
    for i, (w, wt) in enumerate(zip(words, weights, strict=True)):
        acc += wt
        end = start_ms + round(span * acc / total) if i < len(words) - 1 else start_ms + span
        end = max(end, prev + 1)
        out.append({"text": w, "start_ms": prev, "end_ms": end, "kind": kind_of(w)})
        prev = end
    if out[-1]["end_ms"] != end_ms and end_ms - start_ms >= len(words):
        out[-1]["end_ms"] = end_ms
    return out
