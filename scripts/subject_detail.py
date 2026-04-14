#!/usr/bin/env python3
"""
Extract full subject details from PDF and return as JSON.
Usage: python3 subject_detail.py <subject_code> <dept_code> [page_hint]
Returns JSON with: courseCode, courseName, credit, standardRef, learningOutcomes,
                   objectives, competencies, description, pdfPage, pdfUrl

If page_hint is provided (1-based page number), extraction only scans pages
near the hint (hint-1 .. hint+2). This dramatically speeds up extraction
for large PDFs (100+ pages) on memory-constrained servers.
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
PDF_CACHE_DIR = os.path.join(PROJECT_DIR, "data", "pdf-cache")
os.makedirs(PDF_CACHE_DIR, exist_ok=True)

with open(DEPT_FILE, "r", encoding="utf-8") as f:
    dept_data = json.load(f)
PDF_BASE_URL = dept_data["pdfBaseUrl"]

with open(SUBJECTS_FILE, "r", encoding="utf-8") as f:
    subj_data = json.load(f)


def fix_thai_encoding(text):
    result = list(text)
    for i, ch in enumerate(result):
        prev_thai = i > 0 and '\u0e00' <= result[i-1] <= '\u0e7f'
        next_thai = i + 1 < len(result) and '\u0e00' <= result[i+1] <= '\u0e7f'
        next_ch = result[i+1] if i + 1 < len(result) else ''

        if prev_thai and ch in ('&', 'P') and (next_thai or i == len(result)-1):
            result[i] = '\u0e49'
        elif prev_thai and ch == ')' and (next_thai or i == len(result)-1):
            result[i] = '\u0e4c'
        elif prev_thai and ch == '"' and next_thai:
            result[i] = '\u0e48'
        elif prev_thai and ch == 'Q':
            if next_ch in 'ง\u0e0d':
                result[i] = '\u0e31'
            elif next_thai or i == len(result)-1:
                result[i] = '\u0e49'
        elif prev_thai and ch == '@' and (next_thai or i == len(result)-1):
            result[i] = '\u0e49'
        elif prev_thai and ch == "'" and next_thai:
            result[i] = '\u0e48'
        elif prev_thai and ch == '#' and next_thai:
            result[i] = '\u0e48'
        elif prev_thai and ch == '*' and (next_thai or i == len(result)-1):
            result[i] = '\u0e4c'
        elif prev_thai and ch == '0' and next_thai:
            result[i] = '\u0e49'
        elif prev_thai and ch == '2' and next_thai:
            result[i] = '\u0e49'
        elif ch == 'q' and prev_thai and next_thai:
            result[i] = '\u0e31'
        elif ch == 't' and prev_thai and next_thai:
            result[i] = '\u0e47'
        elif ch == 'v' and prev_thai and next_thai:
            result[i] = '\u0e48'
    return ''.join(result)


def extract_details(pdf_path, subject_code, page_hint=0):
    import pdfplumber

    code_pattern = subject_code.replace("-", "[-–]")
    result = {
        "standardRef": "-",
        "learningOutcomes": "",
        "objectives": "",
        "competencies": "",
        "description": "",
        "pdfPage": 0
    }

    with pdfplumber.open(pdf_path) as pdf:
        found = False
        full_text = ""
        total_pages = len(pdf.pages)

        # Build candidate pages list: try hint window first, then fallback to all
        candidate_pages = []
        if page_hint and 1 <= page_hint <= total_pages:
            # Try hint-1..hint+2 first (0-indexed: hint-2..hint+1)
            hint_idx = page_hint - 1
            for offset in (0, 1, -1, 2):
                idx = hint_idx + offset
                if 0 <= idx < total_pages and idx not in candidate_pages:
                    candidate_pages.append(idx)

        # If no hint or hint window didn't find it, fall back to all pages
        fallback_pages = [i for i in range(total_pages) if i not in candidate_pages]
        all_candidates = candidate_pages + fallback_pages

        for idx in all_candidates:
            page = pdf.pages[idx]
            text = page.extract_text()
            if not text:
                continue
            if re.search(code_pattern, text):
                if any(kw in text for kw in [
                    'อ.างอิงมาตรฐาน', 'อ0างอิงมาตรฐาน',
                    'จุดประสงค', 'สมรรถนะรายวิชา',
                    'คําอธิบายรายวิชา', 'คำอธิบายรายวิชา',
                    'Course Objectives'
                ]) or re.search(r'ค.{0,2}อธิบายรายวิชา', text):
                    found = True
                    full_text = text
                    result["pdfPage"] = page.page_number
                    next_idx = idx + 1
                    if next_idx < total_pages:
                        next_text = pdf.pages[next_idx].extract_text()
                        if next_text and not re.search(r'\d{5}[-–]\d{4}', next_text[:50]):
                            full_text += "\n" + next_text
                    break

        if not found:
            return result

        full_text = fix_thai_encoding(full_text)

        sections = {
            'standardRef': [],
            'learningOutcomes': [],
            'objectives': [],
            'competencies': [],
            'description': []
        }
        current_section = None

        for line in full_text.split('\n'):
            line_stripped = line.strip()
            if not line_stripped:
                continue

            if re.search(r'อ.างอิงมาตรฐาน', line_stripped):
                current_section = 'standardRef'
                continue
            elif re.search(r'ผลลัพธ.การเรียนรู.ระดับรายวิชา', line_stripped):
                current_section = 'learningOutcomes'
                continue
            elif re.search(r'จุดประสงค.รายวิชา', line_stripped):
                current_section = 'objectives'
                continue
            elif re.search(r'สมรรถนะรายวิชา', line_stripped):
                current_section = 'competencies'
                continue
            elif re.search(r'ค.{0,2}อธิบายรายวิชา', line_stripped):
                current_section = 'description'
                continue
            # English patterns
            elif 'Course Objectives' in line_stripped:
                current_section = 'objectives'
                continue
            elif 'Course Competencies' in line_stripped:
                current_section = 'competencies'
                continue
            elif 'Course Description' in line_stripped:
                current_section = 'description'
                continue
            elif 'Learning Outcome' in line_stripped:
                current_section = 'learningOutcomes'
                continue

            if current_section and re.match(r'\d{5}[-–]\d{4}', line_stripped):
                break
            if re.match(r'^\d+$', line_stripped):
                continue
            if 'หลักสูตรประกาศนียบัตร' in line_stripped:
                continue
            if 'สาขาวิชา' in line_stripped and len(line_stripped) > 30:
                continue

            if current_section and line_stripped:
                sections[current_section].append(line_stripped)

        result['standardRef'] = '\n'.join(sections['standardRef']).strip() or '-'
        result['learningOutcomes'] = '\n'.join(sections['learningOutcomes']).strip()
        result['objectives'] = '\n'.join(sections['objectives']).strip()
        result['competencies'] = '\n'.join(sections['competencies']).strip()
        result['description'] = '\n'.join(sections['description']).strip()

    return result


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: subject_detail.py <subject_code> <dept_code>"}))
        sys.exit(1)

    subject_code = sys.argv[1]
    dept_code = sys.argv[2]
    page_hint = 0
    if len(sys.argv) >= 4:
        try:
            page_hint = int(sys.argv[3])
        except ValueError:
            page_hint = 0

    # Find department
    dept = None
    for d in dept_data["departments"]:
        if d["code"] == dept_code:
            dept = d
            break

    if not dept:
        print(json.dumps({"error": f"Department {dept_code} not found"}))
        sys.exit(0)

    # Find subject
    subject = None
    subjects = subj_data["subjects"].get(dept_code, [])
    for s in subjects:
        if s["code"] == subject_code:
            subject = s
            break

    if not subject:
        print(json.dumps({"error": f"Subject {subject_code} not found in {dept_code}"}))
        sys.exit(0)

    pdf_url = PDF_BASE_URL + dept["pdf"]

    # Use cached PDF if available, otherwise download + cache
    cached_pdf = os.path.join(PDF_CACHE_DIR, f"{dept_code}.pdf")
    if not os.path.exists(cached_pdf) or os.path.getsize(cached_pdf) < 1024:
        try:
            req = urllib.request.Request(pdf_url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; ai-findsubject/1.0)'
            })
            with urllib.request.urlopen(req, timeout=60) as response:
                with open(cached_pdf, 'wb') as f:
                    f.write(response.read())
        except Exception as e:
            # Remove incomplete cache file
            if os.path.exists(cached_pdf):
                try: os.unlink(cached_pdf)
                except: pass
            print(json.dumps({"error": f"PDF download failed: {str(e)}"}))
            sys.exit(0)

    try:
        details = extract_details(cached_pdf, subject_code, page_hint)

        output = {
            "success": True,
            "courseCode": subject["code"],
            "courseName": subject.get("nameTh", ""),
            "courseNameEn": subject.get("nameEn", ""),
            "credit": subject.get("credit", ""),
            "deptName": dept["name"],
            "level": dept["level"],
            "standardRef": details["standardRef"],
            "learningOutcomes": details["learningOutcomes"],
            "objectives": details["objectives"],
            "competencies": details["competencies"],
            "description": details["description"],
            "pdfPage": details["pdfPage"],
            "pdfUrl": f"{pdf_url}#page={details['pdfPage']}" if details["pdfPage"] > 0 else pdf_url
        }
        print(json.dumps(output, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": f"Extraction failed: {str(e)}"}))
        sys.exit(0)


if __name__ == "__main__":
    main()
