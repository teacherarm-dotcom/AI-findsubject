#!/usr/bin/env python3
"""
Dictionary-assisted second-pass cleanup for Thai curriculum text
after fix_thai_encoding has done PUA/reorder normalisation.

Handles the residual issues:
  1. Stray glyph-cluster space in the middle of a word
     ("ป้อ งกัน" -> "ป้องกัน", "อุบัติ เหตุ" -> "อุบัติเหตุ").
  2. Duplicate phrases from PDF rendering quirks
     ("เกี่ยวกับเกี่ยวกับ" -> "เกี่ยวกับ").
  3. Misplaced word-end thanthakhat
     ("อุปกรณป์" -> "อุปกรณ์ป").

Uses pythainlp's Thai word dictionary (~62k words) + a small custom
vocational vocabulary harvested from subjects.json.

All transformations are guarded by "merged form is in dictionary" —
so we never invent words that aren't there.
"""
import json
import os
import re
from functools import lru_cache

from pythainlp.corpus import thai_words
from pythainlp.tokenize import word_tokenize

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

# ----- build the reference dictionary -----
_DICT = set(thai_words())

# Harvest extra vocational tokens from clean subject names
_VOCAB_CUSTOM_PATH = os.path.join(PROJECT_DIR, "data", "vocab_custom.json")


def _load_custom_vocab():
    if os.path.exists(_VOCAB_CUSTOM_PATH):
        try:
            with open(_VOCAB_CUSTOM_PATH, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except Exception:
            pass
    return set()


_DICT |= _load_custom_vocab()


# ---------- 1. merge split words ----------
def merge_split_words(text):
    """Merge 'A B' where last_token(A) + first_token(B) is a dict word."""
    if not text or " " not in text:
        return text

    parts = re.split(r"( +)", text)
    if len(parts) < 3:
        return text

    current = parts[0]
    i = 1
    while i + 1 < len(parts):
        sp = parts[i]
        nxt = parts[i + 1]

        if sp.strip() != "" or not nxt:
            current += sp + nxt
            i += 2
            continue

        if re.search(r"[\u0e01-\u0e7f]$", current) and re.match(r"^[\u0e01-\u0e7f]", nxt):
            m_tail = re.search(r"([\u0e01-\u0e7f]+)$", current)
            m_head = re.match(r"([\u0e01-\u0e7f]+)", nxt)
            tail = m_tail.group(1) if m_tail else ""
            head = m_head.group(1) if m_head else ""

            # Fragment guard: only merge when at least one side is NOT a
            # standalone dictionary word. If both sides are valid words,
            # the space is probably a legitimate word boundary (e.g. a
            # list separator like "กฎ ระเบียบ"), not a PDF-induced break.
            def _is_fragment_pair(a, b):
                return (a not in _DICT) or (b not in _DICT)

            # Direct full-tail + full-head merge
            if (
                len(tail) >= 2
                and len(head) >= 1
                and (tail + head) in _DICT
                and _is_fragment_pair(tail, head)
            ):
                current += nxt
                i += 2
                continue

            # Last-token(tail) + first-token(head) merge
            if tail and head:
                tail_tok = _cached_tokenize(tail)
                head_tok = _cached_tokenize(head)
                if tail_tok and head_tok:
                    last = tail_tok[-1]
                    first = head_tok[0]
                    if (
                        len(last) >= 1
                        and len(first) >= 1
                        and (last + first) in _DICT
                        and _is_fragment_pair(last, first)
                    ):
                        current += nxt
                        i += 2
                        continue

        current += sp + nxt
        i += 2

    return current


@lru_cache(maxsize=4096)
def _cached_tokenize(s):
    return tuple(word_tokenize(s, engine="newmm"))


# ---------- 2. deduplicate consecutive repeated runs ----------
def dedupe_repeats(text):
    """'เกี่ยวกับเกี่ยวกับ' -> 'เกี่ยวกับ'."""
    if not text:
        return text
    tokens = word_tokenize(text, engine="newmm")
    if len(tokens) < 2:
        return text

    out = []
    i = 0
    while i < len(tokens):
        matched = False
        # prefer LONGER runs first so we catch phrase-level repeats
        max_w = min(6, (len(tokens) - i) // 2)
        for w in range(max_w, 0, -1):
            if tokens[i : i + w] == tokens[i + w : i + 2 * w]:
                # collapse only if the run contains at least one Thai char
                run = "".join(tokens[i : i + w])
                if re.search(r"[\u0e01-\u0e7f]", run):
                    out.extend(tokens[i : i + w])
                    i += 2 * w
                    matched = True
                    break
        if not matched:
            out.append(tokens[i])
            i += 1
    return "".join(out)


# ---------- 3. fix misplaced word-end thanthakhat ----------
_THANTHAKHAT_RE = re.compile(
    r"([\u0e01-\u0e2e])([\u0e01-\u0e2e])\u0e4c(?=[\u0e01-\u0e7f\s]|$)"
)


def fix_misplaced_thanthakhat(text):
    """'...ณป์' -> '...ณ์ป' when ณ์ (or similar) is a valid word-end."""
    if "\u0e4c" not in text:
        return text

    def swap(m):
        c1 = m.group(1)
        c2 = m.group(2)
        # Look back at the surrounding context to see if (prefix+c1+์)
        # is a dictionary word.
        start = m.start()
        # scan left up to 12 chars for word start
        left_text = text[max(0, start - 12) : start]
        m_word = re.search(r"[\u0e01-\u0e7f]+$", left_text)
        prefix = m_word.group(0) if m_word else ""
        candidate_word = prefix + c1 + "\u0e4c"
        toks = _cached_tokenize(candidate_word)
        if toks and toks[-1] in _DICT:
            return c1 + "\u0e4c" + c2
        return m.group(0)

    return _THANTHAKHAT_RE.sub(swap, text)


# ---------- umbrella ----------
def fix_thai_spacing(text):
    """Apply all three passes in sequence. Idempotent."""
    if not text:
        return text
    text = fix_misplaced_thanthakhat(text)
    text = merge_split_words(text)
    text = dedupe_repeats(text)
    return text


if __name__ == "__main__":
    # Simple CLI self-test
    import sys

    if len(sys.argv) > 1:
        print(fix_thai_spacing(sys.argv[1]))
    else:
        samples = [
            "วางแผนการควบคุมป้อ งกันโรคและอุบัติ เหตุที่ เกิดจากการทำงาน",
            "เข้าใจเกี่ยวกับเกี่ยวกับ หลักสุขภาพความปลอดภัยและสิ่ง แวดล้อม",
            "เลือกใช้อุปกรณป์้องกันภัยส่วนบุคคล",
        ]
        for s in samples:
            print("ORIG:", s)
            print("FIX :", fix_thai_spacing(s))
            print()
