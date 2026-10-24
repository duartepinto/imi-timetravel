#!/usr/bin/env python3
"""Scrape the municipal IMI rates (prédios urbanos) from the AT's
"Consultar Taxas IMI/CA por Município e Ano" pages into data/rates.json.

    python3 scripts/fetch_rates.py [first_year] [last_year]

Standard library only. Pages are cached in scripts/.cache/rates so a rerun
does not hit the AT again; delete the folder to refresh.

`ano` on the AT form is the year the tax refers to ("ano respeitante ao
imposto"), billed the following spring — the same tax-year indexing the site
uses everywhere.

Each municipality also links to its IMI Familiar for the year (art. 112.º-A):
in 2015 a cut in the rate per number of dependents, from 2016 a fixed
deduction in euros. It is stored as `familiar` only when the municipality
applies it, with the amounts it applies.
"""
import html
import http.client
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'scripts' / '.cache' / 'rates'
BASE = 'https://www.portaldasfinancas.gov.pt'

DISTRICTS = [
    '01AVEIRO', '02BEJA', '03BRAGA', '04BRAGANCA', '05C BRANCO', '06COIMBRA',
    '07EVORA', '08FARO', '09GUARDA', '10LEIRIA', '11LISBOA', '12PORTALEGRE',
    '13PORTO', '14SANTAREM', '15SETUBAL', '16VIANA DO CASTELO', '17VILA REAL',
    '18VISEU', '19ANGRA DO HEROISMO', '20HORTA', '21PONTA DELGADA', '22FUNCHAL',
]


def district_url(year, district):
    query = urllib.parse.urlencode({'body': '/imi/consultarTaxasIMI.jsp', 'ano': year, 'distrito': district})
    return f'{BASE}/pt/main.jsp?{query}'


def freguesia_url(year, code):
    return f'{BASE}/pt/external/imi/consultaTaxasFreguesias.action?ano={year}&municipio={code}'


def fetch(url, cache_name):
    path = CACHE / cache_name
    if path.exists():
        return path.read_text(encoding='utf-8')
    req = urllib.request.Request(url, headers={'User-Agent': 'imi-timetravel data refresh'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode('latin-1')
            break
        except (urllib.error.URLError, http.client.HTTPException, OSError):
            # The AT drops a connection now and then on long runs.
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding='utf-8')
    time.sleep(0.4)  # be polite to the AT
    return body


def text(cell):
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', cell)).split())


def percent(value):
    """'0,3000 %' -> 0.003 (a decimal, like the IRS site's tax rates)."""
    match = re.search(r'(\d+,\d+)\s*%', value)
    return round(float(match.group(1).replace(',', '.')) / 100, 6) if match else None


def parse_district(page):
    rows = []
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', page, flags=re.S):
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, flags=re.S)
        if len(cells) < 4 or not re.fullmatch(r'\d{4}', text(cells[0])):
            continue
        rows.append({
            'code': text(cells[0]),
            'name': text(cells[1]),
            'urban': percent(text(cells[2])),
            'hasFreguesiaRates': 'consultaTaxasFreguesias' in row,
            'familiarUrl': familiar_url(row),
        })
    return rows


def familiar_url(row):
    """The 'por agregado' link: consultaReducaoTaxa (2015, only where the
    municipality applies it) or consultaDeducao (2016 on, every municipality)."""
    match = re.search(r'href="([^"]*(?:consultaDeducao|consultaReducaoTaxa)[^"]*)"', row)
    return f"{BASE}/pt/{html.unescape(match.group(1)).lstrip('/')}" if match else None


DEPENDENTS = {'1': '1', '2': '2', '3 ou mais': '3+'}


def parse_familiar(page):
    """{'type': 'reduction' | 'deduction', 'amounts': {'1': .., '2': .., '3+': ..}}
    with only the amounts that apply, or None. Deduction pages list the legal
    amounts for every municipality and mark the ones it applies with 'Sim'."""
    kind, amounts = None, {}
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', page, flags=re.S):
        cells = [text(c) for c in re.findall(r'<td[^>]*>(.*?)</td>', row, flags=re.S)]
        if not cells or cells[0] not in DEPENDENTS or len(cells) < 2:
            continue
        kind = 'reduction' if '%' in cells[1] else 'deduction'
        if kind == 'reduction':
            value = percent(cells[1].replace(' %', ',0 %') if ',' not in cells[1] else cells[1])
        else:
            value = int(cells[1]) if len(cells) > 2 and cells[2] == 'Sim' and cells[1].isdigit() else None
        if value:
            amounts[DEPENDENTS[cells[0]]] = value
    return {'type': kind, 'amounts': amounts} if amounts else None


def parse_freguesias(page):
    """Freguesias with their own urban rate. The AT lists every freguesia by
    name only (often pre-2013 names) with '-' where the municipal rate applies;
    those are dropped."""
    out = []
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', page, flags=re.S):
        cells = [text(c) for c in re.findall(r'<td[^>]*>(.*?)</td>', row, flags=re.S)]
        if len(cells) >= 2 and cells[0] and percent(cells[1]) is not None:
            out.append({'name': cells[0], 'urban': percent(cells[1])})
    return out


def norm(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().upper()
    s = re.sub(r'\bS\.\s*', 'SAO ', s)
    return ' '.join(re.sub(r'[^A-Z ]', ' ', s).split())


# AT names that differ from the CAOP's.
AT_NAMES = {'CALHETA ACORES': '4501', 'CALHETA MADEIRA': '3101', 'LAGOA ACORES': '4201', 'VILA PRAIA DA VITORIA': '4302'}


def caop_code(at_code, name, municipalities):
    """The AT keeps the island municipalities under the old districts 19-22;
    everything is keyed by the CAOP code (data/map.json), matched by name."""
    if int(at_code[:2]) <= 18:
        return at_code
    if norm(name) in AT_NAMES:
        return AT_NAMES[norm(name)]
    region = '3' if at_code.startswith('22') else '4'
    matches = [m['code'] for m in municipalities if m['code'].startswith(region) and norm(m['name']) == norm(name)]
    if len(matches) != 1:
        raise KeyError(f'cannot match AT municipality {at_code} {name!r}')
    return matches[0]


def main():
    first = int(sys.argv[1]) if len(sys.argv) > 1 else 2013
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    municipalities = json.loads((ROOT / 'data' / 'map.json').read_text(encoding='utf-8'))['municipalities']
    rates = {}
    for year in range(first, last + 1):
        before = {code: dict(entry['years']) for code, entry in rates.items()}
        for district in DISTRICTS:
            page = fetch(district_url(year, district), f'{year}-{district[:2]}.html')
            for row in parse_district(page):
                code = caop_code(row['code'], row['name'], municipalities)
                entry = rates.setdefault(code, {'name': row['name'], 'years': {}})
                year_entry = {'urban': row['urban']}
                if row['hasFreguesiaRates']:
                    fpage = fetch(freguesia_url(year, row['code']), f'{year}-f{row["code"]}.html')
                    freguesias = parse_freguesias(fpage)
                    if freguesias:
                        year_entry['freguesias'] = freguesias
                        if year_entry['urban'] is None:
                            # Rates set only per freguesia: the municipality's
                            # rate is the one most of its freguesias pay.
                            values = [f['urban'] for f in freguesias]
                            year_entry['urban'] = max(set(values), key=values.count)
                            year_entry['byFreguesia'] = True
                if row['familiarUrl']:
                    familiar = parse_familiar(fetch(row['familiarUrl'], f'{year}-a{row["code"]}.html'))
                    if familiar:
                        year_entry['familiar'] = familiar
                entry['years'][str(year)] = year_entry
        # Municipalities have until 31 December to send next year's rates, so
        # the current year is only partly filled in; leave it out until it is.
        covered = sum(str(year) in entry['years'] for entry in rates.values())
        if covered < 0.9 * len(municipalities):
            print(f'{year}: only {covered} municipalities so far, skipped', file=sys.stderr)
            rates = {code: {**entry, 'years': before.get(code, {})} for code, entry in rates.items() if before.get(code)}
            continue
        print(year, len(rates), file=sys.stderr)

    out = {
        'source': {
            'name': 'Autoridade Tributária — Consultar Taxas IMI/CA por Município e Ano',
            'url': f'{BASE}/pt/main.jsp?body=/imi/consultarTaxasIMIForm.jsp',
            'note': 'Municipalities missing from a year pay the minimum rate (art. 112.º CIMI). '
                    '`familiar` is the IMI Familiar the municipality applies (art. 112.º-A): '
                    'a rate cut (decimal) in 2015, a fixed deduction in euros from 2016, per number of dependents.',
        },
        'municipalities': dict(sorted(rates.items())),
    }
    (ROOT / 'data' / 'rates.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
