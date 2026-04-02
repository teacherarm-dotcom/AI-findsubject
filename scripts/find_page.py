#!/usr/bin/env python3
"""
Find PDF page number (แผ่นกระดาษ) for a subject.
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


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: find_page.py <subject_code> <dept_code>"}))
        sys.exit(1)

    subject_code = sys.argv[1]
    dept_code = sys.argv[2]

    # Find department
    dept = None
    for d in dept_data["departments"]:
        if d["code"] == dept_code:
            dept = d
            break

    if not dept:
        print(json.dumps({"error": f"Department {dept_code} not found"}))
        sys.exit(0)

    pdf_url = PDF_BASE_URL + dept["pdf"]

    # Download PDF
    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    try:
        urllib.request.urlretrieve(pdf_url, tmp.name)
    except Exception as e:
        print(json.dumps({"error": f"PDF download failed: {str(e)}"}))
        sys.exit(0)

    try:
        import pdfplumber

        code_pattern = subject_code.replace("-", "[-–]")
        pdf_page = 0

        with pdfplumber.open(tmp.name) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if not text:
                    continue
                if re.search(code_pattern, text):
                    # Check if this is the detail section (not just the course listing)
                    if any(kw in text for kw in [
                        'จุดประสงค', 'สมรรถนะรายวิชา',
                        'คําอธิบายรายวิชา', 'คำอธิบายรายวิชา',
                        'อ.างอิงมาตรฐาน', 'อ0างอิงมาตรฐาน'
                    ]):
                        pdf_page = page.page_number  # 1-based
                        break

        result = {
            "pdfPage": pdf_page,
            "pdfUrl": f"{pdf_url}#page={pdf_page}" if pdf_page > 0 else pdf_url
        }
        print(json.dumps(result, ensure_ascii=False))

    finally:
        os.unlink(tmp.name)


if __name__ == "__main__":
    main()
