/*
 * Renewable Power Dashboard: static frontend for the power-dashboard API (Cloud Run).
 *
 * Flow: GET /health (no auth) -> load BokehJS matching the API's bokeh version
 *       -> log in if required (POST /api/login -> bearer token in localStorage)
 *       -> fetch chart JSON from /api/* and render it.
 *
 * The API address comes from js/config.js. For local development, open the page with
 * ?api=http://127.0.0.1:8080 (remembered for the tab; ?api=default clears it).
 */

// Bump together with server.API_VERSION when the API contract changes.
const EXPECTED_API_VERSION = 2;
const TOKEN_KEY = 'powerDashboard.token';
const API_OVERRIDE_KEY = 'powerDashboard.apiBase';

function safeStorage(kind) {
    try { return window[kind]; } catch (e) { return null; }
}

function resolveApiBase() {
    const session = safeStorage('sessionStorage');
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    try {
        if (fromQuery === 'default') session && session.removeItem(API_OVERRIDE_KEY);
        else if (fromQuery) session && session.setItem(API_OVERRIDE_KEY, fromQuery);
    } catch (e) { /* storage blocked: the query value still applies below */ }
    let override = null;
    try { override = session && session.getItem(API_OVERRIDE_KEY); } catch (e) { /* ignore */ }
    const base = (fromQuery && fromQuery !== 'default') ? fromQuery
        : override || (window.DASHBOARD_CONFIG && window.DASHBOARD_CONFIG.apiBase) || '';
    return { base: base.replace(/\/+$/, ''), overridden: Boolean(override || (fromQuery && fromQuery !== 'default')) };
}

const tokenStore = {
    get() {
        try {
            const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
            if (saved && saved.token && saved.expires * 1000 > Date.now()) return saved.token;
        } catch (e) { /* missing, corrupt or blocked storage */ }
        return null;
    },
    set(token, expires) {
        try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires })); } catch (e) { /* session-only */ }
        this.memory = token;
    },
    clear() {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
        this.memory = null;
    },
    current() { return this.get() || this.memory || null; },
    memory: null,
};

class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

// Load BokehJS (core, widgets, tables, in order) at the version the API renders with,
// since the frontend and backend deploy independently.
const bokehLoader = {
    promise: null,
    load(version) {
        if (window.Bokeh && window.Bokeh.version === version) return Promise.resolve();
        if (this.promise) return this.promise;
        const base = 'https://cdn.bokeh.org/bokeh/release/';
        const addScript = name => new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `${base}${name}-${version}.min.js`;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Could not load ${script.src}`));
            document.head.appendChild(script);
        });
        // Bokeh 3.x bundles its CSS into these scripts; there are no separate .css files.
        this.promise = addScript('bokeh')
            .then(() => addScript('bokeh-widgets'))
            .then(() => addScript('bokeh-tables'))
            .catch(error => { this.promise = null; throw error; });
        return this.promise;
    },
};

// ------------------------------------------------------------------
// Chart rendering: each API response carries chart specs keyed by the
// id of the element they render into.
//   {type: "bokeh", item}            -> Bokeh.embed.embed_item
//   {type: "plotly", figure, config} -> Plotly.react
//   {type: "message", text}          -> plain text placeholder
// ------------------------------------------------------------------
const bokehDocsByTarget = {};

function clearBokeh(targetId) {
    for (const doc of bokehDocsByTarget[targetId] || []) {
        try { doc.clear(); } catch (e) { console.debug('Bokeh clear error', e); }
        const index = Bokeh.documents.indexOf(doc);
        if (index >= 0) Bokeh.documents.splice(index, 1);
    }
    delete bokehDocsByTarget[targetId];
}

function clearPlotly(el) {
    if (el.classList.contains('js-plotly-plot')) {
        Plotly.purge(el);
        // purge() leaves the class behind; without removing it, the next plot is drawn
        // next to whatever placeholder showMessage() put in the element.
        el.classList.remove('js-plotly-plot');
    }
}

function showMessage(targetId, text) {
    const el = document.getElementById(targetId);
    if (!el) return;
    clearBokeh(targetId);
    clearPlotly(el);
    el.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'chart-message';
    p.style.height = '100%';
    p.textContent = text;
    el.appendChild(p);
}

async function renderSpec(targetId, spec) {
    const el = document.getElementById(targetId);
    if (!el || !spec) return;
    if (spec.type === 'bokeh') {
        clearBokeh(targetId);
        clearPlotly(el);
        el.innerHTML = '';
        const before = new Set(Bokeh.documents);
        await Bokeh.embed.embed_item(spec.item, el);
        bokehDocsByTarget[targetId] = Bokeh.documents.filter(doc => !before.has(doc));
    } else if (spec.type === 'plotly') {
        clearBokeh(targetId);
        if (!el.classList.contains('js-plotly-plot')) el.innerHTML = '';
        el.querySelectorAll(':scope > .chart-message').forEach(node => node.remove());
        await Plotly.react(el, spec.figure.data, spec.figure.layout || {}, spec.config || {});
    } else {
        showMessage(targetId, spec.text || 'No data available.');
    }
}

function formatLocal(isoText) {
    // isoText is naive America/Chicago wall time, e.g. "2026-11-04T08:00"
    if (!isoText) return '';
    const [date, time] = isoText.split('T');
    const [y, m, d] = date.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${d}, ${y} ${time ? time.slice(0, 5) : ''}`.trim();
}

function dashboard() {
    const api = resolveApiBase();
    return {
        mobileMenuOpen: false,
        activeSection: 'production',

        // App lifecycle: 'starting' -> ('login' <-> 'ready') | 'error'
        phase: 'starting',
        apiBase: api.base,
        apiOverridden: api.overridden,
        authRequired: true,
        startupError: '',
        versionWarning: '',
        loginUser: '',
        loginPass: '',
        loginError: '',
        loggingIn: false,

        // Time range for the time-series charts (power, strings, cells, summary)
        presets: [[24, '24h'], [72, '72h'], [168, '7d'], [720, '30d'], [2160, '90d'], [8760, '1y']],
        hours: 72,              // active preset, or null when a custom range is used
        customStart: '',
        customEnd: '',
        showCustom: false,
        shown: null,            // range echoed by the server {start, end, hours}
        resolution: '',
        rangeError: '',

        // Period for the production totals (daily, monthly, generator, annual)
        years: [],
        year: '',               // '' = recent
        periodShown: null,

        earliest: {},
        loading: { power: false, strings: false, cells: false, production: false },
        requestSeq: { range: 0, production: 0 },
        updatedAt: '',
        autoRefreshMinutes: 5,

        get rangeLabel() {
            if (this.hours) {
                const match = this.presets.find(p => p[0] === this.hours);
                return match ? 'Last ' + match[1] : 'Last ' + this.hours + 'h';
            }
            if (!this.shown) return 'Custom range';
            return formatLocal(this.shown.start) + ' – ' + formatLocal(this.shown.end);
        },
        get periodLabel() {
            return this.year ? String(this.year) : 'Recent';
        },
        get anyLoading() {
            return Object.values(this.loading).some(Boolean);
        },

        init() {
            this.readUrl();
            this.setupSectionObserver();
            this.setupResizeHandling();
            this.start();

            // Keep relative ranges fresh while the tab is visible.
            setInterval(() => {
                if (this.phase === 'ready' && this.hours
                    && document.visibilityState === 'visible' && !this.anyLoading) {
                    this.loadRange();
                }
            }, this.autoRefreshMinutes * 60 * 1000);
        },

        // ----------------------------------------------------------- startup & auth
        async start() {
            this.phase = 'starting';
            this.startupError = '';
            let health;
            try {
                health = await this.request('/health', { auth: false });
            } catch (e) {
                this.startupError = `Can't reach the dashboard API (${this.apiBase || 'no API address configured'}): ${e.message}`;
                this.phase = 'error';
                return;
            }
            if (health.api_version !== EXPECTED_API_VERSION) {
                this.versionWarning = `This page expects API version ${EXPECTED_API_VERSION}, but the server reports ${health.api_version}. Some charts may not work until both are updated.`;
            }
            try {
                await bokehLoader.load(health.bokeh_version);
            } catch (e) {
                this.startupError = e.message;
                this.phase = 'error';
                return;
            }
            this.authRequired = Boolean(health.auth_required);
            if (this.authRequired && !tokenStore.current()) {
                this.phase = 'login';
                return;
            }
            this.enterDashboard();
        },

        enterDashboard() {
            this.phase = 'ready';
            // Wait for the chart containers to be displayed so charts size correctly.
            this.$nextTick(() => {
                this.loadMeta();
                this.loadRange();
                this.loadProduction();
            });
        },

        async login() {
            this.loginError = '';
            this.loggingIn = true;
            try {
                const body = await this.request('/api/login', {
                    auth: false,
                    method: 'POST',
                    body: { username: this.loginUser, password: this.loginPass },
                });
                if (body.token) tokenStore.set(body.token, body.expires);
                this.loginPass = '';
                this.enterDashboard();
            } catch (e) {
                this.loginError = e.message;
            } finally {
                this.loggingIn = false;
            }
        },

        logout() {
            tokenStore.clear();
            this.loginPass = '';
            this.loginError = '';
            this.phase = 'login';
        },

        sessionExpired() {
            if (this.phase !== 'ready') return;
            tokenStore.clear();
            this.loginError = 'Your session has ended. Please log in again.';
            this.phase = 'login';
        },

        // ----------------------------------------------------------- URL state
        readUrl() {
            const params = new URLSearchParams(window.location.search);
            if (params.get('start')) {
                this.hours = null;
                this.customStart = params.get('start');
                this.customEnd = params.get('end') || '';
                this.showCustom = true;
            } else if (params.get('hours')) {
                const h = Number(params.get('hours'));
                if (h > 0) this.hours = h;
            }
            if (params.get('year')) this.year = params.get('year');
        },
        writeUrl() {
            const params = new URLSearchParams();
            if (this.hours) {
                if (this.hours !== 72) params.set('hours', this.hours);
            } else {
                params.set('start', this.customStart);
                if (this.customEnd) params.set('end', this.customEnd);
            }
            if (this.year) params.set('year', this.year);
            const query = params.toString();
            history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
        },
        rangeQuery() {
            const params = new URLSearchParams();
            if (this.hours) {
                params.set('hours', this.hours);
            } else {
                params.set('start', this.customStart);
                if (this.customEnd) params.set('end', this.customEnd);
            }
            return params.toString();
        },

        // ----------------------------------------------------------- actions
        selectPreset(hours) {
            this.hours = hours;
            this.showCustom = false;
            this.rangeError = '';
            this.writeUrl();
            this.loadRange();
        },
        openCustom() {
            this.showCustom = !this.showCustom;
            if (this.showCustom && !this.customStart && this.shown) {
                this.customStart = this.shown.start;
                this.customEnd = this.shown.end;
            }
        },
        applyCustom() {
            if (!this.customStart) {
                this.rangeError = 'Pick a start time.';
                return;
            }
            if (this.customEnd && this.customEnd <= this.customStart) {
                this.rangeError = 'End must be after start.';
                return;
            }
            this.rangeError = '';
            this.hours = null;
            this.writeUrl();
            this.loadRange();
        },
        selectYear() {
            this.writeUrl();
            this.loadProduction();
        },
        refresh() {
            this.loadRange();
            this.loadProduction();
        },

        // ----------------------------------------------------------- data loading
        async request(path, { auth = true, method = 'GET', body = null } = {}) {
            const headers = {};
            const token = auth ? tokenStore.current() : null;
            if (token) headers.Authorization = 'Bearer ' + token;
            if (body) headers['Content-Type'] = 'application/json';
            let response;
            try {
                response = await fetch(this.apiBase + path, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    credentials: 'omit',
                });
            } catch (e) {
                throw new ApiError('Network error: the API could not be reached.', 0);
            }
            let payload = null;
            try { payload = await response.json(); } catch (e) { /* not JSON */ }
            if (!response.ok) {
                const detail = payload && payload.detail;
                const message = typeof detail === 'string' ? detail
                    : Array.isArray(detail) ? detail.map(d => d.msg).join('; ')
                    : `Request failed (${response.status})`;
                if (response.status === 401 && auth) this.sessionExpired();
                throw new ApiError(message, response.status);
            }
            return payload;
        },

        fetchJson(path) {
            return this.request(path);
        },

        async loadMeta() {
            try {
                const meta = await this.fetchJson('/api/meta');
                this.years = meta.years || [];
                this.earliest = meta.earliest || {};
            } catch (e) {
                console.warn('Could not load data extents:', e.message);
            }
        },

        async loadGroup(key, url, targets, seqName, seq) {
            this.loading[key] = true;
            try {
                const payload = await this.fetchJson(url);
                if (seq !== this.requestSeq[seqName]) return null;   // superseded
                for (const [chartKey, targetId] of Object.entries(targets)) {
                    await renderSpec(targetId, payload.charts[chartKey]);
                }
                return payload;
            } catch (e) {
                if (seq !== this.requestSeq[seqName]) return null;
                for (const targetId of Object.values(targets)) showMessage(targetId, e.message);
                if (seqName === 'range') this.rangeError = e.message;
                return null;
            } finally {
                if (seq === this.requestSeq[seqName]) this.loading[key] = false;
            }
        },

        async loadRange() {
            const seq = ++this.requestSeq.range;
            const query = this.rangeQuery();
            this.rangeError = '';
            const results = await Promise.all([
                this.loadGroup('power', '/api/power?' + query, { avg_power: 'avg-power-chart' }, 'range', seq),
                this.loadGroup('strings', '/api/strings?' + query, { string_plot: 'string-chart' }, 'range', seq),
                this.loadGroup('cells', '/api/cells?' + query,
                    { cell_voltage: 'cell-voltage-chart', cell_summary: 'cell-summary-table' }, 'range', seq),
            ]);
            if (seq !== this.requestSeq.range) return;
            const first = results.find(Boolean);
            if (first) {
                this.shown = first.range;
                const cells = results[2];
                this.resolution = cells ? cells.resolution : first.resolution;
            }
            this.updatedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        },

        async loadProduction() {
            const seq = ++this.requestSeq.production;
            const url = '/api/production' + (this.year ? '?year=' + encodeURIComponent(this.year) : '');
            const payload = await this.loadGroup('production', url, {
                daily_energy: 'daily-energy-chart',
                monthly_energy: 'monthly-energy-chart',
                generator_hours: 'generator-hours-chart',
                annual_production: 'annual-production-chart',
            }, 'production', seq);
            if (payload) this.periodShown = payload.range;
        },

        // ----------------------------------------------------------- layout helpers
        setupSectionObserver() {
            const sections = document.querySelectorAll('[data-section]');
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) this.activeSection = entry.target.dataset.section;
                });
            }, { rootMargin: '-20% 0px -70% 0px' });
            sections.forEach(s => observer.observe(s));
        },

        setupResizeHandling() {
            let resizeTimeout;
            const debounce = (fn, delay) => (...args) => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => fn(...args), delay);
            };
            const resizeChartsInWrapper = (wrapper) => {
                if (!wrapper || wrapper.offsetWidth <= 0 || wrapper.offsetHeight <= 0) return;
                if (typeof Plotly !== 'undefined') {
                    wrapper.querySelectorAll('.js-plotly-plot').forEach(plotDiv => {
                        try { Plotly.Plots.resize(plotDiv); } catch (e) { console.debug('Plotly resize error:', e); }
                    });
                }
            };
            const wrappers = () => document.querySelectorAll('.chart-wrapper:not(.table-wrapper)');
            const resizeObserver = new ResizeObserver(debounce((entries) => {
                entries.forEach(entry => resizeChartsInWrapper(entry.target));
            }, 150));
            wrappers().forEach(wrapper => resizeObserver.observe(wrapper));
            window.addEventListener('orientationchange', () => {
                setTimeout(() => wrappers().forEach(resizeChartsInWrapper), 300);
            });
        },
    };
}
