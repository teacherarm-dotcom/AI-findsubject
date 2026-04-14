#!/usr/bin/env python3
"""
Fill empty detail-cache files with content from the canonical dept's cache.

Many subject codes appear in multiple dept PDFs, but the actual details only
live in ONE dept's PDF (the "owner" dept, typically matching the code prefix).
So when we batch-extract (code, dept) for every dept that lists the subject,
most come back empty.

This script:
1. Groups all cache files by subject code
2. For each code, picks the cache with the most content as "canonical"
3. Copies that content (competencies, description, etc.) into all empty
   cache files for the same code — keeping dept-specific fields (deptName,
   level) intact
"""

import json
import os
import glob
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
CACHE_DIR = os.path.join(PROJECT_DIR, "data", "detail-cache")


def content_score(d):
    """Higher = more content. We prefer files with descriptions + competencies."""
    s = 0
    s += len(d.get("description", "") or "")
    s += len(d.get("competencies", "") or "")
    s += len(d.get("objectives", "") or "")
    s += len(d.get("learningOutcomes", "") or "")
    return s


def main():
    files_by_code = defaultdict(list)
    for path in glob.glob(os.path.join(CACHE_DIR, "*.json")):
        fname = os.path.basename(path)
        # filename format: <code>_<dept>.json — split on LAST underscore
        base = fname[:-5]  # strip .json
        last_us = base.rfind("_")
        if last_us < 0:
            continue
        code = base[:last_us]
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        files_by_code[code].append((path, data))

    filled = 0
    still_empty = 0
    already_good = 0

    for code, items in files_by_code.items():
        items.sort(key=lambda x: content_score(x[1]), reverse=True)
        best = items[0][1]
        best_score = content_score(best)

        if best_score == 0:
            # No cache for this code has any content — nothing to do
            still_empty += len(items)
            continue

        # Copy content fields from best into empty siblings
        content_fields = ["standardRef", "learningOutcomes", "objectives",
                          "competencies", "description", "pdfPage", "pdfUrl"]

        for path, data in items:
            if content_score(data) > 0:
                already_good += 1
                continue
            # Preserve dept-specific fields, overwrite content
            for field in content_fields:
                if field in best:
                    data[field] = best[field]
            # Mark that this came from canonical dept
            data["canonicalDept"] = best.get("deptName") or ""
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            filled += 1

    print(f"Filled: {filled}")
    print(f"Already had content: {already_good}")
    print(f"Still empty (no canonical): {still_empty}")
    print(f"Total codes processed: {len(files_by_code)}")


if __name__ == "__main__":
    main()
