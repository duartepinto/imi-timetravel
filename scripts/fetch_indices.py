#!/usr/bin/env python3
"""Download two INE price indices into data/indices.json, as yearly averages:

- construction costs of new housing (what the Vc of the IMI should follow);
- house prices (what the location coefficients should follow).

    python3 scripts/fetch_indices.py

Standard library only. Responses are cached in scripts/.cache/ine; delete
the folder to refresh. Only complete years are kept (12 months, 4 quarters).
"""
import json
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'scripts' / '.cache' / 'ine'
OUT = ROOT / 'data' / 'indices.json'
FIRST_YEAR = 2012

SERIES = {
    'constructionCosts': {
        'name': 'INE — Índice de custo de construção de habitação nova (base 2021), total',
        'indicator': '0011748',
        'total': 'T',
        'periods': 12,
    },
    'housePrices': {
        'name': 'INE — Índice de preços da habitação (base 2025), total',
        'indicator': '0014765',
        'total': 'H1',
        'periods': 4,
    },
}


# Only the "Total" category: the full response of the construction cost index
# takes INE over a minute, too slow for the Internet Archive to capture.
def api_url(spec):
    return f"https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={spec['indicator']}&Dim1=T&Dim3={spec['total']}&lang=PT"


def fetch(spec):
    path = CACHE / f"{spec['indicator']}-{spec['total']}.json"
    if not path.exists():
        req = urllib.request.Request(api_url(spec), headers={'User-Agent': 'imi-timetravel data refresh'})
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode('utf-8')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding='utf-8')
    return json.loads(path.read_text(encoding='utf-8'))[0]


def yearly(data, total, periods):
    values = defaultdict(list)
    for period, rows in data['Dados'].items():
        year = int(period.split()[-1])
        for row in rows:
            if row['geocod'] == 'PT' and row['dim_3'] == total and row.get('valor'):
                values[year].append(float(row['valor']))
    return {str(y): round(sum(v) / len(v), 2)
            for y, v in sorted(values.items()) if y >= FIRST_YEAR and len(v) == periods}


def main():
    out: dict = {'description': 'Yearly averages of INE price indices for Portugal. Each series keeps the base INE publishes; the site rebases them.'}
    for key, spec in SERIES.items():
        data = fetch(spec)
        out[key] = {
            'name': spec['name'],
            'url': f"https://www.ine.pt/xurl/indx/{spec['indicator']}/PT",
            'data': api_url(spec),
            'updated': data.get('DataUltimoAtualizacao'),
            'years': yearly(data, spec['total'], spec['periods']),
        }
        years = list(out[key]['years'])
        print(f"{key}: {years[0]}–{years[-1]}")
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'wrote {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
