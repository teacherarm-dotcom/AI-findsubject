#!/usr/bin/env python3
"""
Extract subjects (รายวิชา) from all VEC curriculum PDF files.
Output: data/subjects.json
"""

import json
import os
import re
import sys
import tempfile
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.filterwarnings("ignore")

# Load departments data
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DEPT_FILE = os.path.join(PROJECT_DIR, "data", "departments.json")

with open(DEPT_FILE, "r", encoding="utf-8") as f:
    dept_data = json.load(f)

PDF_BASE_URL = dept_data["pdfBaseUrl"]
departments = dept_data["departments"]

# Subject code pattern: 5 digits - 4 digits
SUBJECT_RE = re.compile(r'(\d{5})[–-](\d{4})\s+(.+?)(?:\s+(\d+[–-]\d+[–-]\d+|\*[–-]\*[–-]\d+|\d+[–-]\*[–-]\d+|\*[–-]\d+[–-]\d+))?$')
# Simpler pattern to catch code
CODE_RE = re.compile(r'(\d{5})[–-](\d{4})')
# Credit pattern: X-X-X format
CREDIT_RE = re.compile(r'(\d+|\*)[–-](\d+|\*)[–-](\d+)')


def clean_thai_name(name):
    """Fix common Thai PDF text extraction errors:
    decomposed sara am, garbled thanthakhat/mai tho, misplaced spaces."""
    # Decomposed sara am -> composed (nikhahit + sara aa -> sara am)
    name = name.replace('\u0e4d\u0e32', '\u0e33')
    name = name.replace('\u0e4d \u0e32', '\u0e33')
    # ) after Thai consonant/combining -> thanthakhat
    name = re.sub(r'([\u0e01-\u0e2e])\)', lambda m: m.group(1) + '\u0e4c', name)
    name = re.sub(r'([\u0e31\u0e34-\u0e3a\u0e47-\u0e4b])\)', lambda m: m.group(1) + '\u0e4c', name)
    # , after Thai consonant -> thanthakhat
    name = re.sub(r'([\u0e01-\u0e2e]),', lambda m: m.group(1) + '\u0e4c', name)
    name = re.sub(r'([\u0e31\u0e34-\u0e3a\u0e47-\u0e4b]),', lambda m: m.group(1) + '\u0e4c', name)
    # 4 in Thai context -> mai tho
    name = re.sub(r'([\u0e01-\u0e2e])4([\u0e01-\u0e7f\s])', lambda m: m.group(1) + '\u0e49' + m.group(2), name)
    name = re.sub(r'([\u0e01-\u0e2e])4$', lambda m: m.group(1) + '\u0e49', name)
    # Remove space before combining marks
    name = re.sub(r'\s+([\u0e31\u0e34-\u0e3a\u0e47-\u0e4e])', lambda m: m.group(1), name)
    # Collapse double spaces + trim
    name = re.sub(r'  +', ' ', name).strip()
    return name


def download_pdf(url):
    """Download PDF to temp file."""
    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    try:
        urllib.request.urlretrieve(url, tmp.name)
        return tmp.name
    except Exception as e:
        os.unlink(tmp.name)
        return None


def extract_subjects_from_pdf(pdf_path):
    """Extract subject data from a PDF file."""
    import pdfplumber

    subjects = []
    seen_codes = set()

    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if not text:
                    continue

                lines = text.split('\n')
                i = 0
                while i < len(lines):
                    line = lines[i].strip()

                    # Look for subject code pattern
                    code_match = CODE_RE.search(line)
                    if code_match:
                        prefix = code_match.group(1)
                        suffix = code_match.group(2)
                        full_code = f"{prefix}-{suffix}"

                        if full_code in seen_codes:
                            i += 1
                            continue

                        # Extract the text after the code
                        after_code = line[code_match.end():].strip()

                        # Try to find credit (ท-ป-น) at end
                        credit_match = CREDIT_RE.search(after_code)

                        if credit_match:
                            name_th = after_code[:credit_match.start()].strip()
                            credit = credit_match.group(0)
                        else:
                            name_th = after_code
                            credit = ""

                        # Clean up name - remove English name if on same line
                        # Sometimes format is "ชื่อไทย T-P-N\nEnglish Name"

                        # Skip if name is empty or looks like a page reference
                        if not name_th or name_th.startswith('ถึง') or name_th.startswith('และ'):
                            i += 1
                            continue

                        # Skip development/placeholder entries
                        if 'รายวิชาที่สถาบัน' in name_th or 'พัฒนาเพิ่มเติม' in name_th:
                            i += 1
                            continue

                        # Check next line for English name
                        name_en = ""
                        if i + 1 < len(lines):
                            next_line = lines[i + 1].strip()
                            # English name typically starts with uppercase letter
                            if next_line and re.match(r'^[A-Z]', next_line) and not CODE_RE.search(next_line):
                                name_en = next_line
                                # If credit was on the English line
                                if not credit:
                                    cm = CREDIT_RE.search(name_en)
                                    if cm:
                                        name_en = name_en[:cm.start()].strip()

                        # Clean name_th: fix Thai garbling + trim
                        name_th = clean_thai_name(name_th)

                        if name_th and len(name_th) > 1:
                            seen_codes.add(full_code)
                            subjects.append({
                                "code": full_code,
                                "nameTh": name_th,
                                "nameEn": name_en,
                                "credit": credit
                            })

                    i += 1
    except Exception as e:
        print(f"  Error reading PDF: {e}", file=sys.stderr)

    return subjects


def process_department(dept):
    """Download PDF and extract subjects for one department."""
    pdf_url = PDF_BASE_URL + dept["pdf"]
    dept_code = dept["code"]
    dept_name = dept["name"]
    dept_level = dept["level"]

    print(f"  [{dept_level}] {dept_code} {dept_name}...", flush=True)

    pdf_path = download_pdf(pdf_url)
    if not pdf_path:
        print(f"    ✗ Download failed", flush=True)
        return dept_code, []

    try:
        subjects = extract_subjects_from_pdf(pdf_path)
        print(f"    ✓ {len(subjects)} subjects found", flush=True)
        return dept_code, subjects
    finally:
        os.unlink(pdf_path)


def main():
    print(f"Starting extraction from {len(departments)} departments...")
    print()

    all_subjects = {}
    failed = []

    # Process sequentially to avoid hammering the server
    for i, dept in enumerate(departments):
        print(f"[{i+1}/{len(departments)}]", end="", flush=True)
        dept_code, subjects = process_department(dept)

        if subjects:
            all_subjects[dept_code] = subjects
        else:
            failed.append(dept_code)

    # Build output
    output = {
        "extractedAt": __import__('datetime').datetime.now().isoformat(),
        "totalDepartments": len(departments),
        "departmentsWithSubjects": len(all_subjects),
        "totalSubjects": sum(len(s) for s in all_subjects.values()),
        "subjects": all_subjects
    }

    # Save
    out_file = os.path.join(PROJECT_DIR, "data", "subjects.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print()
    print(f"Done! Extracted {output['totalSubjects']} subjects from {output['departmentsWithSubjects']} departments")
    print(f"Failed: {len(failed)} departments")
    if failed:
        print(f"Failed codes: {', '.join(failed)}")
    print(f"Output saved to: {out_file}")


if __name__ == "__main__":
    main()
