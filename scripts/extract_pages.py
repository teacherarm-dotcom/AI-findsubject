#!/usr/bin/env python3
"""
Extract PDF page numbers for all subjects in all department PDFs.
Output: data/pages.json  →  { "21701": { "20000-1101": 9, ... }, ... }

Runs concurrent downloads for speed.
"""

import json
import os
import re
import sys
import tempfile
import time
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.filterwarnings("ignore")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DEPT_FILE = os.path.join(PROJECT_DIR, "data", "departments.json")
SUBJECTS_FILE = os.path.join(PROJECT_DIR, "data", "subjects.json")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "data", "pages.json")

CODE_RE = re.compile(r'(\d{5})\s*[–\-]\s*(\d{4})')
# Subject detail page: code followed (within ~150 chars) by a credit pattern X-Y-Z
# where X/Y/Z can be 1-2 digits or "*", and separators can be hyphen or en-dash.
SUBJECT_HEADER_RE = re.compile(
    r'(\d{5})\s*[–\-]\s*(\d{4})[\s\S]{1,150}?[\d*]{1,2}\s*[–\-]\s*[\d*]{1,2}\s*[–\-]\s*[\d*]{1,2}'
)
DETAIL_KEYWORDS = [
    'จุดประสงค',
    'สมรรถนะรายวิชา',
    'คําอธิบายรายวิชา',
    'คำอธิบายรายวิชา',
    'ผลลัพธ์การเรียนรู้',
    'อ้างอิงมาตรฐาน',
]

MAX_WORKERS = 4


def download_pdf(url, retries=3):
    for attempt in range(retries):
        tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=120) as resp:
                tmp.write(resp.read())
            tmp.close()
            return tmp.name
        except Exception:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
    return None


def extract_page_map(pdf_path, valid_codes):
    import fitz  # PyMuPDF
    pages_map = {}
    # Detail pages have 1-2 subject codes; TOC/listing pages have 10+.
    # Skip pages with too many codes to avoid mapping subjects to TOC pages.
    MAX_CODES_PER_PAGE = 3
    try:
        doc = fitz.open(pdf_path)
        try:
            # Pass 1: pages with explicit detail keywords (clean PDFs)
            for i in range(len(doc)):
                text = doc[i].get_text() or ''
                if not text.strip():
                    continue
                if not any(kw in text for kw in DETAIL_KEYWORDS):
                    continue
                page_codes = set()
                for a, b in CODE_RE.findall(text):
                    code = f"{a}-{b}"
                    if code in valid_codes:
                        page_codes.add(code)
                if len(page_codes) > MAX_CODES_PER_PAGE:
                    continue  # TOC / listing page — skip
                for code in page_codes:
                    if code not in pages_map:
                        pages_map[code] = i + 1

            # Pass 2: structural — code immediately followed by credit X-Y-Z
            # (works for PDFs whose Thai text is glyph-encoded and breaks keywords)
            for i in range(len(doc)):
                text = doc[i].get_text() or ''
                if not text.strip():
                    continue
                page_codes = set()
                for a, b in CODE_RE.findall(text):
                    code = f"{a}-{b}"
                    if code in valid_codes:
                        page_codes.add(code)
                if len(page_codes) > MAX_CODES_PER_PAGE:
                    continue  # TOC / listing page — skip
                for a, b in SUBJECT_HEADER_RE.findall(text):
                    code = f"{a}-{b}"
                    if code in valid_codes and code not in pages_map:
                        pages_map[code] = i + 1

            # Pass 3 (fallback): for subjects still unmapped, accept any page
            # where they appear — even TOC pages. Better than no mapping.
            for i in range(len(doc)):
                text = doc[i].get_text() or ''
                if not text.strip():
                    continue
                for a, b in CODE_RE.findall(text):
                    code = f"{a}-{b}"
                    if code in valid_codes and code not in pages_map:
                        pages_map[code] = i + 1
        finally:
            doc.close()
    except Exception as e:
        print(f"    Error: {e}", file=sys.stderr)
    return pages_map


def process_dept(dept, base_url, valid_codes):
    pdf_url = base_url + dept['pdf']
    pdf_path = download_pdf(pdf_url)
    if not pdf_path:
        return dept['code'], None, 'download_failed'
    try:
        pages = extract_page_map(pdf_path, valid_codes)
        return dept['code'], pages, None
    finally:
        try:
            os.unlink(pdf_path)
        except Exception:
            pass


def main():
    with open(DEPT_FILE, "r", encoding="utf-8") as f:
        dept_data = json.load(f)
    base_url = dept_data["pdfBaseUrl"]
    departments = dept_data["departments"]

    with open(SUBJECTS_FILE, "r", encoding="utf-8") as f:
        subjects_data = json.load(f)

    valid_codes = set()
    for _, subjs in subjects_data["subjects"].items():
        for s in subjs:
            valid_codes.add(s["code"])

    all_pages = {}
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if existing and not isinstance(next(iter(existing.values())), int):
                all_pages = existing
                print(f"Resuming with {sum(len(v) for v in all_pages.values())} entries", flush=True)
        except Exception:
            pass

    todo = [d for d in departments if d['code'] not in all_pages or not all_pages.get(d['code'])]
    print(f"Processing {len(todo)}/{len(departments)} departments with {MAX_WORKERS} workers...", flush=True)

    completed = 0
    total = len(todo)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(process_dept, d, base_url, valid_codes): d for d in todo}
        for fut in as_completed(futures):
            d = futures[fut]
            try:
                code, pages, err = fut.result()
            except Exception as e:
                code, pages, err = d['code'], None, str(e)
            completed += 1
            if pages is None:
                print(f"[{completed}/{total}] {code} {d['name']}  ✗ {err}", flush=True)
            else:
                all_pages[code] = pages
                print(f"[{completed}/{total}] {code} {d['name']}  ✓ {len(pages)}", flush=True)
            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                json.dump(all_pages, f, ensure_ascii=False, indent=2)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_pages, f, ensure_ascii=False, indent=2)

    total_entries = sum(len(v) for v in all_pages.values())
    print()
    print(f"Done! {len(all_pages)} depts, {total_entries} page mappings")


if __name__ == "__main__":
    main()
