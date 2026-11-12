from myvideo_ai.asr import decode_flags
from myvideo_ai.eval_asr import corpus_cer, edit_distance, norm, timing_sanity, wav_ms


def test_norm_matches_e01_rules():
    # NFC, lower-case, no whitespace / punctuation / symbols (spikes/e01-asr/bench.py)
    assert norm("ราคา 100 บาท!") == "ราคา100บาท"
    assert norm("iPhone 15, ใหม่ๆ") == "iphone15ใหม่ๆ"  # ๆ is a letter-modifier, kept
    assert norm("ไลฟ์สด") == "ไลฟ์สด"


def test_edit_distance():
    assert edit_distance("", "") == 0
    assert edit_distance("abc", "abc") == 0
    assert edit_distance("ไลฟ์สด", "ไลฟสด") == 1  # a dropped ์ is one deletion
    assert edit_distance("kitten", "sitting") == 3
    assert edit_distance("", "abc") == 3


def test_corpus_cer_sums_edits_over_reference_chars():
    refs = ["ไลฟ์สด", "ราคา 100 บาท"]
    hyps = ["ไลฟสด", "ราคา 100 บาท"]
    # 1 edit over 6 + 10 normalised reference code points ("ราคา100บาท")
    assert corpus_cer(refs, hyps) == 1 / 16
    assert corpus_cer(["ab"], [""]) == 1.0


def test_timing_sanity_against_known_speech_spans():
    spans = [(1000, 4000), (6000, 9000)]
    good = [(1100, 3900), (6050, 8800)]
    report = timing_sanity(good, spans)
    assert report["segments"] == 2
    assert report["midpoints_in_speech"] == 1.0
    assert report["crossing_pauses"] == 0
    assert report["median_start_error_ms"] == 75
    bad = [(1000, 7000), (8000, 8500)]  # first one swallows the pause
    r2 = timing_sanity(bad, spans)
    assert r2["crossing_pauses"] == 1


def test_wav_ms_reads_float_and_pcm_headers(tmp_path):
    import struct

    def wav(fmt_tag: int, bits: int, rate: int, seconds: float) -> bytes:
        block = bits // 8
        data = b"\0" * int(rate * seconds) * block
        fmt = struct.pack("<HHIIHH", fmt_tag, 1, rate, rate * block, block, bits)
        body = (
            b"WAVE"
            + b"fmt "
            + struct.pack("<I", len(fmt))
            + fmt
            + b"data"
            + struct.pack("<I", len(data))
            + data
        )
        return b"RIFF" + struct.pack("<I", len(body)) + body

    (tmp_path / "f.wav").write_bytes(wav(3, 32, 16000, 1.5))  # IEEE float, like FLEURS
    (tmp_path / "p.wav").write_bytes(wav(1, 16, 16000, 2.0))
    assert wav_ms(tmp_path / "f.wav") == 1500
    assert wav_ms(tmp_path / "p.wav") == 2000


def test_decode_flags_switch_builtin_vad():
    assert decode_flags(True, "/m/vad.bin") == [
        "-mc",
        "0",
        "-sns",
        "--vad",
        "-vmsd",
        "30",
        "-vm",
        "/m/vad.bin",
    ]
    assert decode_flags(False, "/m/vad.bin") == ["-mc", "0", "-sns"]
