#!/usr/bin/env python3
"""Build data/municipalities.json: IMI revenue and current revenue (receitas
correntes) per municipality from the DGAL's contas de gerência, plus the INE
dwelling stock.

    pip install -r scripts/requirements.txt
    python3 scripts/build_revenue.py

Needs data/map.json (for the CAOP municipality codes and names). Downloads are
cached in scripts/.cache/dgal.

The DGAL reports cash years. IMI for tax year N is billed and collected in
N+1, so cash year N+1 is stored under tax year N — the year every other series
in the site is indexed by. Current revenue is shifted with it, so the IMI share
compares like with like.
"""
import json
import re
import time
import unicodedata
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'scripts' / '.cache' / 'dgal'

DGAL_PAGE = 'https://portalautarquico.dgal.gov.pt/pt-PT/financas-locais/dados-financeiros/contas-de-gerencia/'
F = 'https://portalautarquico.dgal.gov.pt/ficheiros/?schema=f7664ca7-3a1a-4b25-9f46-2056eef44c33&channel=a7187039-4863-4c6c-9ef0-1422b677728d&content_id={}&field=storage_image&lang=pt&ver=1&filetype={}'

# Cash year -> 'Receitas Fiscais' and 'Receitas Correntes' workbooks (2014-2019)
# or the single 'Demonstração de Execução Orçamental da Receita' (2020+).
SPLIT = {
    2014: (F.format('F0FE74C1-19A7-4479-B3EF-FA1372EF0169', 'ods'), F.format('F5F4EF01-1F17-4971-B12B-DCBBC53D1CA4', 'ods')),
    2015: (F.format('CE50250B-3C2D-4BFF-915A-596A424AC6F9', 'ods'), F.format('CB43DCBA-3815-4387-A380-892D18F1BF8F', 'ods')),
    2016: (F.format('BB8C46B1-5F1A-4EA9-843C-2B0118CA34FD', 'ods'), F.format('B99F70A5-A618-4AE1-9F1B-1D8FAA0AB758', 'ods')),
    2017: (F.format('6611B870-ED7E-49E0-8AD5-AC9DEE8D35EB', 'ods'), F.format('11A6F228-4474-4B65-9C8E-AA86CF336960', 'ods')),
    2018: (F.format('3825A7A1-6DCE-44C1-8A6E-0E689A6CAB15', 'xls'), F.format('C5FDF416-9F3A-4716-95B5-1319F6B8B6F3', 'xls')),
    2019: (F.format('EFA6952E-CFE4-48FC-B01E-502C68467E13', 'xlsx'), F.format('D0D22BB4-3D46-466B-A5C7-5693FFF7AD0E', 'xls')),
}
DOREC = {
    2020: F.format('49D2B185-4410-48D6-A735-1AB51AADA3A0', 'pdf'),
    2021: F.format('EC25A9C1-0F63-4589-B2B4-727B51EC4601', 'pdf'),
    2022: F.format('406E242D-FB64-4153-8E95-47B367E0BB8A', 'pdf'),
    2023: F.format('4DDA1A4B-401D-4CB5-ACF3-4E1BBCCE8154', 'pdf'),
    2024: F.format('D6DE6525-137A-4AB0-992C-E88937D81FCB', 'pdf'),  # the DGAL serves .xlsx despite the filetype
}

INE_DWELLINGS = 'https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=0008329&Dim1=T&lang=PT'

# The DGAL disambiguates the two Calhetas and the two Lagoas in brackets.
CODES = {
    'CALHETA (MADEIRA)': '3101',
    'CALHETA (SAO JORGE)': '4501',
    'LAGOA (ALGARVE)': '0806',
    'LAGOA (SAO MIGUEL)': '4201',
}


def norm(name):
    s = unicodedata.normalize('NFKD', str(name)).encode('ascii', 'ignore').decode().upper()
    s = re.sub(r'\bS\.\s*', 'SAO ', s)
    s = re.sub(r'[^A-Z() ]', ' ', s)
    return ' '.join(s.split())


def download(url, name):
    path = CACHE / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'imi-timetravel data refresh'})
        with urllib.request.urlopen(req, timeout=300) as resp:
            path.write_bytes(resp.read())
        time.sleep(0.5)
    return path


def read_any(path):
    return pd.read_excel(path, header=None, engine='odf' if path.suffix == '.ods' else None)


def find_col(df, pattern, header_rows=12):
    for j in range(df.shape[1]):
        cells = ' '.join(str(v) for v in df.iloc[:header_rows, j] if pd.notna(v))
        if re.search(pattern, cells, flags=re.I):
            return j
    raise ValueError(f'no column matching {pattern}')


def rows(df, name_col, value_col):
    out = {}
    for i in range(df.shape[0]):
        name, value = df.iat[i, name_col], df.iat[i, value_col]
        if isinstance(name, str) and name.strip() and isinstance(value, (int, float)) and not pd.isna(value):
            if re.search(r'TOTAL|Munic[ií]pio|^\(', name, flags=re.I):
                continue
            out[name.strip()] = float(value)
    return out


def parse_split(year):
    fiscal_url, current_url = SPLIT[year]
    ext = lambda url: url.split('filetype=')[1]
    fiscal = read_any(download(fiscal_url, f'{year}-fiscais.{ext(fiscal_url)}'))
    current = read_any(download(current_url, f'{year}-correntes.{ext(current_url)}'))
    name_col = find_col(fiscal, r'Munic[ií]pio')
    imi = rows(fiscal, name_col, find_col(fiscal, r'01\.02\.02\s*IMI'))
    imt = rows(fiscal, name_col, find_col(fiscal, r'01\.02\.04\s*IMT'))
    cur = rows(current, find_col(current, r'Munic[ií]pio'), find_col(current, r'TOTAL\s+RECEITAS\s+CORRENTES'))
    cur = {norm(n): v for n, v in cur.items()}
    return {n: {'imi': v, 'imt': imt.get(n), 'current': cur.get(norm(n))} for n, v in imi.items()}


def parse_dorec(year):
    df = pd.read_excel(download(DOREC[year], f'{year}-dorec.xlsx'), header=None)
    codes = df.iloc[11]
    imi_col = next(j for j in range(df.shape[1]) if codes[j] == '0102020000')
    imt_col = next(j for j in range(df.shape[1]) if codes[j] == '0102040000')
    chapters = [j for j in range(df.shape[1]) if isinstance(codes[j], str) and re.fullmatch(r'0[1-8]00000000', codes[j])]
    out = {}
    for i in range(15, df.shape[0]):
        name = df.iat[i, 2]
        if not isinstance(name, str) or pd.isna(df.iat[i, imi_col]) or name.startswith('Nota'):
            continue
        out[name.strip()] = {
            'imi': float(df.iat[i, imi_col]),
            'imt': float(df.iat[i, imt_col]) if pd.notna(df.iat[i, imt_col]) else 0.0,
            'current': float(sum(float(df.iat[i, j]) for j in chapters if pd.notna(df.iat[i, j]))),
        }
    return out


def match(names, municipalities):
    """DGAL name -> CAOP code."""
    by_name = {norm(m['name']): m['code'] for m in municipalities}
    result = {}
    for name in names:
        key = norm(name)
        code = CODES.get(key) or by_name.get(key)
        if not code:
            raise KeyError(f'unmatched DGAL municipality: {name!r} ({key})')
        result[name] = code
    return result


def dwellings(codes):
    path = download(INE_DWELLINGS, 'ine-0008329.json')
    data = json.loads(path.read_text(encoding='utf-8'))
    data = data[0] if isinstance(data, list) else data
    out = {}
    for year, entries in data['Dados'].items():
        for e in entries:
            code = e['geocod'][-4:]
            if len(e['geocod']) == 7 and code in codes and e.get('valor'):
                out.setdefault(code, {})[int(year)] = int(e['valor'])
    return out, data['DataUltimoAtualizacao']


def main():
    municipalities = json.loads((ROOT / 'data' / 'map.json').read_text(encoding='utf-8'))['municipalities']
    codes = {m['code'] for m in municipalities}
    series = {m['code']: {'name': m['name'], 'district': m['district'], 'years': {}} for m in municipalities}

    for cash_year in sorted([*SPLIT, *DOREC]):
        parsed = parse_split(cash_year) if cash_year in SPLIT else parse_dorec(cash_year)
        names = match(parsed, municipalities)
        tax_year = str(cash_year - 1)
        for name, values in parsed.items():
            series[names[name]]['years'][tax_year] = {
                'imi': round(values['imi'], 2),
                'imt': round(values['imt'], 2) if values['imt'] is not None else None,
                'current': round(values['current'], 2) if values['current'] is not None else None,
            }
        print(cash_year, len(parsed))

    stock, updated = dwellings(codes)
    for code, years in stock.items():
        latest = max(years)
        for year, value in years.items():
            if str(year) in series[code]['years']:
                series[code]['years'][str(year)]['dwellings'] = value
        # The INE series lags the DGAL one; extend each municipality by its own
        # last year's growth and flag the value, like an inflation estimate.
        for year in range(latest + 1, max(int(y) for y in series[code]['years']) + 1):
            prev, last = years.get(latest - 1), years[latest]
            estimate = round(last * (last / prev) ** (year - latest)) if prev else last
            if str(year) in series[code]['years']:
                series[code]['years'][str(year)]['dwellings'] = {'value': estimate, 'estimate': True}

    out = {
        'note': 'Keyed by IMI tax year N. imi, imt and current are the DGAL cash figures of year N+1 (receita cobrada líquida). IMT is paid at purchase, so imt is the IMT of year N+1 itself.',
        'sources': {
            'revenue': {'name': 'DGAL — Contas de Gerência dos Municípios', 'url': DGAL_PAGE,
                        'files': {str(y - 1): (SPLIT[y][0] if y in SPLIT else DOREC[y]) for y in [*SPLIT, *DOREC]}},
            'dwellings': {'name': 'INE — Alojamentos familiares clássicos (Parque habitacional), indicador 0008329',
                          'url': 'https://www.ine.pt/xurl/indx/0008329/PT', 'updated': updated},
        },
        'municipalities': series,
    }
    (ROOT / 'data' / 'municipalities.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
