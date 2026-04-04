#!/usr/bin/env python3
"""
Sync PDF links with VEC official website.
Checks all department PDF links and updates departments.json if any changed.
Used by GitHub Actions cron job (daily at midnight Thailand time).
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, '..', 'data')
DEPT_FILE = os.path.join(DATA_DIR, 'departments.json')

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

MAX_VERSION = 10


def check_url(url):
    """Check if a URL is accessible (HEAD request)."""
    try:
        req = Request(url, method='HEAD', headers=HEADERS)
        resp = urlopen(req, timeout=15)
        return resp.status == 200
    except (HTTPError, URLError, Exception):
        return False


def find_working_version(base_url, code):
    """Try versions v1-v10 and no-version to find a working PDF."""
    # Try versioned URLs
    for v in range(1, MAX_VERSION + 1):
        url = f"{base_url}{code}v{v}.pdf"
        if check_url(url):
            return f"{code}v{v}.pdf"
        time.sleep(0.3)

    # Try without version
    url = f"{base_url}{code}.pdf"
    if check_url(url):
        return f"{code}.pdf"

    return None


def main():
    # Load current data
    with open(DEPT_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    base_url = data['pdfBaseUrl']
    departments = data['departments']
    changes = []
    broken = []

    print(f"Checking {len(departments)} department PDF links...")
    print(f"Base URL: {base_url}")
    print()

    for i, dept in enumerate(departments):
        code = dept['code']
        current_pdf = dept['pdf']
        current_url = base_url + current_pdf

        # Check current link
        is_ok = check_url(current_url)

        if is_ok:
            sys.stdout.write(f"  [{i+1}/{len(departments)}] {code} {dept['name']} - OK\n")
        else:
            sys.stdout.write(f"  [{i+1}/{len(departments)}] {code} {dept['name']} - BROKEN, searching...\n")
            sys.stdout.flush()

            # Try to find working version
            new_pdf = find_working_version(base_url, code)

            if new_pdf and new_pdf != current_pdf:
                changes.append({
                    'code': code,
                    'name': dept['name'],
                    'old': current_pdf,
                    'new': new_pdf
                })
                dept['pdf'] = new_pdf
                # Also update pdfUrl if present
                if 'pdfUrl' in dept:
                    dept['pdfUrl'] = base_url + new_pdf
                print(f"    -> Fixed: {current_pdf} -> {new_pdf}")
            elif new_pdf is None:
                broken.append({
                    'code': code,
                    'name': dept['name'],
                    'pdf': current_pdf
                })
                print(f"    -> No working version found!")

        # Small delay to avoid rate limiting
        time.sleep(0.5)

    print()
    print(f"=== Sync Summary ===")
    print(f"Total checked: {len(departments)}")
    print(f"OK: {len(departments) - len(changes) - len(broken)}")
    print(f"Updated: {len(changes)}")
    print(f"Still broken: {len(broken)}")

    if changes:
        print()
        print("Changes:")
        for c in changes:
            print(f"  {c['code']} {c['name']}: {c['old']} -> {c['new']}")

    if broken:
        print()
        print("Broken (no fix found):")
        for b in broken:
            print(f"  {b['code']} {b['name']}: {b['pdf']}")

    # Update lastSync and save if there are changes
    thai_tz = timezone(timedelta(hours=7))
    now = datetime.now(thai_tz).isoformat()

    if changes:
        data['lastSync'] = now
        with open(DEPT_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"\nUpdated departments.json with {len(changes)} changes.")
        print(f"lastSync: {now}")
        # Output for GitHub Actions
        print(f"\n::set-output name=changes::{len(changes)}")
        return 0
    else:
        # Update lastSync even if no changes (to show last check date)
        data['lastSync'] = now
        with open(DEPT_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"\nNo changes needed. Updated lastSync: {now}")
        print(f"\n::set-output name=changes::0")
        return 0


if __name__ == '__main__':
    sys.exit(main())
