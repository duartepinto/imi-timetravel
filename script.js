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
        freguesias: row.freguesias || []
    })).sort((a, b) => a.year - b.year);
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
        [this.nationalData, this.municipalData, this.rates, this.map, this.inflation] = await Promise.all(
            ['national.json', 'municipalities.json', 'rates.json', 'map.json', 'inflation_pt.json'].map(load));

        this.nationalRows = this.nationalData.years;
        this.lastNationalYear = Math.max(...this.nationalRows.map(r => r.year));
        this.targetYear = paymentYear(this.lastNationalYear);
        this.metric = 'share';
        this.excludeSmall = true;
        this.charts = {};

        this.buildEntities();
        this.renderHeadline();
        this.renderNationalChart();
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
                    { year: 2016, text: 'IMI Familiar' }
                ]
            }),
            plugins: [endLabels(v => fmt.euro(v)), yearMarkers]
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
        const card = ({ title, publisher, text, url, linkText, years, archived }) => html`<article class="source-card">
            <header>
                <h3>${title}</h3>
                <span class="source-publisher">${publisher}</span>
            </header>
            <p>${text}</p>
            ${raw(years ? html`<ul class="year-chips">${raw(years.join(''))}</ul>
                <p class="chip-key">Um ficheiro por ano do imposto${archived ? ' · ↺ cópia em web.archive.org' : ''}</p>` : '')}
            <a class="source-link" href="${url}" ${raw(attrs)}>${linkText} ↗</a>
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
                text: 'Taxa dos prédios urbanos fixada por cada município para cada ano, e taxas por freguesia onde existem.',
                url: this.rates.source.url,
                linkText: 'Consultar taxas por município'
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

function lineDataset(label, data, color, { width = 2, stepped = false } = {}) {
    return {
        label, data, stepped,
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

function chartOptions({ y = {}, tooltip, title, legend = true, markers = [] }) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: 70, top: 4 } },
        scales: {
            x: { grid: { display: false }, border: { color: COLORS.axis }, ticks: { color: COLORS.muted } },
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
