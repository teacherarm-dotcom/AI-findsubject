#!/usr/bin/env python3
"""Fix garbled Thai subject names by comparing pdfplumber vs fitz extraction."""
import json, os, re, sys, tempfile, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

CODE_RE = re.compile(r'(\d{5})\s*[–\-]\s*(\d{4})')
CREDIT_RE = re.compile(r'[\d*]{1,2}\s*[–\-]\s*[\d*]{1,2}\s*[–\-]\s*[\d*]{1,2}')

def clean_thai(name):
    name = name.replace('\u0e4d\u0e32', '\u0e33')
    name = name.replace('\u0e4d \u0e32', '\u0e33')
    name = re.sub(r'([\u0e01-\u0e2e])\)', lambda m: m.group(1)+'\u0e4c', name)
    name = re.sub(r'([\u0e31\u0e34-\u0e3a\u0e47-\u0e4b])\)', lambda m: m.group(1)+'\u0e4c', name)
    name = re.sub(r'([\u0e01-\u0e2e]),', lambda m: m.group(1)+'\u0e4c', name)
    name = re.sub(r'([\u0e31\u0e34-\u0e3a\u0e47-\u0e4b]),', lambda m: m.group(1)+'\u0e4c', name)
    name = re.sub(r'([\u0e01-\u0e2e])4([\u0e01-\u0e7f\s])', lambda m: m.group(1)+'\u0e49'+m.group(2), name)
    name = re.sub(r'([\u0e01-\u0e2e])4$', lambda m: m.group(1)+'\u0e49', name)
    name = re.sub(r'\s+([\u0e31\u0e34-\u0e3a\u0e47-\u0e4e])', lambda m: m.group(1), name)
    # fitz-specific: space before sara aa (decomposed sara am without nikhahit)
    # Pattern: Thai consonant + space + sara aa where it should be sara am
    name = re.sub(r'([\u0e01-\u0e2e](?:[\u0e31\u0e34-\u0e3a\u0e47-\u0e4b])?)\s\u0e32', lambda m: m.group(1)+'\u0e33', name)
    name = re.sub(r'  +', ' ', name).strip()
    return name

# Garbling score: lower = better
GARBLE_CHARS = set('PQ"!&0')  # common fitz garble chars
def garble_score(name):
    score = 0
    for i, ch in enumerate(name):
        # ASCII chars in Thai context
        if ch in GARBLE_CHARS:
            # Check if surrounded by Thai
            before = name[i-1] if i > 0 else ''
            after = name[i+1] if i+1 < len(name) else ''
            if ('\u0e01' <= before <= '\u0e7f') or ('\u0e01' <= after <= '\u0e7f'):
                score += 10
        # ) in Thai context (unfixed thanthakhat)
        if ch == ')' and i > 0 and '\u0e01' <= name[i-1] <= '\u0e2e':
            score += 10
        # Stray digit in Thai context
        if ch == '4' and i > 0 and '\u0e01' <= name[i-1] <= '\u0e2e':
            if i+1 < len(name) and '\u0e01' <= name[i+1] <= '\u0e7f':
                score += 10
    # Trailing credit-like numbers
    if re.search(r'\s+\d+\s+\d+\s*$', name):
        score += 20
    # Context bleed
    if name.startswith('-') or name.startswith('เพื่อให้') or re.search(r'(หรือ|ทางด้าน|สูงกว่า)\s*$', name):
        score += 50
    # Too long
    if len(name) > 80:
        score += 30
    # Too short
    if len(name) < 3:
        score += 50
    return score

def extract_fitz_names(pdf_path, valid_codes):
    import fitz
    names = {}
    doc = fitz.open(pdf_path)
    for i in range(len(doc)):
        text = doc[i].get_text() or ''
        lines = text.split('\n')
        for j, line in enumerate(lines):
            for m in CODE_RE.finditer(line):
                code = f'{m.group(1)}-{m.group(2)}'
                if code not in valid_codes or code in names:
                    continue
                after = line[m.end():].strip()
                candidate = None
                if after and re.search(r'[\u0e01-\u0e7f]', after):
                    cleaned = CREDIT_RE.sub('', after).strip()
                    if cleaned and re.search(r'[\u0e01-\u0e7f]', cleaned) and len(cleaned) > 2:
                        candidate = cleaned
                if not candidate:
                    for k in range(j+1, min(j+4, len(lines))):
                        nxt = lines[k].strip()
                        if not nxt: continue
                        if CODE_RE.search(nxt): break
                        if re.search(r'[\u0e01-\u0e7f]', nxt):
                            cleaned = CREDIT_RE.sub('', nxt).strip()
                            if cleaned and re.search(r'[\u0e01-\u0e7f]', cleaned) and len(cleaned) > 2:
                                candidate = cleaned
                            break
                        if re.match(r'^[A-Z]', nxt): break
                if candidate:
                    names[code] = clean_thai(candidate)
    doc.close()
    return names

def process_dept(dept, base_url, valid_codes):
    url = base_url + dept['pdf']
    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as resp:
            tmp.write(resp.read())
        tmp.close()
        return dept['code'], extract_fitz_names(tmp.name, valid_codes), None
    except Exception as e:
        return dept['code'], {}, str(e)
    finally:
        try: os.unlink(tmp.name)
        except: pass

def main():
    with open(os.path.join(PROJECT_DIR, 'data/departments.json')) as f:
        dept_data = json.load(f)
    with open(os.path.join(PROJECT_DIR, 'data/subjects.json')) as f:
        subj_data = json.load(f)

    base_url = dept_data['pdfBaseUrl']
    departments = dept_data['departments']
    valid_codes = set()
    for _, subjs in subj_data['subjects'].items():
        for s in subjs:
            valid_codes.add(s['code'])

    # Extract fitz names for all departments
    all_fitz = {}
    total = len(departments)
    completed = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(process_dept, d, base_url, valid_codes): d for d in departments}
        for fut in as_completed(futures):
            d = futures[fut]
            dcode, names, err = fut.result()
            completed += 1
            if err:
                print(f'[{completed}/{total}] {dcode} {d["name"]}  ✗ {err}', flush=True)
            else:
                all_fitz[dcode] = names
                print(f'[{completed}/{total}] {dcode} {d["name"]}  ✓ {len(names)} names', flush=True)

    # Compare and fix
    fixed = 0
    for dcode, subjs in subj_data['subjects'].items():
        fitz_names = all_fitz.get(dcode, {})
        for s in subjs:
            code = s['code']
            old_name = s['nameTh']
            fitz_name = fitz_names.get(code)
            if not fitz_name or fitz_name == old_name:
                continue
            old_score = garble_score(old_name)
            new_score = garble_score(fitz_name)
            if new_score < old_score:
                s['nameTh'] = fitz_name
                fixed += 1
                if fixed <= 30:
                    print(f'  FIX {code}: {old_name[:50]} -> {fitz_name[:50]}')

    with open(os.path.join(PROJECT_DIR, 'data/subjects.json'), 'w', encoding='utf-8') as f:
        json.dump(subj_data, f, ensure_ascii=False, indent=2)

    print(f'\nFixed {fixed} subject names')

if __name__ == '__main__':
    main()
