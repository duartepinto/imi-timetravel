# IMI Timetravel

How the Portuguese municipal property tax (IMI, *Imposto Municipal sobre Imóveis*) has changed since 2013, compared with inflation, for the whole country and for every district and municipality.

A sister project of `tabelas-irs-timetravel`, built the same way: a static site with no backend and no build step.

## What it shows

- **National headline.** The average IMI per urban property, in euros of the time and at today's prices. Since 2013 it has fallen about 18% in real terms while rising about 8% in nominal euros.
- **IMI vs IMT.** Municipal revenue from IMI (the yearly tax on owning property) and IMT (the tax paid once, on purchase), by the year the money came in. IMT overtook IMI in 2022.
- **Map by district and municipality.** Click a district to see its municipalities, then a municipality to see its details. The map, the top 3 rises and falls, and the table follow one indicator:
  - IMI as a share of the municipality's current revenue (*receitas correntes*), the default;
  - IMI per dwelling, at today's prices;
  - IMI per dwelling, in euros of the time.
- **Municipality detail.** Key figures, IMI per dwelling against the district and the country, IMI vs IMT, IMI's share of current revenue, and the IMI rate history, including rates set per freguesia where they exist.
- **Why IMI lags inflation.** The IMI formula, with each part of the VPT, then the national split IMI = VPT × effective rate (since 2013 the average VPT rose about 21% and the effective rate fell about 11%, while prices rose 31%). Each part that should grow over time has its own chart: the construction value Vc against construction costs, the three-yearly update (only 75% of the inflation coefficient for housing, and late), the location coefficients against house prices, an ageing (Cv) example, and the average municipal rate.

Every view can be linked to: `#/porto/gondomar`.

## Running it

```bash
python3 -m http.server 8000      # http://localhost:8000
node --test                      # tests (Node 18+, no dependencies)
docker-compose up                # http://localhost:8090
```

Docker serves the site with nginx (with gzip on) behind Traefik. The domain comes from `IMI_TIMETRAVEL_DOMAIN` in `.env`.

## Data

| File | What | Source |
|---|---|---|
| `data/national.json` | IMI collected on urban property and the number of taxed urban properties, 2013–2025 | [Autoridade Tributária, Estatísticas do Património](https://info.portaldasfinancas.gov.pt/pt/dgci/divulgacao/estatisticas/estatisticas_patrimonio/Pages/IMI.aspx) |
| `data/municipalities.json` | IMI, IMT and current revenue per municipality; dwelling counts | [DGAL, Contas de Gerência](https://portalautarquico.dgal.gov.pt/pt-PT/financas-locais/dados-financeiros/contas-de-gerencia/); [INE, indicator 0008329](https://www.ine.pt/xurl/indx/0008329/PT) |
| `data/vpt_components.json` | Construction value per year, triennial update coefficients, ageing table and zonamento revisions | CIMI and the portarias cited in the file |
| `data/indices.json` | Construction costs of new housing and house prices, yearly averages | [INE 0011748](https://www.ine.pt/xurl/indx/0011748/PT), [INE 0014765](https://www.ine.pt/xurl/indx/0014765/PT) |
| `data/rates.json` | Urban IMI rate per municipality and year from 2013 (complete years only), plus freguesia rates | [Portal das Finanças, Consultar Taxas IMI](https://www.portaldasfinancas.gov.pt/pt/main.jsp?body=/imi/consultarTaxasIMIForm.jsp) |
| `data/map.json` | Pre-projected SVG paths for the 308 municipalities and 20 districts/regions | [DGT, CAOP 2025](https://www.dgterritorio.gov.pt/cartografia/cartografia-tematica/caop) |
| `data/inflation_pt.json` | Euro-area HICP, December on December (shared with the IRS project) | Eurostat |

### How the numbers are built

- **Tax year.** IMI for year N is billed and paid in N+1. Everything is indexed by tax year, so DGAL's municipal accounts for year N+1 are counted under N.
- **Inflation.** Each value is converted to today's euros from the year it was paid.
- **National vs municipal.** The national headline uses AT's exact figure per urban property, which exists only for the country as a whole. Municipal figures divide IMI revenue by INE's dwelling count ("IMI per dwelling"). The district and national comparison lines in a municipality's detail are calculated the same way, so they can be compared directly.
- **IMI vs IMT** uses the year the money came in, because IMT is paid at the moment of purchase.
- **Current revenue** (*receitas correntes*) is chapters 01–08 of the budget classification: taxes, fees, current transfers and sales. It excludes loans, asset sales and capital transfers.
- **Known gaps.**
  - INE's dwelling series ends in 2022; later years are extrapolated and flagged with ⚠️.
  - INE's 2020 dwelling count is out of line with 2019 and 2021 (both close to the 2021 Census) by up to 14%, so 2020 uses the midpoint of the two.
  - Penedono has no DGAL accounts from 2019 onwards.
  - Porto Moniz's 2023 IMI is negative after refunds and is treated as missing.
  - Large swings in a few small municipalities are usually hydroelectric dams, whose IMI has been litigated and refunded.

The page's *Metodologia* section explains all of this to readers.

## Updating the data

The site never runs the scripts in `scripts/`; they regenerate the JSON in `data/`. They need Python 3.10+. `fetch_rates.py`, `fetch_indices.py` and `archive_sources.py` use only the standard library; the others need:

```bash
pip install -r scripts/requirements.txt
```

Each year:

1. Add the new year to `data/national.json` from AT's latest IMI statistics edition (collected IMI, taxed properties, and the taxed and exempt urban VPT), with its `source.url`.
2. When DGAL publishes a new year of *contas de gerência*, add its "Demonstração de Execução Orçamental da Receita" file to `DOREC` in `scripts/build_revenue.py`, then run `python3 scripts/build_revenue.py`.
3. Run `python3 scripts/fetch_rates.py <first year> <last year>`.
4. Copy the latest `inflation_pt.json` from the IRS project.
5. Add the new construction value and triennial update coefficient to `data/vpt_components.json`.
6. Delete `scripts/.cache/ine` and run `python3 scripts/fetch_indices.py`.
7. Run `python3 scripts/archive_sources.py`. It backs up every source on the Internet Archive and checks that each snapshot holds the real document (`--check` only verifies).
8. Run `node --test`.

The map only changes with a new CAOP edition:

```bash
python3 scripts/build_map.py <folder with the CAOP .gpkg files>
python3 scripts/check_map.py <same folder>   # compares the published map with the official boundaries
```

Downloads are cached in `scripts/.cache/`, which git ignores.
