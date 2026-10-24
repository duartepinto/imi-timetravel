#!/usr/bin/env python3
"""Back up every source cited in data/*.json on the Internet Archive and
check that each backup really holds the document.

    python3 scripts/archive_sources.py           # verify, fill in missing backups
    python3 scripts/archive_sources.py --check   # verify only, change nothing

A backup is a Wayback Machine snapshot URL stored next to the source URL
("backup"). A snapshot only counts if its raw capture (the `id_` form) is a
200 of the same kind of document as the live one: a PDF that starts with
%PDF, JSON that parses, or an HTML page that contains the text the source is
cited for. Diário da República pages are rendered by JavaScript, so their
captures are empty shells; cite the PDF instead. When no existing capture
passes, the script asks Save Page Now for a new one.

For INE indicators the snapshot is of the JSON the data was built from
("data"), not of the indicator page, which is only a redirect.

Standard library only.
"""
import gzip
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
UA = {'User-Agent': 'imi-timetravel source backup'}

# Text an archived HTML page must contain to count as the right page.
EXPECT = {
    'cimi138.aspx': 'Actualização periódica',
    'cimi44.aspx': 'vetustez',
    'cimi62.aspx': 'zonamento',
    'imi-2026-valor-medio-da-construcao': '712,50',
    'portaria-n-o-420-a-2015': '420-A/2015',
}


def get(url, timeout=120):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        # Raw captures come back with the encoding the site sent them in.
        if body[:2] == b'\x1f\x8b':
            body = gzip.decompress(body)
        return resp.status, resp.headers.get('Content-Type', ''), resp.geturl(), body


def fingerprint(kind, body):
    """What must match between a capture and the live source. INE stamps
    each response with its extraction time, so only the data is compared."""
    if kind == 'json':
        try:
            data = json.loads(body)
        except ValueError:
            return None
        if isinstance(data, list):
            data = [{k: v for k, v in d.items() if k != 'DataExtracao'} if isinstance(d, dict) else d for d in data]
        body = json.dumps(data, sort_keys=True).encode()
    return hashlib.sha256(body).hexdigest()


def kind(url, content_type, body):
    if body[:4] == b'%PDF':
        return 'pdf'
    if 'json' in content_type or 'json_indicador' in url:
        return 'json'
    return 'html'


def snapshot(timestamp, url):
    return f'https://web.archive.org/web/{timestamp}/{url}'


def timestamp_of(backup):
    return backup.split('/web/', 1)[1].split('/', 1)[0]


def check(url, backup, live):
    """Return (ok, note) for a snapshot URL."""
    ts = timestamp_of(backup)
    try:
        status, content_type, final, body = get(f'https://web.archive.org/web/{ts}id_/{url}')
    except (urllib.error.URLError, TimeoutError) as e:
        return False, f'capture not readable ({e})'
    if f'/web/{ts}id_/' not in final:
        return False, 'Wayback redirected to another capture'
    if status != 200:
        return False, f'capture is HTTP {status}'
    got = kind(url, content_type, body)
    want = live['kind'] if live else got
    if got != want:
        return False, f'capture is {got}, source is {want}'
    if got == 'pdf':
        if live and live['sha'] != fingerprint(got, body):
            return True, 'PDF, differs from the live file (an older or newer version)'
        return True, 'PDF, identical to the live file' if live else 'PDF (live file unreachable)'
    if got == 'json':
        try:
            data = json.loads(body)
        except ValueError:
            return False, 'capture is not valid JSON'
        if 'json_indicador' in url and not (isinstance(data, list) and data and 'Dados' in data[0]):
            return False, 'capture has no INE data'
        if live and live['sha'] != fingerprint(got, body):
            return True, 'JSON, differs from the live data (an older or newer version)'
        return True, 'JSON, identical to the live data' if live else 'JSON (live data unreachable)'
    text = body.decode('utf-8', 'replace')
    for key, expected in EXPECT.items():
        if key in url:
            return (expected in text, f'HTML, contains "{expected}"' if expected in text else f'HTML without "{expected}"')
    return len(body) > 5000, f'HTML, {len(body)} bytes'


def live_info(url):
    try:
        status, content_type, _, body = get(url)
    except (urllib.error.URLError, TimeoutError):
        return None
    if status != 200:
        return None
    k = kind(url, content_type, body)
    return {'kind': k, 'sha': fingerprint(k, body)}


def captures(url):
    query = urllib.parse.urlencode({'url': url, 'output': 'json', 'filter': 'statuscode:200', 'fl': 'timestamp'})
    try:
        _, _, _, body = get(f'https://web.archive.org/cdx/search/cdx?{query}')
    except (urllib.error.URLError, TimeoutError):
        return []
    rows = json.loads(body or b'[]')[1:]
    return [r[0] for r in reversed(rows)]  # newest first


def save(url):
    for attempt in range(4):
        try:
            _, _, final, _ = get(f'https://web.archive.org/save/{url}', timeout=300)
            if '/web/' in final:
                return timestamp_of(final)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f'    save failed ({e}), retrying')
        time.sleep(20 * (attempt + 1))
    return None


def sources():
    """(file, object holding the url, key of the archived url) for every source."""
    national = json.loads((DATA / 'national.json').read_text(encoding='utf-8'))
    components = json.loads((DATA / 'vpt_components.json').read_text(encoding='utf-8'))
    indices = json.loads((DATA / 'indices.json').read_text(encoding='utf-8'))
    out = [('national.json', row['source'], 'url') for row in national['years']]
    for key in ('constructionValue', 'triennialUpdates', 'ageing', 'location'):
        out.append(('vpt_components.json', components[key], 'url'))
    out += [('vpt_components.json', u, 'url') for u in components['triennialUpdates']['updates']]
    out += [('vpt_components.json', r, 'url') for r in components['location']['revisions']]
    out += [('indices.json', indices[key], 'data') for key in ('constructionCosts', 'housePrices')]
    return {'national.json': national, 'vpt_components.json': components, 'indices.json': indices}, out


def with_backup(entry, url_key, backup):
    """Put "backup" right after the archived url, keeping the other keys in order."""
    items = [(k, v) for k, v in entry.items() if k != 'backup']
    entry.clear()
    for k, v in items:
        entry[k] = v
        if k == url_key:
            entry['backup'] = backup


def main():
    check_only = '--check' in sys.argv
    files, entries = sources()
    done, failed = {}, []
    for name, entry, url_key in entries:
        url = entry[url_key]
        if url not in done:
            print(url)
            live = live_info(url)
            # A capture that differs from the live file only counts when no
            # identical one exists and a new capture can't be made.
            chosen = fallback = None
            candidates = ([entry['backup']] if entry.get('backup') else []) + \
                [snapshot(ts, url) for ts in ([] if check_only else captures(url)[:6])]
            for backup in dict.fromkeys(candidates):
                ok, note = check(url, backup, live)
                print(f'    {"ok " if ok else "bad"} {backup}  ({note})')
                if ok and 'differs' not in note:
                    chosen = backup
                    break
                if ok and not fallback:
                    fallback = backup
                if check_only:
                    chosen = fallback
                    break
            if not chosen and not check_only:
                print('    saving a new capture…')
                ts = save(url)
                if ts:
                    time.sleep(10)
                    ok, note = check(url, snapshot(ts, url), live)
                    print(f'    {"ok " if ok else "bad"} {snapshot(ts, url)}  ({note})')
                    chosen = snapshot(ts, url) if ok else None
                chosen = chosen or fallback
            done[url] = chosen
            if not chosen:
                failed.append(url)
            time.sleep(2)  # be polite to the archive
        if done[url] and not check_only:
            with_backup(entry, url_key, done[url])
    if not check_only:
        for name, data in files.items():
            (DATA / name).write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    if failed:
        print('\nNo valid backup for:\n  ' + '\n  '.join(failed))
        sys.exit(1)
    print('\nEvery source has a verified backup.')


if __name__ == '__main__':
    main()
