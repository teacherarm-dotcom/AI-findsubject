#!/usr/bin/env python3
"""
Extract PDF page numbers for all subjects in all department PDFs.
Output: data/pages.json  →  { "20000-1101": 9, "20101-2001": 45, ... }

Each page number is the detail page (contains จุดประสงค์/สมรรถนะ/คำอธิบาย)
for the subject in its own department's PDF.
"""

import json
import os
import re
import sys
import tempfile
import urllib.request
import warnings

warnings.filterwarnings("ignore")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DEPT_FILE = os.path.join(PROJECT_DIR, "data", "departments.json")
SUBJECTS_FILE = os.path.join(PROJECT_DIR, "data", "subjects.json")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "data", "pages.json")

with open(DEPT_FILE, "r", encoding="utf-8") as f:
    dept_data = json.load(f)

PDF_BASE_URL = dept_data["pdfBaseUrl"]
departments = dept_data["departments"]

with open(SUBJECTS_FILE, "r", encoding="utf-8") as f:
    subjects_data = json.load(f)

CODE_RE = re.compile(r'(\d{5})[–\-](\d{4})')

# Keywords that indicate a detail page (not just a listing)
DETAIL_KEYWORDS = [
    'จุดประสงค', 'สมรรถนะรายวิชา',
    'คําอธิบายรายวิชา', 'คำอธิบายรายวิชา',
    'Course Objectives', 'Course Description'
]
DETAIL_KEYWORD_RE = re.compile(r'ค.{0,2}อธิบายรายวิชา')


def download_pdf(url):
    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    try:
        urllib.request.urlretrieve(url, tmp.name)
        return tmp.name
    except Exception as e:
        os.unlink(tmp.name)
        return None


def is_detail_page(text):
    """Check if page contains detail section keywords."""
    for kw in DETAIL_KEYWORDS:
        if kw in text:
            return True
    if DETAIL_KEYWORD_RE.search(text):
        return True
    return False


def extract_pages_from_pdf(pdf_path, target_codes):
    """Find detail page numbers for target subject codes in a PDF."""
    import pdfplumber

    pages_map = {}

    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if not text:
                    continue

                # Check if this is a detail page first (has section keywords)
                if not is_detail_page(text):
                    continue

                # Only check subject codes in the TOP of the page (first ~300 chars)
                # Detail pages always start with the subject code near the top
                lines = text.split('\n')
                top_text = '\n'.join(lines[:6])  # first 6 lines

                top_codes = set()
                for m in CODE_RE.finditer(top_text):
                    code = f"{m.group(1)}-{m.group(2)}"
                    if code in target_codes:
                        top_codes.add(code)

                # Assign page only to subjects whose code appears at top
                for code in top_codes:
                    if code not in pages_map:
                        pages_map[code] = page.page_number
    except Exception as e:
        print(f"    Error: {e}", file=sys.stderr)

    return pages_map


def main():
    # Build mapping: dept_code -> set of subject codes that belong to it
    dept_subjects = {}
    for dept_code, subjs in subjects_data["subjects"].items():
        codes = set(s["code"] for s in subjs)
        # Only include codes that "belong" to this dept (prefix matches)
        own_codes = set(c for c in codes if c.startswith(dept_code))
        # Also include all codes if dept is the subject's own dept
        dept_subjects[dept_code] = codes

    # Get unique dept codes that have subjects
    dept_lookup = {d["code"]: d for d in departments}

    all_pages = {}
    total_depts = len(dept_subjects)

    for i, (dept_code, target_codes) in enumerate(dept_subjects.items()):
        dept = dept_lookup.get(dept_code)
        if not dept:
            continue

        pdf_url = PDF_BASE_URL + dept["pdf"]
        print(f"[{i+1}/{total_depts}] {dept['level']} {dept_code} {dept['name']} ({len(target_codes)} subjects)...", flush=True)

        pdf_path = download_pdf(pdf_url)
        if not pdf_path:
            print(f"  ✗ Download failed", flush=True)
            continue

        try:
            pages = extract_pages_from_pdf(pdf_path, target_codes)
            all_pages.update(pages)
            found = len(pages)
            print(f"  ✓ Found {found}/{len(target_codes)} detail pages", flush=True)
        finally:
            os.unlink(pdf_path)

    # Save
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_pages, f, ensure_ascii=False, indent=2)

    print()
    print(f"Done! Found page numbers for {len(all_pages)} subjects")
    print(f"Output saved to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
