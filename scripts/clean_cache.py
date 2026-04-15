#!/usr/bin/env python3
"""
Re-clean every JSON file in data/detail-cache/ with the updated
Thai-PDF normaliser in subject_detail.fix_thai_encoding.

Idempotent: running it twice yields the same output on the second run.
"""
import glob
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from subject_detail import fix_thai_encoding  # noqa: E402

PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
CACHE_DIR = os.path.join(PROJECT_DIR, "data", "detail-cache")

TEXT_FIELDS = (
    "standardRef",
    "learningOutcomes",
    "objectives",
    "competencies",
    "description",
    "courseName",
)


def clean_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"! skip {os.path.basename(path)}: {e}", file=sys.stderr)
        return False

    if not isinstance(data, dict):
        return False

    changed = False
    for k in TEXT_FIELDS:
        v = data.get(k)
        if not isinstance(v, str) or not v:
            continue
        cleaned = fix_thai_encoding(v)
        if cleaned != v:
            data[k] = cleaned
            changed = True

    if changed:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    return changed


def main():
    files = sorted(glob.glob(os.path.join(CACHE_DIR, "*.json")))
    total = len(files)
    changed = 0
    print(f"Cleaning {total} cache files in {CACHE_DIR}")
    for i, fp in enumerate(files, 1):
        if clean_file(fp):
            changed += 1
        if i % 1000 == 0:
            print(f"  [{i}/{total}] changed so far: {changed}", flush=True)
    print(f"\nDone. Updated {changed}/{total} cache entries.")


if __name__ == "__main__":
    main()
