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


# ------------------------------------------------------------------
# Thai PDF-extraction cleanup.
#
# VEC curriculum PDFs are rendered with a custom Thai font whose
# combining marks live in the Private Use Area (U+F700–U+F71F) and
# whose glyph stream preserves VISUAL order rather than Unicode
# logical order. Extracted text therefore shows:
#   1. PUA garble chars where tone marks / vowels should be.
#   2. Upper vowels / tone marks placed AFTER the next consonant
#      (e.g. "สิ่ง" -> "สงิ่", "กับ" -> "กบั").
#   3. Decomposed sara am (นิคหิต + สระอา) where "ำ" should be.
#   4. Stray ASCII chars (P Q ) , 4 ...) left over from older fonts.
#   5. Spurious spaces before combining marks.
# ------------------------------------------------------------------

# PUA → Thai combining mark mapping (determined empirically from
# thousands of curriculum-PDF samples; see scripts/build_pua_map.py
# / cache analysis).
PUA_MAP = {
    '\uf700': '\u0e48',  # mai ek
    '\uf701': '\u0e34',  # sara i
    '\uf702': '\u0e35',  # sara ii
    '\uf703': '\u0e36',  # sara ue
    '\uf704': '\u0e37',  # sara uee
    '\uf705': '\u0e48',  # mai ek (tall variant)
    '\uf706': '\u0e49',  # mai tho (tall variant)
    '\uf707': '\u0e4a',  # mai tri (tall variant)
    '\uf708': '\u0e4b',  # mai chattawa (tall variant)
    '\uf709': '\u0e4c',  # thanthakhat (tall variant)
    '\uf70a': '\u0e48',  # mai ek
    '\uf70b': '\u0e49',  # mai tho
    '\uf70c': '\u0e4a',  # mai tri
    '\uf70d': '\u0e4b',  # mai chattawa
    '\uf70e': '\u0e4c',  # thanthakhat
    '\uf70f': '\u0e4d',  # nikhahit
    '\uf710': '\u0e31',  # mai han akat
    '\uf711': '\u0e34',  # sara i (variant)
    '\uf712': '\u0e47',  # mai taikhu
    '\uf713': '\u0e48',  # mai ek (variant)
    '\uf714': '\u0e49',  # mai tho (stacked above sara uee)
    '\uf715': '\u0e4a',  # mai tri (stacked above mai han)
    '\uf716': '\u0e4b',  # mai chattawa (stacked)
    '\uf717': '\u0e4c',  # thanthakhat (stacked)
    '\uf718': '\u0e4d',  # nikhahit (stacked)
    '\uf71b': '',        # stray glyph noise (font-specific marker)
}

_UPPER_MARKS = '\u0e31\u0e34\u0e35\u0e36\u0e37\u0e47\u0e48\u0e49\u0e4a\u0e4b\u0e4c\u0e4d\u0e4e'
# Subset that's safe to swap during reorder. Excludes ์ (thanthakhat)
# and ํ (nikhahit) — those are usually correctly placed at the END of
# a word ("รถยนต์", "อนุสรณ์") and would be wrongly pulled inward.
_SWAPPABLE_MARKS = '\u0e31\u0e34\u0e35\u0e36\u0e37\u0e47\u0e48\u0e49\u0e4a\u0e4b'

# Reorder rule:
# In garbled visual-order extracts the upper vowel/tone mark gets
# pushed past the next consonant AND a spurious space is inserted at
# the glyph-cluster boundary. We only swap when that trailing space
# (or line end) is present — that's our signal of a glyph boundary
# rather than a genuine syllable break. This keeps real Thai words
# like "เกี่ยวกับ", "ปลอดภัย", "ปฏิบัติงาน", "รถยนต์" intact.
_REORDER_C_C_MARK_BOUNDARY = re.compile(
    r'([\u0e01-\u0e2e])([\u0e01-\u0e2e])([' + _SWAPPABLE_MARKS + r']+)(?=\s|$|[^\u0e01-\u0e7f])'
)
# Same idea, but the "wrong" character is a leading vowel
# (เ แ โ ไ ใ) — the mark must move back past the lead vowel onto
# the consonant before it.
_REORDER_C_LEAD_MARK_BOUNDARY = re.compile(
    r'([\u0e01-\u0e2e])([\u0e40-\u0e44])([' + _SWAPPABLE_MARKS + r']+)(?=\s|$|[^\u0e01-\u0e7f])'
)


def _ascii_in_thai_context(text):
    """Legacy ASCII garble (P Q ) , 4 etc.) — only touches chars
    flanked by Thai so we don't mangle English fragments."""
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
        elif prev_thai and ch == ',' and next_thai:
            result[i] = '\u0e4c'
        elif prev_thai and ch == '4' and next_thai:
            result[i] = '\u0e49'
    return ''.join(result)


def fix_thai_encoding(text):
    """Full Thai PDF-extraction cleanup. Safe to call multiple times —
    idempotent on already-clean text."""
    if not text:
        return text

    # 1. PUA → real Thai marks
    text = text.translate(str.maketrans(PUA_MAP))

    # 2. Decomposed sara am → composed สระอำ
    text = text.replace('\u0e4d\u0e32', '\u0e33')
    text = text.replace('\u0e4d \u0e32', '\u0e33')

    # 3. Legacy ASCII garble (PQ")4,*@0… around Thai consonants)
    text = _ascii_in_thai_context(text)

    # 4. Reorder misplaced upper marks pushed one consonant too far
    #    (visual-order glyph extraction). Iterate because chained
    #    misplacements happen; only swap at a glyph-cluster boundary
    #    so valid syllable-boundary patterns like "เกี่ยวกับ" stay put.
    for _ in range(4):
        prev = text
        text = _REORDER_C_C_MARK_BOUNDARY.sub(
            lambda m: m.group(1) + m.group(3) + m.group(2), text
        )
        text = _REORDER_C_LEAD_MARK_BOUNDARY.sub(
            lambda m: m.group(1) + m.group(3) + m.group(2), text
        )
        if text == prev:
            break

    # 5. Remove stray spaces before combining marks.
    text = re.sub(
        r'\s+([' + _UPPER_MARKS + r'\u0e38\u0e39\u0e3a])',
        lambda m: m.group(1),
        text,
    )

    # 6. Normalise combining-mark order within a cluster:
    #    vowel/mai-han/taikhu come BEFORE tone mark (Unicode spec).
    #    Fixes "เป้ือน" (stacked tone before vowel) -> "เปื้อน".
    text = re.sub(
        r'([\u0e48-\u0e4b])([\u0e31\u0e34-\u0e37\u0e47])',
        lambda m: m.group(2) + m.group(1),
        text,
    )

    # 7. If a lead vowel (เ แ โ ไ ใ) ended up separated from the
    #    following consonant by a lone space (artefact of step 4),
    #    move the space back in front of the lead vowel so the
    #    syllable stays intact.
    text = re.sub(
        r'([\u0e40-\u0e44])\s+([\u0e01-\u0e2e])',
        r' \1\2',
        text,
    )

    # 8. Remove stray space between a consonant and the spacing
    #    vowel sara aa / sara am / sara ae-tail (ำ า ะ)
    #    — again an artefact of glyph-cluster boundaries.
    text = re.sub(
        r'([\u0e01-\u0e2e])\s+([\u0e30\u0e32\u0e33\u0e45])',
        r'\1\2',
        text,
    )

    # 9. Collapse duplicate spaces.
    text = re.sub(r'[ \t]{2,}', ' ', text)

    return text


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

        # Normalise each section through the full Thai cleanup pipeline
        # (defence-in-depth: full_text already went through it, but
        # re-running is idempotent and cheap).
        #
        # After fix_thai_encoding (PUA -> Unicode, visual-order reorder)
        # we run fix_thai_spacing (dictionary-guided merge + dedup +
        # misplaced-thanthakhat fix) as a second pass. Imported lazily
        # so fresh extractions that don't hit this branch don't pay the
        # pythainlp import cost.
        try:
            from thai_spacing import fix_thai_spacing
        except Exception:
            def fix_thai_spacing(t):  # graceful fallback if pythainlp missing
                return t

        def _clean(text):
            return fix_thai_spacing(fix_thai_encoding(text))

        result['standardRef'] = _clean('\n'.join(sections['standardRef']).strip() or '-')
        result['learningOutcomes'] = _clean('\n'.join(sections['learningOutcomes']).strip())
        result['objectives'] = _clean('\n'.join(sections['objectives']).strip())
        result['competencies'] = _clean('\n'.join(sections['competencies']).strip())
        result['description'] = _clean('\n'.join(sections['description']).strip())

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
