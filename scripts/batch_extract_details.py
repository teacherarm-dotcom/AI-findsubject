#!/usr/bin/env python3
"""
Pre-generate /api/subject-detail JSON caches for ALL subjects.

Reads pages.json (dept -> {subjectCode -> pageNumber}) and extracts
details for every (subjectCode, deptCode) pair into:

  data/detail-cache/<subjectCode>_<deptCode>.json

This bypasses the slow Render PDF download + extraction at request time.
Render just serves the pre-committed JSON from disk (milliseconds).

Optimization: opens each dept's PDF ONCE via pdfplumber and extracts all
subjects from that dept in a single pass (much faster than re-opening).

Usage:
  python3 scripts/batch_extract_details.py              # extract all
  python3 scripts/batch_extract_details.py --dept 31910 # one dept
  python3 scripts/batch_extract_details.py --resume     # skip existing
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import warnings

warnings.filterwarnings("ignore")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DEPT_FILE = os.path.join(PROJECT_DIR, "data", "departments.json")
SUBJECTS_FILE = os.path.join(PROJECT_DIR, "data", "subjects.json")
PAGES_FILE = os.path.join(PROJECT_DIR, "data", "pages.json")
PDF_CACHE_DIR = os.path.join(PROJECT_DIR, "data", "pdf-cache")
DETAIL_CACHE_DIR = os.path.join(PROJECT_DIR, "data", "detail-cache")
os.makedirs(PDF_CACHE_DIR, exist_ok=True)
os.makedirs(DETAIL_CACHE_DIR, exist_ok=True)

sys.path.insert(0, SCRIPT_DIR)
from subject_detail import fix_thai_encoding  # noqa: E402


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def download_pdf(pdf_url, dest_path):
    try:
        req = urllib.request.Request(pdf_url, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; ai-findsubject/1.0)'
        })
        with urllib.request.urlopen(req, timeout=120) as response:
            with open(dest_path, 'wb') as f:
                f.write(response.read())
        return True
    except Exception as e:
        print(f"  ERROR downloading: {e}", flush=True)
        if os.path.exists(dest_path):
            try: os.unlink(dest_path)
            except: pass
        return False


def cache_key(subject_code, dept_code):
    return re.sub(r'[^a-zA-Z0-9_-]', '_', f"{subject_code}_{dept_code}")


def extract_from_pages(pdf, code_pattern, subject_code, page_hint, total_pages):
    """Find and extract details for one subject using a pre-opened pdfplumber instance."""
    result = {
        "standardRef": "-",
        "learningOutcomes": "",
        "objectives": "",
        "competencies": "",
        "description": "",
        "pdfPage": 0
    }

    candidate_pages = []
    if page_hint and 1 <= page_hint <= total_pages:
        hint_idx = page_hint - 1
        for offset in (0, 1, -1, 2):
            idx = hint_idx + offset
            if 0 <= idx < total_pages and idx not in candidate_pages:
                candidate_pages.append(idx)
    fallback_pages = [i for i in range(total_pages) if i not in candidate_pages]
    all_candidates = candidate_pages + fallback_pages

    found = False
    full_text = ""

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
            current_section = 'standardRef'; continue
        elif re.search(r'ผลลัพธ.การเรียนรู.ระดับรายวิชา', line_stripped):
            current_section = 'learningOutcomes'; continue
        elif re.search(r'จุดประสงค.รายวิชา', line_stripped):
            current_section = 'objectives'; continue
        elif re.search(r'สมรรถนะรายวิชา', line_stripped):
            current_section = 'competencies'; continue
        elif re.search(r'ค.{0,2}อธิบายรายวิชา', line_stripped):
            current_section = 'description'; continue
        elif 'Course Objectives' in line_stripped:
            current_section = 'objectives'; continue
        elif 'Course Competencies' in line_stripped:
            current_section = 'competencies'; continue
        elif 'Course Description' in line_stripped:
            current_section = 'description'; continue
        elif 'Learning Outcome' in line_stripped:
            current_section = 'learningOutcomes'; continue

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
    ap = argparse.ArgumentParser()
    ap.add_argument("--dept", help="Only process this dept code")
    ap.add_argument("--resume", action="store_true", help="Skip existing cache files")
    ap.add_argument("--limit", type=int, default=0, help="Max subjects to process (0=all)")
    args = ap.parse_args()

    import pdfplumber

    dept_data = load_json(DEPT_FILE)
    subj_data = load_json(SUBJECTS_FILE)
    pages_data = load_json(PAGES_FILE)
    pdf_base_url = dept_data["pdfBaseUrl"]
    dept_lookup = {d["code"]: d for d in dept_data["departments"]}

    # Build targets grouped by dept so we open each PDF once
    targets_by_dept = {}
    for dept_code, subjects in subj_data["subjects"].items():
        if args.dept and dept_code != args.dept:
            continue
        if dept_code not in dept_lookup:
            continue
        pages_for_dept = pages_data.get(dept_code, {})
        for subj in subjects:
            page = pages_for_dept.get(subj["code"], 0)
            targets_by_dept.setdefault(dept_code, []).append((subj, page))

    total = sum(len(v) for v in targets_by_dept.values())
    if args.limit:
        # Apply limit to first dept
        cut = args.limit
        new_targets = {}
        for dc, subs in targets_by_dept.items():
            take = min(cut, len(subs))
            new_targets[dc] = subs[:take]
            cut -= take
            if cut <= 0:
                break
        targets_by_dept = new_targets
        total = sum(len(v) for v in targets_by_dept.values())

    print(f"Total (subject, dept) pairs to process: {total}")
    print(f"Unique PDFs needed: {len(targets_by_dept)}")

    # Download all PDFs first
    for dept_code in sorted(targets_by_dept.keys()):
        dept = dept_lookup[dept_code]
        pdf_path = os.path.join(PDF_CACHE_DIR, f"{dept_code}.pdf")
        if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 10240:
            continue
        pdf_url = pdf_base_url + dept["pdf"]
        print(f"Downloading {dept_code}: {dept['name']}", flush=True)
        t0 = time.time()
        if download_pdf(pdf_url, pdf_path):
            size_mb = os.path.getsize(pdf_path) / 1024 / 1024
            print(f"  {size_mb:.1f} MB in {time.time()-t0:.1f}s", flush=True)
        else:
            print(f"  FAILED", flush=True)

    # Process each dept: open PDF once, extract all subjects
    done = 0
    skipped = 0
    failed = 0
    t_start = time.time()

    for dept_code in sorted(targets_by_dept.keys()):
        dept = dept_lookup[dept_code]
        pdf_path = os.path.join(PDF_CACHE_DIR, f"{dept_code}.pdf")
        if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) < 10240:
            n = len(targets_by_dept[dept_code])
            print(f"[skip dept {dept_code}] PDF missing, skipping {n}")
            failed += n
            continue

        dept_subjects = targets_by_dept[dept_code]

        # Filter out already-cached when --resume
        if args.resume:
            dept_subjects = [
                (s, p) for s, p in dept_subjects
                if not os.path.exists(os.path.join(
                    DETAIL_CACHE_DIR, f"{cache_key(s['code'], dept_code)}.json"
                ))
            ]
            if not dept_subjects:
                skipped += len(targets_by_dept[dept_code])
                done += len(targets_by_dept[dept_code])
                continue

        t_dept = time.time()
        try:
            with pdfplumber.open(pdf_path) as pdf:
                total_pages = len(pdf.pages)
                print(f"[{dept_code}] {dept['name']} — {len(dept_subjects)} subjects, PDF {total_pages} pages", flush=True)

                for subj, page in dept_subjects:
                    ckey = cache_key(subj["code"], dept_code)
                    out_path = os.path.join(DETAIL_CACHE_DIR, f"{ckey}.json")

                    if args.resume and os.path.exists(out_path):
                        skipped += 1
                        done += 1
                        continue

                    try:
                        code_pattern = subj["code"].replace("-", "[-–]")
                        details = extract_from_pages(pdf, code_pattern, subj["code"], page, total_pages)
                        pdf_url = pdf_base_url + dept["pdf"]
                        output = {
                            "success": True,
                            "courseCode": subj["code"],
                            "courseName": subj.get("nameTh", ""),
                            "courseNameEn": subj.get("nameEn", ""),
                            "credit": subj.get("credit", ""),
                            "deptName": dept["name"],
                            "level": dept["level"],
                            "standardRef": details["standardRef"],
                            "learningOutcomes": details["learningOutcomes"],
                            "objectives": details["objectives"],
                            "competencies": details["competencies"],
                            "description": details["description"],
                            "pdfPage": details["pdfPage"],
                            "pdfUrl": f"{pdf_url}#page={details['pdfPage']}" if details["pdfPage"] > 0 else pdf_url,
                        }
                        with open(out_path, "w", encoding="utf-8") as f:
                            json.dump(output, f, ensure_ascii=False, indent=2)
                        done += 1
                    except Exception as e:
                        failed += 1
                        print(f"  FAIL {subj['code']}: {e}", flush=True)

            dept_elapsed = time.time() - t_dept
            elapsed = time.time() - t_start
            rate = done / elapsed if elapsed > 0 else 0
            remaining = (total - done) / rate if rate > 0 else 0
            print(f"  dept done in {dept_elapsed:.1f}s — overall {done}/{total} ({done*100//max(total,1)}%) — {rate:.1f}/s — ~{remaining/60:.1f} min left", flush=True)

        except Exception as e:
            print(f"[ERROR dept {dept_code}]: {e}", flush=True)
            failed += len(dept_subjects)

    elapsed = time.time() - t_start
    print(f"\nDone. {done} processed ({skipped} skipped), {failed} failed in {elapsed/60:.1f} min")


if __name__ == "__main__":
    main()
