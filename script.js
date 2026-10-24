'use strict';

// ===========================================================================
// Calculations. Pure functions over the JSON in data/, no DOM. The tests load
// this file into a VM without a document and call these directly.
// ===========================================================================

const FIRST_YEAR = 2013;
const SMALL_MUNICIPALITY = 3000; // dwellings in the first year

// Value of an inflation entry: a plain number, or {value, estimate}.
function inflationRate(inflation, year) {
    const entry = inflation[String(year)];
    if (entry === undefined) return undefined;
    return typeof entry === 'object' ? entry.value : entry;
}

// Euros paid in `fromYear` expressed in euros of `toYear`. Rates are
// December-on-December, so year N's rate moves money from N to N+1.
function inflationFactor(inflation, fromYear, toYear) {
    let factor = 1;
    for (let y = fromYear; y < toYear; y++) {
        const rate = inflationRate(inflation, y);
        if (rate === undefined) throw new Error(`no inflation for ${y}`);
        factor *= 1 + rate / 100;
    }
    return factor;
}

// IMI for tax year N is paid in N+1: that is the year its euros belong to.
function paymentYear(taxYear) {
    return taxYear + 1;
}

function toReal(value, taxYear, targetYear, inflation) {
    return value * inflationFactor(inflation, paymentYear(taxYear), targetYear);
}

// Dwelling counts are numbers, or {value, estimate} when extrapolated.
function countValue(entry) {
    if (entry === undefined || entry === null) return undefined;
    return typeof entry === 'object' ? entry.value : entry;
}

function isEstimate(entry) {
    return Boolean(entry && typeof entry === 'object' && entry.estimate);
}

// National series from the AT: IMI collected per taxed urban property.
function nationalSeries(national, inflation, targetYear) {
    return national.years.map(row => {
        const perProperty = row.collected / row.taxedProperties;
        return {
            year: row.year,
            collected: row.collected,
            taxedProperties: row.taxedProperties,
            nominal: perProperty,
            real: toReal(perProperty, row.year, targetYear, inflation)
        };
    });
}

// The DGAL figures are net of refunds, so a year of large refunds can come
// out at zero or below (Porto Moniz, 2023). That is not a tax burden; such a
// year is treated as missing.
function validImi(imi) {
    return imi != null && imi > 0;
}

// Sum IMI, current revenue and dwellings over a set of municipalities, year by
// year. A municipality only counts in a year where it has all three, so the
// ratios never mix a numerator and a denominator from different places.
function aggregate(municipalities) {
    const years = {};
    for (const m of municipalities) {
        for (const [year, row] of Object.entries(m.years)) {
            const dwellings = countValue(row.dwellings);
            if (!validImi(row.imi) || row.current == null || !dwellings) continue;
            const acc = years[year] ||= { imi: 0, current: 0, dwellings: 0, estimate: false, count: 0 };
            acc.imi += row.imi;
            acc.current += row.current;
            acc.dwellings += dwellings;
            acc.estimate ||= isEstimate(row.dwellings);
            acc.count += 1;
        }
    }
    return years;
}

// One row per year: the three metrics the site can show.
function seriesFromYears(years, inflation, targetYear) {
    return Object.keys(years).map(Number).sort((a, b) => a - b).map(year => {
        const row = years[year];
        const dwellings = countValue(row.dwellings);
        const ok = validImi(row.imi) && dwellings;
        const nominal = ok ? row.imi / dwellings : null;
        return {
            year,
            imi: row.imi,
            current: row.current,
            dwellings,
            estimate: isEstimate(row.dwellings) || Boolean(row.estimate),
            nominal,
            real: nominal == null ? null : toReal(nominal, year, targetYear, inflation),
            share: validImi(row.imi) && row.current ? row.imi / row.current : null
        };
    });
}

// IMI and IMT by the year the money reached the municipalities. Both are
// stored under the IMI tax year N, i.e. received in N+1; IMT is paid at
// purchase, so N+1 is also its own year. Each value is deflated from N+1.
function revenueByReceiptYear(municipalities, inflation, targetYear) {
    const years = {};
    for (const m of municipalities) {
        for (const [taxYear, row] of Object.entries(m.years)) {
            if (!validImi(row.imi) || row.imt == null) continue;
            const acc = years[taxYear] ||= { imi: 0, imt: 0, count: 0 };
            acc.imi += row.imi;
            acc.imt += row.imt;
            acc.count += 1;
        }
    }
    return Object.keys(years).map(Number).sort((a, b) => a - b).map(taxYear => {
        const { imi, imt, count } = years[taxYear];
        const factor = inflationFactor(inflation, paymentYear(taxYear), targetYear);
        return { year: paymentYear(taxYear), imi, imt, imiReal: imi * factor, imtReal: imt * factor, count };
    });
}

const METRICS = {
    real: {
        label: 'IMI por alojamento, a preços de hoje',
        short: 'IMI real por alojamento',
        change: 'relative'
    },
    nominal: {
        label: 'IMI por alojamento, em euros correntes',
        short: 'IMI nominal por alojamento',
        change: 'relative'
    },
    share: {
        label: 'IMI em % das receitas correntes',
        short: 'IMI em % das receitas correntes',
        change: 'points'
    }
};

// Change of a metric between the first year and the last year of the
// period: a fraction for euro metrics, percentage points for the share.
function metricChange(series, metric, firstYear, lastYear) {
    const first = series.find(r => r.year === firstYear);
    const last = series.find(r => r.year === lastYear);
    if (!first || !last || first[metric] == null || last[metric] == null) return null;
    return METRICS[metric].change === 'points'
        ? (last[metric] - first[metric]) * 100
        : last[metric] / first[metric] - 1;
}

// Every municipality with its change, smallest (biggest fall) first.
// Municipalities without both end years are left out.
function ranking(entries, metric, firstYear, lastYear, { excludeSmall = false } = {}) {
    return entries
        .filter(e => !excludeSmall || (e.series[0] && e.series[0].dwellings >= SMALL_MUNICIPALITY))
        .map(e => ({ ...e, change: metricChange(e.series, metric, firstYear, lastYear) }))
        .filter(e => e.change !== null)
        .sort((a, b) => a.change - b.change);
}

// Diverging classes, -4..4. Euro metrics are binned on % change, the share on
// percentage points; 0 is the neutral band.
const CLASS_BREAKS = {
    relative: [0.03, 0.10, 0.20, 0.30],
    points: [1, 3, 5, 8]
};

function changeClass(change, metric) {
    if (change == null) return null;
    const breaks = CLASS_BREAKS[METRICS[metric].change];
    const size = Math.abs(change);
    let step = 0;
    while (step < breaks.length && size >= breaks[step]) step++;
    return Math.sign(change) * step;
}

function slugify(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// The urban rate for each tax year, from data/rates.json.
function rateSeries(rates, code) {
    const entry = rates.municipalities[code];
    if (!entry) return [];
    return Object.entries(entry.years).map(([year, row]) => ({
        year: Number(year),
        urban: row.urban,
        byFreguesia: Boolean(row.byFreguesia),
        freguesias: row.freguesias || [],
        familiar: row.familiar || null
    })).sort((a, b) => a.year - b.year);
}

// "20 / 40 / 70 €" (a deduction), "10 / 15 / 20%" (2015's rate cut), for 1, 2
// and 3 or more dependents; "—" where the municipality does not apply it.
function familiarLabel(familiar) {
    if (!familiar) return null;
    const value = k => familiar.amounts[k] == null ? '—'
        : familiar.type === 'reduction' ? String(Math.round(familiar.amounts[k] * 100)) : String(familiar.amounts[k]);
    return `${['1', '2', '3+'].map(value).join(' / ')}${familiar.type === 'reduction' ? '%' : ' €'}`;
}

// --- what IMI is made of -----------------------------------------------------

// Prices between two tax years, measured like everything else from the year
// each IMI is paid.
function priceIndex(inflation, fromYear, year) {
    return inflationFactor(inflation, paymentYear(fromYear), paymentYear(year));
}

// IMI per property = VPT per property × effective rate, from the AT figures.
// The index columns are 100 in the first year.
function decomposition(national, inflation) {
    const first = national.years[0];
    const base = {
        imi: first.collected / first.taxedProperties,
        vpt: first.taxedVpt / first.taxedProperties,
        rate: first.collected / first.taxedVpt
    };
    return national.years.map(row => {
        const imi = row.collected / row.taxedProperties;
        const vpt = row.taxedVpt / row.taxedProperties;
        const rate = row.collected / row.taxedVpt;
        return {
            year: row.year,
            vptPerProperty: vpt,
            effectiveRate: rate,
            exemptShare: row.exemptVpt / (row.taxedVpt + row.exemptVpt),
            imi: 100 * imi / base.imi,
            vpt: 100 * vpt / base.vpt,
            rate: 100 * rate / base.rate,
            prices: 100 * priceIndex(inflation, first.year, row.year)
        };
    });
}

function constructionValueAt(components, year) {
    const entry = components.constructionValue.years.find(r => r.year === year);
    if (!entry) throw new Error(`no construction value for ${year}`);
    return entry.base;
}

// Vc in force each year next to what it should follow: construction costs
// (INE) and prices. Indices are 100 in the first year.
function constructionValueSeries(components, indices, inflation, years) {
    const vc0 = constructionValueAt(components, years[0]);
    const costs = indices.constructionCosts.years;
    const c0 = costs[String(years[0])];
    return years.map(year => {
        const vc = constructionValueAt(components, year);
        const c = costs[String(year)];
        return {
            year, vc,
            vcIndex: 100 * vc / vc0,
            costs: c == null ? null : 100 * c / c0,
            prices: 100 * priceIndex(inflation, years[0], year)
        };
    });
}

// Cumulative VPT multiplier of a home valued in `valuedIn`, updated every
// three years (art. 138.º): with the 75% the law applies to housing, with the
// full coefficient, and with prices. The gap to prices is split in two shares
// of the price-indexed value that add up to the whole loss: what the 75% rule
// costs, and what updating late (every three years, by a lagged and different
// index) costs.
function triennialPaths(components, inflation, years, { valuedIn = 2012 } = {}) {
    const { updates, housingShare } = components.triennialUpdates;
    let last = valuedIn, actual = 1, full = 1;
    return years.filter(y => y >= valuedIn).map(year => {
        let coefficient = null;
        if (year - last === 3) {
            const update = updates.find(u => u.year === year);
            if (!update) throw new Error(`no triennial update for ${year}`);
            coefficient = update.coefficient;
            actual *= 1 + housingShare * (coefficient - 1);
            full *= coefficient;
            last = year;
        }
        const prices = priceIndex(inflation, valuedIn, year);
        return {
            year, coefficient, actual, full, prices,
            lossRule: (full - actual) / prices,
            lossTiming: (prices - full) / prices
        };
    });
}

function ageingCoefficient(components, age) {
    return components.ageing.brackets.find(b => b.maxAge === null || age <= b.maxAge).cv;
}

// An example home built in `built` and valued in `valuedIn`: its VPT with the
// triennial updates only (what it pays), and what a new valuation would give
// each year, with the Vc of that year and the Cv of its age then. Everything
// else in the formula is held equal. 100 = VPT in `valuedIn`.
function ageingExample(components, inflation, years, { built = 2005, valuedIn = 2012 } = {}) {
    const vc0 = constructionValueAt(components, valuedIn);
    const cv0 = ageingCoefficient(components, valuedIn - built);
    return triennialPaths(components, inflation, years, { valuedIn }).map(row => ({
        year: row.year,
        age: row.year - built,
        cv: ageingCoefficient(components, row.year - built),
        current: 100 * row.actual,
        reassessed: 100 * (constructionValueAt(components, row.year) / vc0) *
            (ageingCoefficient(components, row.year - built) / cv0),
        prices: 100 * row.prices
    }));
}

// Average urban rate set by the municipalities, each weighted by its taxable
// base (IMI ÷ rate), so it is comparable with the effective rate. Years after
// the last municipal accounts keep the weights of that last year. The share at
// the 0.3% minimum counts every municipality with a rate, weights or not.
function averageRate(municipalData, rates, years) {
    const municipalities = Object.entries(municipalData.municipalities);
    const accountYears = municipalities.flatMap(([, m]) => Object.keys(m.years).map(Number));
    const lastAccounts = Math.max(...accountYears);
    return years.map(year => {
        const weightYear = Math.min(year, lastAccounts);
        let imi = 0, base = 0, count = 0;
        for (const [code, m] of municipalities) {
            const own = m.years[weightYear];
            const entry = rates.municipalities[code];
            const rate = entry && entry.years[year] && entry.years[year].urban;
            const weightRate = entry && entry.years[weightYear] && entry.years[weightYear].urban;
            if (!own || !validImi(own.imi) || !rate || !weightRate) continue;
            const weight = own.imi / weightRate;
            imi += rate * weight;
            base += weight;
            count += 1;
        }
        const set = Object.values(rates.municipalities).map(m => m.years[year] && m.years[year].urban).filter(Boolean);
        const atMinimum = set.length ? set.filter(rate => rate <= 0.003).length / set.length : null;
        return { year, rate: count ? imi / base : null, atMinimum, estimatedWeights: year > lastAccounts };
    });
}

// IMI Familiar (art. 112.º-A) by year: how many municipalities apply it, the
// share of dwellings they hold, and the amounts most of them apply and the
// highest any applies (a rate cut in 2015, euros per household from 2016).
// Years after the last dwelling counts reuse those counts.
function familiarSeries(rates, municipalData, years) {
    const dwellingYears = Object.values(municipalData.municipalities).flatMap(m => Object.keys(m.years).map(Number));
    const lastDwellings = Math.max(...dwellingYears);
    const mode = values => {
        const counts = {};
        for (const v of values) counts[v] = (counts[v] || 0) + 1;
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return best ? Number(best[0]) : null;
    };
    return years.map(year => {
        let municipalities = 0, applying = 0, dwellings = 0, covered = 0;
        const amounts = { '1': [], '2': [], '3+': [] };
        let type = null;
        for (const [code, entry] of Object.entries(rates.municipalities)) {
            const row = entry.years[year];
            if (!row) continue;
            municipalities += 1;
            const own = municipalData.municipalities[code];
            const count = own && own.years[Math.min(year, lastDwellings)] && countValue(own.years[Math.min(year, lastDwellings)].dwellings);
            if (count) dwellings += count;
            if (!row.familiar) continue;
            applying += 1;
            if (count) covered += count;
            type = row.familiar.type;
            for (const [k, v] of Object.entries(row.familiar.amounts)) amounts[k].push(v);
        }
        return {
            year, type, applying,
            share: municipalities ? applying / municipalities : null,
            dwellingShare: dwellings ? covered / dwellings : null,
            amounts: applying ? { '1': mode(amounts['1']), '2': mode(amounts['2']), '3+': mode(amounts['3+']) } : null,
            maximum: applying ? { '1': Math.max(...amounts['1']), '2': Math.max(...amounts['2']), '3+': Math.max(...amounts['3+']) } : null
        };
    });
}

// ===========================================================================
// UI
// ===========================================================================

const fmt = {
    euro: v => v == null ? '—' : v.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }),
    euro2: v => v == null ? '—' : v.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    millions: v => v == null ? '—' : (v / 1e6).toLocaleString('pt-PT', { maximumFractionDigits: 0 }) + ' M€',
    pct: v => v == null ? '—' : (v * 100).toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%',
    rate: v => v == null ? '—' : (v * 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + '%',
    int: v => v == null ? '—' : v.toLocaleString('pt-PT'),
    money: v => v == null ? '—' : v === 0 ? '0 €' : Math.abs(v) >= 1e6
        ? (v / 1e6).toLocaleString('pt-PT', { maximumFractionDigits: Math.abs(v) >= 1e8 ? 0 : 1 }) + ' M€'
        : (v / 1e3).toLocaleString('pt-PT', { maximumFractionDigits: 0 }) + ' mil €',
    signedPct: v => v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%',
    signedPoints: v => v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' p.p.'
};

function formatMetric(metric, value) {
    return metric === 'share' ? fmt.pct(value) : fmt.euro(value);
}

function formatChange(metric, change) {
    return METRICS[metric].change === 'points' ? fmt.signedPoints(change) : fmt.signedPct(change);
}

const COLORS = {
    real: '#2a78d6',
    district: '#eb6834',
    national: '#1baf7a',
    nominal: '#898781',
    imt: '#eb6834',
    vpt: '#1baf7a',
    rate: '#eb6834',
    prices: '#898781',
    loss: '#c3c2b7',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    ink: '#333',
    muted: '#6b6a65'
};

// Diverging fill per class: blue arm = IMI fell, red arm = IMI rose.
const CLASS_FILL = {
    '-4': '#184f95', '-3': '#2a78d6', '-2': '#6da7ec', '-1': '#b7d3f6',
    '0': '#f0efec',
    '1': '#f6c7c2', '2': '#ef9a92', '3': '#e34948', '4': '#a8302f'
};
const NO_DATA_FILL = '#ffffff';

const el = id => document.getElementById(id);

// Text of the descriptions lives in index.html; only the numbers come from
// the data, into <span data-value="key"> placeholders.
function fill(values) {
    for (const [key, value] of Object.entries(values)) {
        for (const node of document.querySelectorAll(`[data-value="${key}"]`)) node.textContent = value;
    }
}

// "a, b e c"
function listPt(items) {
    const list = items.map(String);
    return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

function html(strings, ...values) {
    const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const isRaw = v => v !== null && typeof v === 'object' && '__html' in v;
    return strings.reduce((out, s, i) => out + s + (i < values.length ? (isRaw(values[i]) ? values[i].__html : escape(values[i])) : ''), '');
}
const raw = s => ({ __html: s });

class App {
    async init() {
        const load = f => fetch(`data/${f}`).then(r => {
            if (!r.ok) throw new Error(`${f}: ${r.status}`);
            return r.json();
        });
        [this.nationalData, this.municipalData, this.rates, this.map, this.inflation, this.components, this.indices] = await Promise.all(
            ['national.json', 'municipalities.json', 'rates.json', 'map.json', 'inflation_pt.json', 'vpt_components.json', 'indices.json'].map(load));

        this.nationalRows = this.nationalData.years;
        this.lastNationalYear = Math.max(...this.nationalRows.map(r => r.year));
        this.targetYear = paymentYear(this.lastNationalYear);
        this.metric = 'share';
        this.excludeSmall = true;
        this.charts = {};

        this.buildEntities();
        this.renderHeadline();
        this.renderNationalChart();
        this.renderComponents();
        this.revenueMode = 'real';
        this.renderRevenue();
        this.buildMap();
        this.bindControls();
        this.renderSources();
        window.addEventListener('hashchange', () => this.route());
        this.route();
    }

    buildEntities() {
        const shapes = Object.fromEntries(this.map.municipalities.map(m => [m.code, m]));
        this.municipalities = Object.entries(this.municipalData.municipalities).map(([code, m]) => ({
            code,
            name: shapes[code].name,
            district: m.district,
            districtName: shapes[code].districtName,
            slug: slugify(shapes[code].name),
            raw: m,
            series: seriesFromYears(m.years, this.inflation, this.targetYear)
        }));
        const years = this.municipalities.flatMap(m => m.series.map(r => r.year));
        this.lastMunicipalYear = Math.max(...years);

        this.districts = this.map.districts.map(d => {
            const members = this.municipalities.filter(m => m.district === d.code);
            return {
                code: d.code, name: d.name, slug: slugify(d.name), members, shape: d,
                series: seriesFromYears(aggregate(members.map(m => m.raw)), this.inflation, this.targetYear)
            };
        });
        this.country = seriesFromYears(aggregate(this.municipalities.map(m => m.raw)), this.inflation, this.targetYear);
        this.national = nationalSeries(this.nationalData, this.inflation, this.targetYear);
        this.familiarFirstYear = Math.min(...Object.values(this.rates.municipalities)
            .flatMap(m => Object.entries(m.years).filter(([, row]) => row.familiar).map(([year]) => Number(year))));
    }

    // --- headline + national chart ---------------------------------------

    renderHeadline() {
        const first = this.national[0];
        const last = this.national[this.national.length - 1];
        const real = last.real / first.real - 1;
        const nominal = last.nominal / first.nominal - 1;
        const prices = inflationFactor(this.inflation, paymentYear(first.year), paymentYear(last.year)) - 1;
        el('headline').innerHTML = html`
            <p class="headline-lede">Desde ${first.year}, o IMI médio de um prédio urbano
            <strong>${real < 0 ? 'caiu' : 'subiu'} ${fmt.pct(Math.abs(real))}</strong> em termos reais.</p>
            <div class="stat-row">
                <div class="stat"><span class="stat-label">IMI médio por prédio, ${first.year}</span>
                    <span class="stat-value">${fmt.euro(first.real)}</span>
                    <span class="stat-note">a preços de ${this.targetYear} (${fmt.euro(first.nominal)} na altura)</span></div>
                <div class="stat"><span class="stat-label">IMI médio por prédio, ${last.year}</span>
                    <span class="stat-value">${fmt.euro(last.real)}</span>
                    <span class="stat-note">pago em ${paymentYear(last.year)}</span></div>
                <div class="stat"><span class="stat-label">Variação nominal</span>
                    <span class="stat-value">${fmt.signedPct(nominal)}</span>
                    <span class="stat-note">os preços subiram ${fmt.pct(prices)} no mesmo período</span></div>
            </div>`;
    }

    renderNationalChart() {
        const labels = this.national.map(r => String(r.year));
        this.charts.national = new Chart(el('nationalChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset(`A preços de ${this.targetYear}`, this.national.map(r => r.real), COLORS.real, { width: 2.5 }),
                    lineDataset('Em euros da altura', this.national.map(r => r.nominal), COLORS.nominal)
                ]
            },
            options: chartOptions({
                y: { ticks: { callback: v => fmt.euro(v) } },
                tooltip: ctx => `${ctx.dataset.label}: ${fmt.euro2(ctx.parsed.y)}`,
                title: year => `IMI de ${year} (pago em ${paymentYear(Number(year))})`,
                markers: [
                    { year: 2014, text: 'fim da avaliação geral' },
                    { year: 2015, text: 'IMI Familiar' }
                ]
            }),
            plugins: [endLabels(v => fmt.euro(v)), yearMarkers]
        });
    }

    // --- what IMI is made of -------------------------------------------------

    renderComponents() {
        const years = this.nationalRows.map(r => r.year);
        const labels = years.map(String);
        const index = v => v == null ? '—' : v.toLocaleString('pt-PT', { maximumFractionDigits: 1 });
        const indexAxis = { ticks: { callback: v => index(v) } };
        const indexTooltip = ctx => `${ctx.dataset.label}: ${index(ctx.parsed.y)}`;
        const pricesLine = (data, label = 'Preços') => lineDataset(label, data, COLORS.prices, { dash: [6, 4] });

        // IMI = VPT × rate
        const split = decomposition(this.nationalData, this.inflation);
        const first = split[0], end = split[split.length - 1];
        el('componentsStats').innerHTML = html`
            <div class="stat"><span class="stat-label">VPT médio por prédio, ${first.year} → ${end.year}</span>
                <span class="stat-value">${fmt.signedPct(end.vpt / 100 - 1)}</span>
                <span class="stat-note">${fmt.euro(first.vptPerProperty)} → ${fmt.euro(end.vptPerProperty)} · real: <strong>${fmt.signedPct(end.vpt / end.prices - 1)}</strong></span></div>
            <div class="stat"><span class="stat-label">Taxa efetiva</span>
                <span class="stat-value">${fmt.signedPct(end.rate / 100 - 1)}</span>
                <span class="stat-note">${fmt.rate(first.effectiveRate)} → ${fmt.rate(end.effectiveRate)}</span></div>
            <div class="stat"><span class="stat-label">IMI por prédio</span>
                <span class="stat-value">${fmt.signedPct(end.imi / 100 - 1)}</span>
                <span class="stat-note">real: <strong>${fmt.signedPct(end.imi / end.prices - 1)}</strong> · os preços subiram ${fmt.pct(end.prices / 100 - 1)}</span></div>`;
        this.replaceChart('components', el('componentsChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset('IMI por prédio', split.map(r => r.imi), COLORS.real, { width: 3 }),
                    lineDataset('VPT por prédio', split.map(r => r.vpt), COLORS.vpt),
                    lineDataset('Taxa efetiva', split.map(r => r.rate), COLORS.rate),
                    pricesLine(split.map(r => r.prices))
                ]
            },
            options: chartOptions({
                y: indexAxis,
                tooltip: indexTooltip,
                title: year => `IMI de ${year} (${first.year} = 100)`,
                markers: [
                    { year: 2015, text: 'IMI Familiar' },
                    { year: 2024, text: 'atualização trienal' }
                ]
            }),
            plugins: [endLabels(index), yearMarkers]
        });

        // Vc
        const vc = constructionValueSeries(this.components, this.indices, this.inflation, years);
        const vcFirst = vc[0], vcLast = vc[vc.length - 1];
        const latestVc = this.components.constructionValue.years[this.components.constructionValue.years.length - 1];
        fill({
            'vc-first': fmt.euro2(vcFirst.vc), 'vc-first-year': vcFirst.year,
            'vc-last': fmt.euro2(vcLast.vc), 'vc-last-year': vcLast.year,
            'vc-latest': fmt.euro2(latestVc.base), 'vc-latest-year': latestVc.year,
            'vc-costs': fmt.euro(vcFirst.vc * vcLast.costs / 100), 'vc-prices': fmt.euro(vcFirst.vc * vcLast.prices / 100)
        });
        el('vcLatest').hidden = latestVc.year === vcLast.year;
        this.replaceChart('vc', el('vcChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset('Vc', vc.map(r => r.vcIndex), COLORS.real, { width: 2.5, stepped: true }),
                    lineDataset('Custos de construção (INE)', vc.map(r => r.costs), COLORS.rate),
                    pricesLine(vc.map(r => r.prices))
                ]
            },
            options: chartOptions({
                y: indexAxis,
                tooltip: ctx => ctx.datasetIndex === 0
                    ? `Vc: ${fmt.euro2(vc[ctx.dataIndex].vc)}/m² (${index(ctx.parsed.y)})`
                    : indexTooltip(ctx),
                title: year => `Valor base de ${year}`
            }),
            plugins: [endLabels(index)]
        });

        // triennial update for a home valued in 2012 (the notes in index.html describe this example)
        const valuedIn = 2012;
        const homeYears = [valuedIn, ...years.filter(y => y > valuedIn)];
        const paths = triennialPaths(this.components, this.inflation, homeYears, { valuedIn });
        const pathEnd = paths[paths.length - 1];
        const steps = paths.filter(r => r.coefficient !== null);
        const coefficient = c => c.toLocaleString('pt-PT', { minimumFractionDigits: 2 });
        fill({
            'triennial-years': listPt(steps.map(r => r.year)),
            'triennial-coefficients': listPt(steps.map(r => coefficient(r.coefficient)))
        });
        this.replaceChart('triennial', el('triennialChart'), {
            type: 'line',
            data: {
                labels: homeYears.map(String),
                datasets: [
                    lineDataset('Com 75% (a lei)', paths.map(r => 100 * r.actual), COLORS.real, { width: 2.5, stepped: true }),
                    lineDataset('Com 100% do coeficiente', paths.map(r => 100 * r.full), COLORS.vpt, { stepped: true }),
                    pricesLine(paths.map(r => 100 * r.prices))
                ]
            },
            options: chartOptions({
                y: indexAxis,
                tooltip: indexTooltip,
                title: year => {
                    const row = paths.find(r => r.year === Number(year));
                    return row.coefficient === null ? year : `${year}: atualização, coeficiente ${row.coefficient.toLocaleString('pt-PT', { minimumFractionDigits: 2 })}`;
                }
            }),
            plugins: [endLabels(index)]
        });

        // what the 75% rule costs, against what updating late costs
        fill({
            'drag-year': pathEnd.year, 'drag-total': fmt.pct(pathEnd.lossRule + pathEnd.lossTiming),
            'drag-rule': fmt.pct(pathEnd.lossRule), 'drag-full': fmt.pct(pathEnd.full / pathEnd.actual - 1),
            'drag-timing': fmt.pct(pathEnd.lossTiming)
        });
        const dragOptions = chartOptions({
            x: { stacked: true },
            y: { stacked: true, min: 0, ticks: { callback: v => fmt.pct(v) } },
            tooltip: ctx => `${ctx.dataset.label}: ${fmt.pct(ctx.parsed.y)}`,
            title: year => `VPT abaixo dos preços em ${year}`
        });
        dragOptions.plugins.legend.labels.pointStyle = 'rect';
        this.replaceChart('drag', el('dragChart'), {
            type: 'bar',
            data: {
                labels: homeYears.map(String),
                datasets: [
                    barDataset('Regra dos 75%', paths.map(r => r.lossRule), COLORS.rate),
                    barDataset('Atualização tardia', paths.map(r => r.lossTiming), COLORS.loss)
                ]
            },
            options: dragOptions
        });

        // Cl
        const revision = this.components.location.revisions[this.components.location.revisions.length - 1];
        const priceBase = revision.inForce - 1; // the market the revision was prepared on
        const prices = this.indices.housePrices.years;
        const locationYears = years.filter(y => y >= priceBase && prices[String(y)] != null);
        const priceSeries = locationYears.map(y => 100 * prices[String(y)] / prices[String(priceBase)]);
        const interval = this.components.location.intervalYears;
        const due = locationYears.filter(y => y > revision.inForce && (y - revision.inForce) % interval === 0);
        fill({
            'location-portaria': revision.portaria, 'location-in-force': revision.inForce, 'location-base': priceBase,
            'location-rise': fmt.pct(priceSeries[priceSeries.length - 1] / 100 - 1)
        });
        this.replaceChart('location', el('locationChart'), {
            type: 'line',
            data: {
                labels: locationYears.map(String),
                datasets: [
                    lineDataset('Preços da habitação (INE)', priceSeries, COLORS.rate, { width: 2.5 }),
                    lineDataset('Coeficientes de localização', locationYears.map(() => 100), COLORS.real, { width: 2.5, stepped: true })
                ]
            },
            options: chartOptions({
                y: { min: 0, ...indexAxis },
                tooltip: indexTooltip,
                title: year => Number(year) === revision.inForce ? `${year}: revisão em vigor`
                    : due.includes(Number(year)) ? `${year}: revisão prevista na lei, não feita` : year,
                markers: [
                    { year: revision.inForce, text: 'revisão' },
                    ...due.map(year => ({ year, text: 'em falta' }))
                ]
            }),
            plugins: [endLabels(index), yearMarkers]
        });

        // Cv, on an example home built in 2005 (described in index.html)
        const built = 2005;
        const example = ageingExample(this.components, this.inflation, homeYears, { built, valuedIn });
        const exampleEnd = example[example.length - 1];
        fill({
            'ageing-cv-first': example[0].cv.toLocaleString('pt-PT'), 'ageing-age-first': example[0].age,
            'ageing-cv-last': exampleEnd.cv.toLocaleString('pt-PT'), 'ageing-age-last': exampleEnd.age,
            'ageing-year': exampleEnd.year, 'ageing-drop': fmt.pct(1 - exampleEnd.reassessed / exampleEnd.current)
        });
        this.replaceChart('ageing', el('ageingChart'), {
            type: 'line',
            data: {
                labels: homeYears.map(String),
                datasets: [
                    lineDataset('VPT atual (só atualizações)', example.map(r => r.current), COLORS.real, { width: 2.5, stepped: true }),
                    lineDataset('VPT se reavaliada nesse ano', example.map(r => r.reassessed), COLORS.rate, { stepped: true }),
                    pricesLine(example.map(r => r.prices))
                ]
            },
            options: chartOptions({
                y: indexAxis,
                tooltip: indexTooltip,
                title: year => {
                    const row = example.find(r => r.year === Number(year));
                    return `${year}: ${row.age} anos, Cv ${row.cv.toLocaleString('pt-PT', { minimumFractionDigits: 2 })}`;
                }
            }),
            plugins: [endLabels(index)]
        });

        // rate
        const avg = averageRate(this.municipalData, this.rates, years);
        const avgEnd = avg[avg.length - 1];
        const estimated = avg.filter(r => r.estimatedWeights).map(r => r.year);
        fill({
            'rate-last-year': avgEnd.year, 'rate-at-minimum-last': fmt.pct(avgEnd.atMinimum),
            'rate-first-year': avg[0].year, 'rate-at-minimum-first': fmt.pct(avg[0].atMinimum),
            'rate-estimated-years': listPt(estimated), 'rate-weights-year': estimated.length ? estimated[0] - 1 : ''
        });
        el('rateWeights').hidden = !estimated.length;
        this.replaceChart('avgRate', el('avgRateChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset('Taxa média das câmaras', avg.map(r => r.rate), COLORS.real, { width: 2.5 }),
                    lineDataset('Taxa efetiva (AT)', split.map(r => r.effectiveRate), COLORS.rate),
                    lineDataset('Máximo legal', years.map(y => y < 2016 ? 0.005 : 0.0045), COLORS.prices, { width: 1.5, stepped: true, dash: [6, 4] }),
                    lineDataset('Mínimo legal', years.map(() => 0.003), COLORS.prices, { width: 1.5, dash: [2, 3] })
                ]
            },
            options: chartOptions({
                y: { suggestedMin: 0.0028, suggestedMax: 0.0052, ticks: { callback: v => fmt.rate(v) } },
                tooltip: ctx => `${ctx.dataset.label}: ${fmt.rate(ctx.parsed.y)}`,
                title: year => `Taxas para o IMI de ${year}`
            }),
            plugins: [endLabels(v => fmt.rate(v))]
        });

        // IMI Familiar
        const familiar = familiarSeries(this.rates, this.municipalData, years).filter(r => r.applying > 0);
        const famFirst = familiar[0], famLast = familiar[familiar.length - 1];
        const deductions = familiar.filter(r => r.type === 'deduction');
        const dFirst = deductions[0];
        const sameAmounts = (a, b) => ['1', '2', '3+'].every(k => a[k] === b[k]);
        const dRaise = deductions.find(r => !sameAmounts(r.amounts, dFirst.amounts)) || dFirst;
        const euros = a => listPt(['1', '2', '3+'].map(k => a[k]));
        fill({
            'familiar-last-year': famLast.year, 'familiar-applying-last': famLast.applying,
            'familiar-share-last': fmt.pct(famLast.share), 'familiar-dwellings-last': fmt.pct(famLast.dwellingShare),
            'familiar-first-year': famFirst.year, 'familiar-applying-first': famFirst.applying,
            'familiar-share-first': fmt.pct(famFirst.share),
            'familiar-cuts': famFirst.type === 'reduction' ? listPt(['1', '2', '3+'].map(k => `${Math.round(famFirst.maximum[k] * 100)}%`)) : '',
            'familiar-deduction-year': dFirst.year, 'familiar-amounts-first': euros(dFirst.amounts),
            'familiar-amounts-last': euros(dRaise.amounts), 'familiar-raise-year': dRaise.year
        });
        const familiarOptions = chartOptions({
            y: { min: 0, max: 1, ticks: { callback: v => fmt.pct(v) } },
            tooltip: ctx => `${ctx.dataset.label}: ${fmt.pct(ctx.parsed.y)}`,
            title: year => `IMI Familiar de ${year}`
        });
        familiarOptions.plugins.legend.labels.pointStyle = 'rect';
        this.replaceChart('familiar', el('familiarChart'), {
            type: 'bar',
            data: {
                labels: familiar.map(r => String(r.year)),
                datasets: [
                    // A lower `order` is drawn on top: the line over the bars.
                    { type: 'bar', label: 'Municípios que o aplicam', data: familiar.map(r => r.share), backgroundColor: COLORS.real, borderWidth: 0, barPercentage: 0.7, order: 1 },
                    { ...lineDataset('Alojamentos nesses municípios', familiar.map(r => r.dwellingShare), COLORS.rate, { width: 2.5 }), type: 'line', order: 0 }
                ]
            },
            options: familiarOptions,
            plugins: [endLabels(v => fmt.pct(v))]
        });
        const dependents = [['1', '1 dependente', COLORS.real], ['2', '2 dependentes', COLORS.vpt], ['3+', '3 ou mais', COLORS.rate]];
        const amountOptions = chartOptions({
            y: { min: 0, ticks: { callback: v => fmt.euro(v) } },
            tooltip: ctx => `${ctx.dataset.label}: ${fmt.euro2(ctx.parsed.y)}`,
            title: year => `Dedução para o IMI de ${year}`
        });
        // The dashed inflation lines are explained in the note, not the legend.
        amountOptions.plugins.legend.labels.filter = item => !item.text.includes('inflação');
        this.replaceChart('familiarAmount', el('familiarAmountChart'), {
            type: 'line',
            data: {
                labels: deductions.map(r => String(r.year)),
                datasets: dependents.flatMap(([k, label, color]) => [
                    lineDataset(label, deductions.map(r => r.amounts[k]), color, { width: 2.5, stepped: true }),
                    lineDataset(`${label}, valor de ${dFirst.year} com a inflação`,
                        deductions.map(r => dFirst.amounts[k] * priceIndex(this.inflation, dFirst.year, r.year)), color, { width: 1.5, dash: [6, 4] })
                ])
            },
            options: amountOptions,
            plugins: [endLabels(v => fmt.euro(v))]
        });

        fill({
            'exempt-first': fmt.pct(first.exemptShare), 'exempt-first-year': first.year,
            'exempt-last': fmt.pct(end.exemptShare), 'exempt-last-year': end.year
        });
    }

    // --- IMI vs IMT ---------------------------------------------------------

    revenueChartConfig(series, real) {
        const imi = series.map(r => real ? r.imiReal : r.imi);
        const imt = series.map(r => real ? r.imtReal : r.imt);
        const suffix = real ? `, a preços de ${this.targetYear}` : ', em euros da altura';
        return {
            type: 'line',
            data: {
                labels: series.map(r => String(r.year)),
                datasets: [
                    lineDataset(`IMI${suffix}`, imi, COLORS.real, { width: 2.5 }),
                    lineDataset(`IMT${suffix}`, imt, COLORS.imt, { width: 2.5 })
                ]
            },
            options: chartOptions({
                y: { min: 0, ticks: { callback: v => fmt.money(v) } },
                tooltip: ctx => `${ctx.dataset.label}: ${fmt.money(ctx.parsed.y)}`,
                title: year => `Receita de ${year}`
            }),
            plugins: [endLabels(v => fmt.money(v))]
        };
    }

    renderRevenue() {
        const series = revenueByReceiptYear(this.municipalities.map(m => m.raw), this.inflation, this.targetYear);
        this.revenueSeries = series;
        const first = series[0], last = series[series.length - 1];
        const overtook = series.find(r => r.imt > r.imi);
        const real = this.revenueMode === 'real';
        const change = (a, b) => b / a - 1;
        el('revenueStats').innerHTML = html`
            <div class="stat"><span class="stat-label">IMI, ${first.year} → ${last.year}</span>
                <span class="stat-value">${fmt.signedPct(change(first.imiReal, last.imiReal))}</span>
                <span class="stat-note">real (${fmt.signedPct(change(first.imi, last.imi))} nominal)</span></div>
            <div class="stat"><span class="stat-label">IMT, ${first.year} → ${last.year}</span>
                <span class="stat-value">${fmt.signedPct(change(first.imtReal, last.imtReal))}</span>
                <span class="stat-note">real (${fmt.signedPct(change(first.imt, last.imt))} nominal)</span></div>
            <div class="stat"><span class="stat-label">Receita de ${last.year}${real ? '' : ', euros da altura'}</span>
                <span class="stat-value">${fmt.money(real ? last.imtReal : last.imt)} <small>IMT</small></span>
                <span class="stat-note">${fmt.money(real ? last.imiReal : last.imi)} de IMI${overtook ? ` · o IMT passou o IMI em ${overtook.year}` : ''}</span></div>`;
        this.replaceChart('revenue', el('revenueChart'), this.revenueChartConfig(series, real));
        for (const button of document.querySelectorAll('#revenueMode button')) {
            button.setAttribute('aria-pressed', String(button.dataset.mode === this.revenueMode));
        }
    }

    // --- map ------------------------------------------------------------

    buildMap() {
        const svg = el('map');
        svg.setAttribute('viewBox', this.map.viewBox.join(' '));
        const ns = 'http://www.w3.org/2000/svg';
        const make = (tag, attrs) => {
            const node = document.createElementNS(ns, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
            return node;
        };
        const insets = make('g', { class: 'insets' });
        for (const inset of this.map.insets) {
            const [x, y, w, h] = inset.box;
            insets.appendChild(make('rect', { x, y, width: w, height: h, rx: 3, class: 'inset-box' }));
            const label = make('text', { x: x + 4, y: y + h - 4, class: 'inset-label' });
            label.textContent = inset.name;
            insets.appendChild(label);
        }
        svg.appendChild(insets);

        const munis = make('g', { class: 'municipalities' });
        this.municipalityPaths = {};
        for (const shape of this.map.municipalities) {
            const path = make('path', { d: shape.path, class: 'municipality', tabindex: '-1' });
            path.dataset.code = shape.code;
            munis.appendChild(path);
            this.municipalityPaths[shape.code] = path;
        }
        svg.appendChild(munis);

        const districts = make('g', { class: 'districts' });
        this.districtPaths = {};
        for (const d of this.map.districts) {
            const path = make('path', { d: d.path, class: 'district', tabindex: '0' });
            path.dataset.code = d.code;
            path.setAttribute('role', 'button');
            path.setAttribute('aria-label', d.name);
            districts.appendChild(path);
            this.districtPaths[d.code] = path;
        }
        svg.appendChild(districts);

        // Outlines live in their own top layer: a thick stroke on the shape
        // itself would be half hidden under its neighbours.
        const outlines = make('g', { class: 'outlines' });
        this.outline = {
            district: make('path', { class: 'outline outline-district' }),
            selected: make('path', { class: 'outline outline-selected' }),
            hover: make('path', { class: 'outline outline-hover' })
        };
        for (const path of Object.values(this.outline)) outlines.appendChild(path);
        svg.appendChild(outlines);
        const setHover = target => {
            const d = target && target.dataset && target.dataset.code ? target.getAttribute('d') : '';
            this.outline.hover.setAttribute('d', d);
        };
        svg.addEventListener('pointerover', e => setHover(e.target));
        svg.addEventListener('focusin', e => setHover(e.target));
        svg.addEventListener('focusout', () => setHover(null));

        const byCode = Object.fromEntries(this.municipalities.map(m => [m.code, m]));
        const districtByCode = Object.fromEntries(this.districts.map(d => [d.code, d]));
        const tip = el('mapTooltip');
        const showTip = (event, entity) => {
            const change = metricChange(entity.series, this.metric, FIRST_YEAR, this.lastMunicipalYear);
            const last = entity.series.find(r => r.year === this.lastMunicipalYear);
            tip.innerHTML = html`<strong>${entity.name}</strong><br>
                ${formatChange(this.metric, change)} desde ${FIRST_YEAR}<br>
                <span class="muted">${this.lastMunicipalYear}: ${formatMetric(this.metric, last && last[this.metric])}</span>`;
            const box = svg.parentElement.getBoundingClientRect();
            tip.style.left = `${event.clientX - box.left + 12}px`;
            tip.style.top = `${event.clientY - box.top + 12}px`;
            tip.hidden = false;
        };
        svg.addEventListener('pointermove', e => {
            const code = e.target.dataset && e.target.dataset.code;
            if (!code) { tip.hidden = true; return; }
            const entity = e.target.classList.contains('district') ? districtByCode[code] : byCode[code];
            if (entity) showTip(e, entity);
        });
        svg.addEventListener('pointerleave', () => { tip.hidden = true; setHover(null); });
        svg.addEventListener('click', e => {
            const code = e.target.dataset && e.target.dataset.code;
            if (!code) return;
            if (e.target.classList.contains('district')) this.go(districtByCode[code]);
            else if (byCode[code]) this.go(byCode[code]);
        });
        svg.addEventListener('keydown', e => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.code) {
                e.preventDefault();
                e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        });
        this.renderLegend();
    }

    colorMap() {
        const fill = entity => {
            const cls = changeClass(metricChange(entity.series, this.metric, FIRST_YEAR, this.lastMunicipalYear), this.metric);
            return cls === null ? NO_DATA_FILL : CLASS_FILL[cls];
        };
        for (const d of this.districts) this.districtPaths[d.code].style.fill = fill(d);
        for (const m of this.municipalities) this.municipalityPaths[m.code].style.fill = fill(m);
    }

    renderLegend() {
        const kind = METRICS[this.metric].change;
        const breaks = CLASS_BREAKS[kind];
        const label = v => kind === 'points' ? `${v} p.p.` : `${Math.round(v * 100)}%`;
        const items = [];
        for (let c = -4; c <= 4; c++) {
            const lo = c === 0 ? null : breaks[Math.abs(c) - 1];
            const hi = c === 0 ? breaks[0] : breaks[Math.abs(c)];
            let text;
            if (c === 0) text = `± ${label(breaks[0])}`;
            else if (hi === undefined) text = `${c < 0 ? '−' : '+'}${label(lo)} ou mais`;
            else text = `${c < 0 ? '−' : '+'}${label(lo)} a ${c < 0 ? '−' : '+'}${label(hi)}`;
            items.push(html`<li><span class="swatch" style="background:${CLASS_FILL[c]}"></span>${text}</li>`);
        }
        el('mapLegend').innerHTML = html`<p class="legend-title">Variação ${FIRST_YEAR}–${this.lastMunicipalYear}</p>
            <ul>${raw(items.join(''))}</ul>
            <p class="legend-note"><span class="swatch swatch-empty"></span>sem dados</p>`;
    }

    // Animate the SVG viewBox to a target box.
    zoomTo(box) {
        const svg = el('map');
        const from = svg.getAttribute('viewBox').split(' ').map(Number);
        const to = box;
        // Follow the target's shape (within reason) so a wide region like
        // the Açores fills the frame instead of floating in a tall box.
        svg.style.aspectRatio = String(Math.min(2, Math.max(0.6, to[2] / to[3])));
        const start = performance.now();
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450;
        cancelAnimationFrame(this.zoomFrame);
        const step = now => {
            const t = duration ? Math.min(1, (now - start) / duration) : 1;
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            svg.setAttribute('viewBox', from.map((f, i) => f + (to[i] - f) * e).join(' '));
            if (t < 1) this.zoomFrame = requestAnimationFrame(step);
        };
        this.zoomFrame = requestAnimationFrame(step);
    }

    // --- routing --------------------------------------------------------

    go(entity) {
        if (!entity) location.hash = '';
        else if (entity.members) location.hash = `#/${entity.slug}`;
        else location.hash = `#/${slugify(entity.districtName)}/${entity.slug}`;
    }

    route() {
        const [districtSlug, municipalitySlug] = location.hash.replace(/^#\/?/, '').split('/');
        const district = this.districts.find(d => d.slug === districtSlug) || null;
        const municipality = district && district.members.find(m => m.slug === municipalitySlug) || null;
        this.district = district;
        this.municipality = municipality;
        this.render();
    }

    render() {
        const svg = el('map');
        svg.classList.toggle('zoomed', Boolean(this.district));
        for (const d of this.districts) this.districtPaths[d.code].classList.toggle('active', d === this.district);
        for (const m of this.municipalities) {
            const path = this.municipalityPaths[m.code];
            path.classList.toggle('in-scope', Boolean(this.district) && m.district === this.district.code);
            path.classList.toggle('selected', m === this.municipality);
            path.setAttribute('tabindex', this.district && m.district === this.district.code ? '0' : '-1');
            if (this.district && m.district === this.district.code) {
                path.setAttribute('role', 'button');
                path.setAttribute('aria-label', m.name);
            }
        }
        this.outline.district.setAttribute('d', this.district ? this.district.shape.path : '');
        this.outline.selected.setAttribute('d', this.municipality ? this.municipalityPaths[this.municipality.code].getAttribute('d') : '');
        this.outline.hover.setAttribute('d', '');
        this.colorMap();
        if (this.district) {
            const [x, y, w, h] = this.district.shape.bbox;
            const pad = Math.max(w, h) * 0.08;
            this.zoomTo([x - pad, y - pad, w + 2 * pad, h + 2 * pad]);
        } else {
            this.zoomTo(this.map.viewBox);
        }
        el('mapHint').textContent = this.district
            ? 'Clique num município para ver o detalhe, ou noutro distrito para mudar.'
            : 'Clique num distrito para ver os seus municípios.';
        this.renderBreadcrumb();
        this.renderRanking();
        this.renderTable();
        this.renderDetail();
    }

    renderBreadcrumb() {
        const parts = [html`<a href="#/">Portugal</a>`];
        if (this.district) parts.push(html`<a href="#/${this.district.slug}">${this.district.name}</a>`);
        if (this.municipality) parts.push(html`<span>${this.municipality.name}</span>`);
        el('breadcrumb').innerHTML = parts.join('<span class="sep">›</span>');
    }

    scopeEntities() {
        return this.district ? this.district.members : this.municipalities;
    }

    // Side panel once a municipality is picked: its key figures instead of
    // the district's top 3.
    renderMunicipalitySummary(m) {
        const first = m.series.find(r => r.year === FIRST_YEAR);
        const last = m.series.find(r => r.year === this.lastMunicipalYear);
        const rates = rateSeries(this.rates, m.code);
        const lastRate = rates[rates.length - 1];
        const familiarRange = rates.filter(r => r.year >= this.familiarFirstYear);
        const familiarYears = familiarRange.filter(r => r.familiar);
        el('ranking').innerHTML = html`
            <div class="summary-head">
                <h3>${m.name}</h3>
            </div>
            <div class="stat-row summary-stats">
                <div class="stat"><span class="stat-label">IMI nas receitas correntes, ${this.lastMunicipalYear}</span>
                    <span class="stat-value">${fmt.pct(last && last.share)}</span>
                    <span class="stat-note">${fmt.pct(first && first.share)} em ${FIRST_YEAR}</span></div>
                <div class="stat"><span class="stat-label">IMI por alojamento, ${this.lastMunicipalYear}</span>
                    <span class="stat-value">${fmt.euro(last && last.nominal)}</span>
                    <span class="stat-note">${fmt.int(last && last.dwellings)} alojamentos${last && last.estimate ? ' (estimativa) ⚠️' : ''}</span></div>
                <div class="stat"><span class="stat-label">Variação real desde ${FIRST_YEAR}</span>
                    <span class="stat-value">${fmt.signedPct(metricChange(m.series, 'real', FIRST_YEAR, this.lastMunicipalYear))}</span>
                    <span class="stat-note">nominal: ${fmt.signedPct(metricChange(m.series, 'nominal', FIRST_YEAR, this.lastMunicipalYear))}</span></div>
                <div class="stat"><span class="stat-label">Taxa de IMI ${lastRate ? lastRate.year : ''}</span>
                    <span class="stat-value">${fmt.rate(lastRate && lastRate.urban)}</span>
                    <span class="stat-note">prédios urbanos</span></div>
                <div class="stat"><span class="stat-label">IMI Familiar ${lastRate ? lastRate.year : ''}</span>
                    <span class="stat-value">${lastRate && lastRate.familiar ? 'Sim' : 'Não'}</span>
                    <span class="stat-note">${lastRate && lastRate.familiar ? `${familiarLabel(lastRate.familiar)} · ` : ''}${familiarYears.length} de ${familiarRange.length} anos desde ${this.familiarFirstYear}</span></div>
            </div>
            <button type="button" class="summary-more link-button" data-scroll="detail">Gráficos de ${m.name} ↓</button>`;
    }

    renderRanking() {
        if (this.municipality) {
            this.renderMunicipalitySummary(this.municipality);
            return;
        }
        const list = ranking(this.scopeEntities(), this.metric, FIRST_YEAR, this.lastMunicipalYear, { excludeSmall: this.excludeSmall });
        const item = e => html`<li><a href="#/${slugify(e.districtName)}/${e.slug}">
            <span class="rank-name">${e.name}</span>
            <span class="rank-district">${this.district ? '' : e.districtName}</span>
            <span class="rank-change">${formatChange(this.metric, e.change)}</span></a></li>`;
        const falls = list.filter(e => e.change < 0).slice(0, 3);
        const rises = list.filter(e => e.change > 0).slice(-3).reverse();
        const items = entries => entries.length ? entries.map(item).join('') : html`<li class="rank-empty">Nenhum município.</li>`;
        const scope = this.district ? this.district.name : 'Portugal';
        const scopeSeries = this.district ? this.district.series : this.country;
        const change = metricChange(scopeSeries, this.metric, FIRST_YEAR, this.lastMunicipalYear);
        el('ranking').innerHTML = html`
            <div class="scope-summary">
                <span class="stat-label">${scope}: ${METRICS[this.metric].short}</span>
                <span class="stat-value">${formatChange(this.metric, change)}</span>
                <span class="stat-note">de ${FIRST_YEAR} a ${this.lastMunicipalYear}</span>
            </div>
            <div class="rank-block">
                <h3>Maiores descidas</h3>
                <ol class="rank-list falls">${raw(items(falls))}</ol>
            </div>
            <div class="rank-block">
                <h3>Maiores subidas</h3>
                <ol class="rank-list rises">${raw(items(rises))}</ol>
            </div>`;
    }

    renderTable() {
        const rows = ranking(this.scopeEntities(), this.metric, FIRST_YEAR, this.lastMunicipalYear)
            .map(e => {
                const first = e.series.find(r => r.year === FIRST_YEAR);
                const last = e.series.find(r => r.year === this.lastMunicipalYear);
                return { e, first: first[this.metric], last: last[this.metric] };
            });
        const sort = this.tableSort || { key: 'change', dir: 1 };
        const value = r => sort.key === 'name' ? r.e.name : sort.key === 'first' ? r.first : sort.key === 'last' ? r.last : r.e.change;
        rows.sort((a, b) => {
            const va = value(a), vb = value(b);
            return (typeof va === 'string' ? va.localeCompare(vb, 'pt') : va - vb) * sort.dir;
        });
        const header = (key, text) => html`<th aria-sort="${sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">
            <button type="button" data-sort="${key}">${text}</button></th>`;
        el('municipalityTable').innerHTML = html`
            <thead><tr>${raw(header('name', 'Município'))}${raw(header('first', String(FIRST_YEAR)))}
                ${raw(header('last', String(this.lastMunicipalYear) + (this.metric !== 'share' && this.country.find(r => r.year === this.lastMunicipalYear).estimate ? ' ⚠️' : '')))}${raw(header('change', 'Variação'))}</tr></thead>
            <tbody>${raw(rows.map(r => html`<tr>
                <td><a href="#/${slugify(r.e.districtName)}/${r.e.slug}">${r.e.name}</a></td>
                <td>${formatMetric(this.metric, r.first)}</td>
                <td>${formatMetric(this.metric, r.last)}</td>
                <td>${formatChange(this.metric, r.e.change)}</td></tr>`).join(''))}</tbody>`;
        el('tableTitle').textContent = `${METRICS[this.metric].label}: ${this.district ? this.district.name : 'todos os municípios'}`;
        const missing = this.scopeEntities().length - rows.length;
        const notes = [];
        if (this.metric !== 'share') notes.push(`⚠️ O número de alojamentos de ${this.lastMunicipalYear} é uma estimativa (ver Metodologia).`);
        if (missing) notes.push(`${missing} município(s) sem dados num dos anos de comparação não aparecem na tabela.`);
        el('tableNote').textContent = notes.join(' ');
    }

    // --- municipality detail ---------------------------------------------

    renderDetail() {
        const m = this.municipality;
        el('detail').hidden = !m;
        if (!m) return;
        const district = this.districts.find(d => d.code === m.district);
        const years = this.country.map(r => r.year);
        const labels = years.map(String);
        const pick = (series, key) => years.map(y => {
            const row = series.find(r => r.year === y);
            return row ? row[key] : null;
        });

        const rates = rateSeries(this.rates, m.code);
        el('detailTitle').textContent = m.name;
        el('detailSubtitle').textContent = district.name;
        this.replaceChart('perDwelling', el('perDwellingChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset(`${m.name}, a preços de ${this.targetYear}`, pick(m.series, 'real'), COLORS.real, { width: 2.5 }),
                    lineDataset(`${m.name}, em euros da altura`, pick(m.series, 'nominal'), COLORS.nominal),
                    lineDataset(`${district.name}, a preços de ${this.targetYear}`, pick(district.series, 'real'), COLORS.district),
                    lineDataset(`Portugal, a preços de ${this.targetYear}`, pick(this.country, 'real'), COLORS.national)
                ]
            },
            options: chartOptions({
                y: { ticks: { callback: v => fmt.euro(v) } },
                tooltip: ctx => `${ctx.dataset.label}: ${fmt.euro2(ctx.parsed.y)}`,
                title: year => `IMI de ${year} (pago em ${paymentYear(Number(year))})`
            }),
            plugins: [endLabels(v => fmt.euro(v))]
        });

        this.replaceChart('detailRevenue', el('detailRevenueChart'),
            this.revenueChartConfig(revenueByReceiptYear([m.raw], this.inflation, this.targetYear), true));

        this.replaceChart('share', el('shareChart'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset(m.name, pick(m.series, 'share'), COLORS.real, { width: 2.5 }),
                    lineDataset(district.name, pick(district.series, 'share'), COLORS.district),
                    lineDataset('Portugal', pick(this.country, 'share'), COLORS.national)
                ]
            },
            options: chartOptions({
                y: { min: 0, ticks: { callback: v => fmt.pct(v) } },
                tooltip: ctx => `${ctx.dataset.label}: ${fmt.pct(ctx.parsed.y)}`,
                title: year => `${year} (contas de ${paymentYear(Number(year))})`
            }),
            plugins: [endLabels(v => fmt.pct(v))]
        });

        this.replaceChart('rate', el('rateChart'), {
            type: 'line',
            data: {
                labels: rates.map(r => String(r.year)),
                datasets: [lineDataset('Taxa de IMI (prédios urbanos)', rates.map(r => r.urban), COLORS.real, { width: 2.5, stepped: true })]
            },
            options: chartOptions({
                legend: false,
                y: { suggestedMin: 0.003, suggestedMax: 0.0045, ticks: { callback: v => fmt.rate(v) } },
                tooltip: ctx => `Taxa: ${fmt.rate(ctx.parsed.y)}`,
                title: year => `Taxa para o IMI de ${year}`
            })
        });

        const withFreguesias = rates.filter(r => r.freguesias.length);
        el('familiarStrip').innerHTML = rates.filter(r => r.year >= this.familiarFirstYear).map(r => html`
            <li class="familiar-year${r.familiar ? ' on' : ''}"><span class="familiar-y">${r.year}</span>
                <span class="familiar-v">${r.familiar ? familiarLabel(r.familiar) : 'não'}</span></li>`).join('');
        el('freguesiaRates').innerHTML = withFreguesias.length ? html`
            <p class="chart-note">Em alguns anos, ${m.name} fixou taxas por freguesia (art. 112.º, n.º 6 do CIMI). Nesses
            anos, o gráfico mostra a taxa da maioria das freguesias.</p>
            <details><summary>Taxas por freguesia</summary>
            ${raw(withFreguesias.map(r => html`<p><strong>${r.year}:</strong> ${r.freguesias.map(f => `${titleCase(f.name)} ${fmt.rate(f.urban)}`).join(' · ')}</p>`).join(''))}
            </details>` : '';
    }

    replaceChart(key, canvas, config) {
        if (this.charts[key]) this.charts[key].destroy();
        this.charts[key] = new Chart(canvas, config);
    }

    // --- controls + sources --------------------------------------------

    bindControls() {
        el('metricSelect').addEventListener('change', e => {
            this.metric = e.target.value;
            this.renderLegend();
            this.render();
        });
        el('revenueMode').addEventListener('click', e => {
            const button = e.target.closest('button');
            if (!button || button.dataset.mode === this.revenueMode) return;
            this.revenueMode = button.dataset.mode;
            this.renderRevenue();
        });
        el('ranking').addEventListener('click', e => {
            const target = e.target.closest('[data-scroll]');
            if (target) el(target.dataset.scroll).scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        el('excludeSmall').addEventListener('change', e => {
            this.excludeSmall = e.target.checked;
            this.renderRanking();
        });
        el('municipalityTable').addEventListener('click', e => {
            const key = e.target.closest('button') && e.target.closest('button').dataset.sort;
            if (!key) return;
            const current = this.tableSort || { key: 'change', dir: 1 };
            this.tableSort = { key, dir: current.key === key ? -current.dir : 1 };
            this.renderTable();
        });
        const search = el('municipalitySearch');
        el('municipalityOptions').innerHTML = this.municipalities
            .map(m => html`<option value="${m.name} (${m.districtName})"></option>`).join('');
        search.addEventListener('change', () => {
            const m = this.municipalities.find(x => `${x.name} (${x.districtName})` === search.value);
            if (m) { this.go(m); search.value = ''; }
        });
        el('smallThreshold').textContent = fmt.int(SMALL_MUNICIPALITY);
        for (const node of document.querySelectorAll('[data-first-year]')) node.textContent = FIRST_YEAR;
        for (const node of document.querySelectorAll('[data-last-municipal-year]')) node.textContent = this.lastMunicipalYear;
        for (const node of document.querySelectorAll('[data-target-year]')) node.textContent = this.targetYear;
    }

    renderSources() {
        const attrs = 'target="_blank" rel="noopener noreferrer"';
        const yearChip = (label, url, backup, title) => html`<li class="year-chip">
            <a href="${url}" ${raw(attrs)} title="${title}">${label}</a>${raw(backup
                ? html`<a class="chip-archive" href="${backup}" ${raw(attrs)} title="Cópia em web.archive.org" aria-label="Cópia de ${label} no arquivo">↺</a>`
                : '')}</li>`;
        const card = ({ title, publisher, text, url, linkText, years, archived, links = [] }) => html`<article class="source-card">
            <header>
                <h3>${title}</h3>
                <span class="source-publisher">${publisher}</span>
            </header>
            <p>${text}</p>
            ${raw(years ? html`<ul class="year-chips">${raw(years.join(''))}</ul>
                <p class="chip-key">Um ficheiro por ano do imposto${archived ? ' · ↺ cópia em web.archive.org' : ''}</p>` : '')}
            <a class="source-link" href="${url}" ${raw(attrs)}>${linkText} ↗</a>
            ${raw(links.filter(l => l.url).map(l => html`<a class="source-extra" href="${l.url}" ${raw(attrs)}>${l.text}</a>`).join(''))}
        </article>`;

        const revenue = this.municipalData.sources.revenue;
        const dwellings = this.municipalData.sources.dwellings;
        const updated = dwellings.updated ? ` Atualizado pelo INE em ${dwellings.updated.split('-').reverse().join('/')}.` : '';
        const cards = [
            {
                title: 'IMI nacional',
                publisher: 'Autoridade Tributária',
                text: 'Coleta de IMI dos prédios urbanos e número de prédios urbanos tributados, por ano do imposto.',
                url: this.nationalData.source.url,
                linkText: 'Estatísticas do Património',
                years: this.nationalRows.map(r => yearChip(r.year, r.source.url, r.source.backup, `IMI de ${r.year}`)),
                archived: this.nationalRows.some(r => r.source.backup)
            },
            {
                title: 'Receita dos municípios',
                publisher: 'DGAL',
                text: 'IMI e receitas correntes de cada município (receita cobrada líquida), das contas de gerência. Cada ano do imposto vem das contas do ano seguinte.',
                url: revenue.url,
                linkText: 'Contas de Gerência dos Municípios',
                years: Object.entries(revenue.files).map(([year, url]) =>
                    yearChip(year, url, null, `IMI de ${year}, contas de ${Number(year) + 1}`))
            },
            {
                title: 'Alojamentos',
                publisher: 'INE',
                text: `Alojamentos familiares clássicos por município (estimativas do parque habitacional, indicador 0008329).${updated}`,
                url: dwellings.url,
                linkText: 'Base de dados do INE'
            },
            {
                title: 'Taxas de IMI',
                publisher: 'Autoridade Tributária',
                text: 'Taxa dos prédios urbanos fixada por cada município para cada ano, taxas por freguesia onde existem, e o IMI Familiar que cada município aplica.',
                url: this.rates.source.url,
                linkText: 'Consultar taxas por município'
            },
            {
                title: 'VPT urbano',
                publisher: 'Autoridade Tributária',
                text: 'VPT dos prédios urbanos tributados e isentos (quadros B e C das mesmas estatísticas do IMI nacional).',
                url: this.nationalData.source.url,
                linkText: 'Estatísticas do Património'
            },
            {
                title: 'Valor base de construção',
                publisher: 'Diário da República',
                text: `Valor médio de construção por m² fixado por portaria para cada ano (art. 39.º do CIMI), de ${this.components.constructionValue.years[0].portaria} a ${this.components.constructionValue.years[this.components.constructionValue.years.length - 1].portaria}.`,
                url: this.components.constructionValue.url,
                linkText: 'Tabela de valores e portarias',
                links: [{ text: '↺ cópia no arquivo', url: this.components.constructionValue.backup }]
            },
            {
                title: 'Atualização trienal',
                publisher: 'Diário da República',
                text: 'Coeficientes de desvalorização da moeda (art. 138.º do CIMI), uma portaria por atualização.',
                url: this.components.triennialUpdates.url,
                linkText: 'Art. 138.º do CIMI',
                links: [{ text: '↺ cópia do art. 138.º no arquivo', url: this.components.triennialUpdates.backup }],
                years: this.components.triennialUpdates.updates.map(u =>
                    yearChip(u.year, u.url, u.backup, `Portaria ${u.portaria}: coeficiente de ${u.cdmYear}`)),
                archived: this.components.triennialUpdates.updates.some(u => u.backup)
            },
            {
                title: 'Custos de construção e preços da habitação',
                publisher: 'INE',
                text: 'Índice de custo de construção de habitação nova (indicador 0011748) e índice de preços da habitação (indicador 0014765), médias anuais.',
                url: this.indices.housePrices.url,
                linkText: 'Índice de preços da habitação',
                links: [
                    { text: 'Índice de custo de construção ↗', url: this.indices.constructionCosts.url },
                    { text: '↺ cópia dos dados de custos de construção', url: this.indices.constructionCosts.backup },
                    { text: '↺ cópia dos dados de preços da habitação', url: this.indices.housePrices.backup }
                ]
            },
            {
                title: 'Vetustez e localização',
                publisher: 'Código do IMI',
                text: `Tabela do coeficiente de vetustez (art. 44.º), revisão trienal do zonamento (art. 62.º) e o zonamento em vigor (Portaria ${this.components.location.revisions[this.components.location.revisions.length - 1].portaria}).`,
                url: this.components.ageing.url,
                linkText: 'Art. 44.º do CIMI',
                links: [
                    { text: '↺ cópia do art. 44.º', url: this.components.ageing.backup },
                    { text: 'Art. 62.º do CIMI ↗', url: this.components.location.url },
                    { text: '↺ cópia do art. 62.º', url: this.components.location.backup },
                    ...this.components.location.revisions.flatMap(r => [
                        { text: `Portaria ${r.portaria} ↗`, url: r.url },
                        { text: `↺ cópia da Portaria ${r.portaria}`, url: r.backup }
                    ])
                ]
            },
            {
                title: 'Inflação',
                publisher: 'Eurostat',
                text: 'IHPC da área do euro, variação de dezembro a dezembro (estimativa rápida de dezembro de cada ano). A mesma série da comparação de taxas de IRS.',
                url: 'https://ec.europa.eu/eurostat/web/hicp',
                linkText: 'IHPC no Eurostat'
            },
            {
                title: 'Mapa',
                publisher: 'Direção-Geral do Território',
                text: 'Limites de distritos e municípios da Carta Administrativa Oficial de Portugal (CAOP 2025), simplificados para a web.',
                url: this.map.source.url,
                linkText: 'CAOP'
            }
        ];
        el('sourcesList').innerHTML = cards.map(card).join('');
    }
}

function titleCase(name) {
    return name.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase())
        .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, w => w.toLowerCase());
}

// --- Chart.js helpers ------------------------------------------------------

function lineDataset(label, data, color, { width = 2, stepped = false, dash = null } = {}) {
    return {
        label, data, stepped,
        borderDash: dash || [],
        borderColor: color,
        backgroundColor: color,
        borderWidth: width,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: '#fff',
        tension: 0,
        spanGaps: false
    };
}

function barDataset(label, data, color) {
    return { type: 'bar', label, data, backgroundColor: color, borderColor: color, borderWidth: 0, stack: 'loss', barPercentage: 0.7 };
}

function chartOptions({ y = {}, x = {}, tooltip, title, legend = true, markers = [] }) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: 70, top: 4 } },
        scales: {
            x: { ...x, grid: { display: false }, border: { color: COLORS.axis }, ticks: { color: COLORS.muted } },
            y: {
                ...y,
                grid: { color: COLORS.grid },
                border: { display: false },
                ticks: { color: COLORS.muted, ...(y.ticks || {}) }
            }
        },
        plugins: {
            legend: { display: legend, position: 'top', align: 'start', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 24, color: COLORS.ink } },
            tooltip: {
                callbacks: {
                    label: tooltip,
                    title: items => title ? title(items[0].label) : items[0].label
                }
            },
            yearMarkers: { markers }
        }
    };
}

// Value labels at the right end of each visible line.
function endLabels(format) {
    return {
        id: 'endLabels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.font = '12px system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            const placed = [];
            chart.data.datasets.forEach((ds, i) => {
                const meta = chart.getDatasetMeta(i);
                if (meta.hidden) return;
                let j = ds.data.length - 1;
                while (j >= 0 && ds.data[j] == null) j--;
                if (j < 0) return;
                const point = meta.data[j];
                let yPos = point.y;
                for (const p of placed) if (Math.abs(p - yPos) < 14) yPos = p + (yPos >= p ? 14 : -14);
                placed.push(yPos);
                ctx.fillStyle = COLORS.ink;
                ctx.fillText(format(ds.data[j]), point.x + 8, yPos);
            });
            ctx.restore();
        }
    };
}

// Thin vertical rules for events that move every municipality at once.
const yearMarkers = {
    id: 'yearMarkers',
    afterDraw(chart, _args, opts) {
        const { ctx, chartArea, scales } = chart;
        ctx.save();
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = COLORS.muted;
        ctx.strokeStyle = COLORS.axis;
        ctx.lineWidth = 1;
        for (const m of opts.markers || []) {
            const index = chart.data.labels.indexOf(String(m.year));
            if (index < 0) continue;
            const x = scales.x.getPixelForValue(index);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.textAlign = 'left';
            ctx.fillText(m.text, x + 4, chartArea.top + 10);
        }
        ctx.restore();
    }
};

if (typeof document !== 'undefined' && typeof Chart !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        new App().init().catch(err => {
            console.error(err);
            el('loadError').hidden = false;
        });
    });
}
