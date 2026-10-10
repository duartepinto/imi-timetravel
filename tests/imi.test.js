// Run with:  node --test          (from the repo root; needs Node 18+)
//
// No dependencies, no build step. script.js is loaded into a VM with no
// document, so only its calculation functions are defined; the tests call
// them on the real data files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

const app = {};
vm.createContext(app);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8') +
    '\n;Object.assign(this, { FIRST_YEAR, SMALL_MUNICIPALITY, METRICS, inflationRate, inflationFactor, paymentYear, toReal, countValue, nationalSeries, aggregate, seriesFromYears, metricChange, ranking, changeClass, slugify, rateSeries, revenueByReceiptYear });', app);

const inflation = read('inflation_pt.json');
const national = read('national.json');
const municipal = read('municipalities.json');
const rates = read('rates.json');
const map = read('map.json');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// --- inflation -------------------------------------------------------------

test('inflation applies year N to the N -> N+1 step', () => {
    close(app.inflationFactor(inflation, 2024, 2025), 1 + inflation['2024'] / 100);
    close(app.inflationFactor(inflation, 2023, 2025), (1 + inflation['2023'] / 100) * (1 + inflation['2024'] / 100));
    close(app.inflationFactor(inflation, 2025, 2025), 1);
});

test('an estimated inflation entry reads its value', () => {
    assert.equal(app.inflationRate({ 2026: { value: 3.8, estimate: true } }, 2026), 3.8);
});

test('IMI is deflated from the year it is paid, not the tax year', () => {
    // IMI of 2024 is paid in 2025: in euros of 2025 it is unchanged.
    close(app.toReal(100, 2024, 2025, inflation), 100);
    close(app.toReal(100, 2023, 2025, inflation), 100 * (1 + inflation['2024'] / 100));
});

// --- national ----------------------------------------------------------------

test('national series covers every year from 2013 and cites a source', () => {
    const years = national.years.map(r => r.year);
    assert.equal(years[0], app.FIRST_YEAR);
    years.forEach((y, i) => assert.equal(y, app.FIRST_YEAR + i, 'no gaps'));
    for (const row of national.years) {
        assert.ok(row.collected > 1e9 && row.taxedProperties > 6e6, `${row.year} looks wrong`);
        assert.match(row.source.url, /^https:\/\/info\.portaldasfinancas\.gov\.pt\//);
    }
});

test('national real IMI per property fell while nominal rose (2013 vs latest)', () => {
    const last = national.years[national.years.length - 1].year;
    const series = app.nationalSeries(national, inflation, last + 1);
    const first = series[0], end = series[series.length - 1];
    close(first.nominal, 1490096000 / 6876820, 1e-6);
    assert.ok(end.nominal > first.nominal);
    assert.ok(end.real < first.real);
    close(end.real, end.nominal, 1e-9); // the latest year is paid in the target year
});

// --- municipal data ----------------------------------------------------------

test('all 308 municipalities, keyed by the map codes', () => {
    const codes = Object.keys(municipal.municipalities).sort();
    assert.equal(codes.length, 308);
    assert.deepEqual(codes, map.municipalities.map(m => m.code).sort());
});

test('every municipality has IMI, current revenue and dwellings from 2013', () => {
    const years = Object.keys(municipal.municipalities['1106'].years).map(Number);
    const last = Math.max(...years);
    for (const [code, m] of Object.entries(municipal.municipalities)) {
        for (let y = app.FIRST_YEAR; y <= last; y++) {
            const row = m.years[y];
            if (!row) {
                // The DGAL has no accounts for Penedono from 2020 (tax year 2019).
                assert.equal(m.name, 'Penedono', `${m.name} missing ${y}`);
                continue;
            }
            // Net of refunds: only Porto Moniz 2023 dips below zero (see validImi).
            assert.ok(row.imi > 0 || (code === '3106' && y === 2023), `${m.name} ${y} imi`);
            assert.ok(row.current > row.imi, `${m.name} ${y}: IMI is part of current revenue`);
            assert.ok(app.countValue(row.dwellings) > 100, `${m.name} ${y} dwellings`);
        }
    }
});

test('municipal IMI adds up to the published totals', () => {
    // DGO: municipalities received 1 504 M€ of IMI in 2023 (tax year 2022).
    const total = Object.values(municipal.municipalities).reduce((s, m) => s + (m.years['2022'] ? m.years['2022'].imi : 0), 0);
    assert.ok(Math.abs(total / 1e6 - 1504) < 5, `${total / 1e6}`);
});

test('extrapolated dwellings are flagged as estimates', () => {
    const lisboa = municipal.municipalities['1106'];
    const flagged = Object.entries(lisboa.years).filter(([, r]) => typeof r.dwellings === 'object').map(([y]) => Number(y));
    assert.ok(flagged.length >= 1);
    assert.ok(flagged.every(y => y > 2022), 'the INE series runs to 2022');
    assert.ok(flagged.every(y => lisboa.years[y].dwellings.estimate === true));
});

test('dwelling counts have no one-year spikes', () => {
    // The housing stock moves slowly (largest real change about 4% in a year).
    // INE's raw 2020 value jumped up to 14% and back; build_revenue.py smooths it.
    for (const m of Object.values(municipal.municipalities)) {
        for (const [y, row] of Object.entries(m.years)) {
            const prev = m.years[Number(y) - 1];
            if (!prev) continue;
            const change = app.countValue(row.dwellings) / app.countValue(prev.dwellings) - 1;
            assert.ok(Math.abs(change) < 0.05, `${m.name} ${y}: ${(change * 100).toFixed(1)}%`);
        }
    }
});

// --- aggregation and metrics ---------------------------------------------------

test('aggregate skips a municipality in a year it lacks data', () => {
    const years = app.aggregate([
        { years: { 2013: { imi: 10, current: 100, dwellings: 5 }, 2014: { imi: 10, current: 100, dwellings: 5 } } },
        { years: { 2013: { imi: 30, current: 100, dwellings: { value: 5, estimate: true } } } }
    ]);
    // JSON round trip: the objects come from the VM's realm.
    assert.deepEqual(JSON.parse(JSON.stringify(years)), {
        2013: { imi: 40, current: 200, dwellings: 10, estimate: true, count: 2 },
        2014: { imi: 10, current: 100, dwellings: 5, estimate: false, count: 1 }
    });
});

test('a year with zero or negative net IMI is treated as missing', () => {
    const series = app.seriesFromYears({ 2023: { imi: -5, current: 1000, dwellings: 4 } }, inflation, 2025);
    assert.equal(series[0].nominal, null);
    assert.equal(series[0].share, null);
    assert.equal(app.aggregate([{ years: { 2023: { imi: -5, current: 1000, dwellings: 4 } } }])['2023'], undefined);
});

test('metrics: per dwelling, real, and share of current revenue', () => {
    const series = app.seriesFromYears({ 2023: { imi: 200, current: 1000, dwellings: 4 } }, inflation, 2025);
    close(series[0].nominal, 50);
    close(series[0].real, 50 * (1 + inflation['2024'] / 100));
    close(series[0].share, 0.2);
});

test('change is relative for euros and in points for the share', () => {
    const series = [
        { year: 2013, real: 100, share: 0.25 },
        { year: 2023, real: 80, share: 0.20 }
    ];
    close(app.metricChange(series, 'real', 2013, 2023), -0.2);
    close(app.metricChange(series, 'share', 2013, 2023), -5);
    assert.equal(app.metricChange(series, 'real', 2013, 2024), null);
});

test('ranking orders by change and can drop small municipalities', () => {
    const e = (name, d, a, b) => ({ name, series: [{ year: 2013, real: a, dwellings: d }, { year: 2023, real: b, dwellings: d }] });
    const list = [e('big-up', 9000, 100, 130), e('small-down', 500, 100, 50), e('big-down', 9000, 100, 90)];
    assert.deepEqual(app.ranking(list, 'real', 2013, 2023).map(x => x.name), ['small-down', 'big-down', 'big-up']);
    assert.deepEqual(app.ranking(list, 'real', 2013, 2023, { excludeSmall: true }).map(x => x.name), ['big-down', 'big-up']);
});

test('change classes are symmetric around a neutral band', () => {
    assert.equal(app.changeClass(0.01, 'real'), 0);
    assert.equal(app.changeClass(-0.05, 'real'), -1);
    assert.equal(app.changeClass(0.25, 'nominal'), 3);
    assert.equal(app.changeClass(-0.9, 'real'), -4);
    assert.equal(app.changeClass(-4, 'share'), -2);
    assert.equal(app.changeClass(null, 'real'), null);
});

test('slugs are unique within each district', () => {
    assert.equal(app.slugify('Vila Nova de Gaia'), 'vila-nova-de-gaia');
    assert.equal(app.slugify('Região Autónoma dos Açores'), 'regiao-autonoma-dos-acores');
    const seen = new Set();
    for (const m of map.municipalities) {
        const key = `${m.district}/${app.slugify(m.name)}`;
        assert.ok(!seen.has(key), key);
        seen.add(key);
    }
});

// --- IMI vs IMT --------------------------------------------------------------

test('IMI and IMT are plotted and deflated by the year they were received', () => {
    const series = app.revenueByReceiptYear([
        { years: { 2022: { imi: 100, imt: 50 }, 2023: { imi: -1, imt: 70 } } },
        { years: { 2022: { imi: 10, imt: 5 } } }
    ], inflation, 2025);
    assert.equal(series.length, 1, 'a year with net IMI <= 0 is skipped');
    assert.equal(series[0].year, 2023);
    close(series[0].imi, 110);
    close(series[0].imtReal, 55 * (1 + inflation['2023'] / 100) * (1 + inflation['2024'] / 100));
});

test('every municipality has IMT next to IMI', () => {
    for (const m of Object.values(municipal.municipalities)) {
        for (const [y, row] of Object.entries(m.years)) assert.ok(row.imt >= 0, `${m.name} ${y}`);
    }
    // ECO/DGAL: IMT overtook IMI in the municipalities' accounts (cash year 2022 = key 2021).
    const sum = (key, field) => Object.values(municipal.municipalities).reduce((s, m) => s + (m.years[key] ? m.years[key][field] : 0), 0);
    assert.ok(sum('2021', 'imt') > sum('2021', 'imi'));
    assert.ok(sum('2019', 'imt') < sum('2019', 'imi'));
});

// --- rates -------------------------------------------------------------------

test('rates exist for every municipality and stay within the legal range', () => {
    assert.deepEqual(Object.keys(rates.municipalities).sort(), map.municipalities.map(m => m.code).sort());
    for (const [code, m] of Object.entries(rates.municipalities)) {
        for (const [year, row] of Object.entries(m.years)) {
            // 0.3%-0.5% until 2015, 0.3%-0.45% since 2016, except municipalities under financial
            // recovery (FAM, Lei 53/2014), which had to charge up to 0.5% (e.g. Vila Real de Santo António).
            const [lo, hi] = [0.003, 0.005];
            assert.ok(row.urban >= lo - 1e-9 && row.urban <= hi + 1e-9, `${m.name} ${year}: ${row.urban}`);
        }
        assert.ok(app.rateSeries(rates, code).length >= 10, m.name);
    }
});

// --- map -----------------------------------------------------------------------

test('map has 20 districts/regions and a path for every municipality', () => {
    assert.equal(map.districts.length, 20);
    const districts = new Set(map.districts.map(d => d.code));
    for (const m of map.municipalities) {
        assert.ok(m.path.startsWith('M'), m.name);
        assert.ok(districts.has(m.district), m.name);
    }
});
