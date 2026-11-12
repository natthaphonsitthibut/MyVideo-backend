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


def split_words(text: str) -> list[str]:
    """Display words of a normalised text, without spaces."""
    words: list[str] = []
    for m in _CHUNK.finditer(normalize_text(text)):
        number, latin, thai, other = m.groups()
        if thai:
            for tok in word_tokenize(thai, engine="newmm", keep_whitespace=False):
                if tok == _REPEAT and words:
                    words[-1] += tok
                elif tok:
                    words.append(tok)
        elif number or latin:
            words.append(number or latin)
        elif other:
            # punctuation and symbols ride on the previous word (no timing of their own)
            if words:
                words[-1] += other
            else:
                words.append(other)
    return words


def segment_words(text: str, start_ms: int, end_ms: int) -> list[dict]:
    """Words with contiguous, monotonic timings covering [start_ms, end_ms] exactly."""
    words = split_words(text)
    if not words:
        return []
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
