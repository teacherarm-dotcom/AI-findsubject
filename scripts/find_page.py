#!/usr/bin/env python3
"""
Find PDF page number for a subject (on-demand fallback).
Usage: python3 find_page.py <subject_code> <dept_code>
Returns JSON: {"pdfPage": N, "pdfUrl": "...#page=N"}
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

with open(DEPT_FILE, "r", encoding="utf-8") as f:
    dept_data = json.load(f)
PDF_BASE_URL = dept_data["pdfBaseUrl"]

CODE_RE = re.compile(r'(\d{5})[–\-](\d{4})')
DETAIL_KEYWORDS = [
    'จุดประสงค', 'สมรรถนะรายวิชา',
    'คําอธิบายรายวิชา', 'คำอธิบายรายวิชา',
]


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: find_page.py <subject_code> <dept_code>"}))
        sys.exit(1)

    subject_code = sys.argv[1]
    dept_code = sys.argv[2]

    dept = next((d for d in dept_data["departments"] if d["code"] == dept_code), None)
    if not dept:
        print(json.dumps({"error": f"Department {dept_code} not found"}))
        sys.exit(0)

    pdf_url = PDF_BASE_URL + dept["pdf"]

    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    try:
        req = urllib.request.Request(pdf_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            tmp.write(r.read())
        tmp.close()
    except Exception as e:
        print(json.dumps({"error": f"PDF download failed: {e}"}))
        sys.exit(0)

    try:
        import pypdfium2 as pdfium
        pdf_page = 0
        pdf = pdfium.PdfDocument(tmp.name)
        try:
            for i in range(len(pdf)):
                page = pdf[i]
                tp = page.get_textpage()
                text = tp.get_text_range() or ''
                tp.close()
                if not any(kw in text for kw in DETAIL_KEYWORDS):
                    continue
                codes = CODE_RE.findall(text)
                if not codes:
                    continue
                first = f"{codes[0][0]}-{codes[0][1]}"
                if first == subject_code:
                    pdf_page = i + 1
                    break
        finally:
            pdf.close()

        result = {
            "pdfPage": pdf_page,
            "pdfUrl": f"{pdf_url}#page={pdf_page}" if pdf_page > 0 else pdf_url
        }
        print(json.dumps(result, ensure_ascii=False))
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


if __name__ == "__main__":
    main()
