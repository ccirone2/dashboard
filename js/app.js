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
// Range presets [hours, label]; DEFAULT_HOURS must be one of them (and is left out of the URL).
const RANGE_PRESETS = [[168, '7d'], [720, '30d'], [4392, '6M']];   // 6M = 183 days
const DEFAULT_HOURS = 168;

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
        el._tsSyncBound = false;   // purge() also removed our plotly_relayout listener
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
        // Draw the new figure on top of the old one, then remove the old one: re-fetching
        // after every zoom/pan would otherwise flash an empty chart.
        clearPlotly(el);
        const oldDocs = bokehDocsByTarget[targetId] || [];
        const oldNodes = [...el.children];
        const holder = document.createElement('div');
        holder.className = el.closest('.table-wrapper') ? 'bokeh-holder-static' : 'bokeh-holder';
        el.appendChild(holder);
        const before = new Set(Bokeh.documents);
        try {
            await Bokeh.embed.embed_item(spec.item, holder);
        } catch (error) {
            holder.remove();
            throw error;
        }
        bokehDocsByTarget[targetId] = Bokeh.documents.filter(doc => !before.has(doc));
        for (const doc of oldDocs) {
            try { doc.clear(); } catch (e) { console.debug('Bokeh clear error', e); }
            const index = Bokeh.documents.indexOf(doc);
            if (index >= 0) Bokeh.documents.splice(index, 1);
        }
        oldNodes.forEach(node => node.remove());
    } else if (spec.type === 'plotly') {
        clearBokeh(targetId);
        if (!el.classList.contains('js-plotly-plot')) el.innerHTML = '';
        el.querySelectorAll(':scope > .chart-message').forEach(node => node.remove());
        await Plotly.react(el, spec.figure.data, spec.figure.layout || {}, spec.config || {});
        if (renderSpec.onPlotly) renderSpec.onPlotly(targetId, el);
    } else {
        showMessage(targetId, spec.text || 'No data available.');
    }
}

// ------------------------------------------------------------------
// Synchronised x zoom/pan for the time-series charts.
// Times are "wall ms": Chicago wall-clock time encoded as if it were UTC. That is what
// Bokeh's datetime axis holds (the API strips time zones) and how Plotly's naive date
// strings read, so the charts can exchange ranges without any time-zone maths.
// ------------------------------------------------------------------
const MIN_VIEW_MS = 10 * 60 * 1000;          // API minimum range
const MAX_VIEW_MS = 732 * 86400 * 1000;      // API maximum range
const MAX_FUTURE_MS = 23 * 3600 * 1000;      // API allows end up to 1 day ahead
const VIEW_FETCH_DELAY_MS = 450;             // fetch after the zoom/pan settles

// Chart element id -> names of the Bokeh figures (in chart_sync) whose x range to drive.
// The two string figures share one x range, so driving one moves both.
const BOKEH_TIMESERIES = {
    'cell-voltage-chart': ['cell_voltage_plot'],
    'string-chart': ['string_vi_plot'],
};
const PLOTLY_TIMESERIES = { 'avg-power-chart': 'avg_power' };

function wallMsFromText(text) {
    // "2026-11-04T08:00", "2026-11-04 08:00:00.1234" -> wall ms (NaN if unparseable)
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?/.exec(String(text));
    if (!m) return NaN;
    const ms = m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms);
}
function isoMinuteFromWallMs(ms) { return new Date(ms).toISOString().slice(0, 16); }
function plotlyFromWallMs(ms) { return new Date(ms).toISOString().slice(0, 23).replace('T', ' '); }
function nowWallMs() {
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
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
        showHelp: false,

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
        presets: RANGE_PRESETS,
        hours: DEFAULT_HOURS,   // active preset, or null when a custom range is used
        customStart: '',
        customEnd: '',
        showCustom: false,
        shown: null,            // range echoed by the server {start, end, hours}
        // Zoomed/panned window (wall ms) shared by every time-series chart; null = the
        // header's range. Set by the charts' own x zoom/pan tools and the ◀ ▶ buttons.
        view: null,
        viewVersion: 0,
        viewTimer: null,
        syncFrame: null,
        pendingSync: null,
        ignoreRangeEventsUntil: 0,
        refreshKind: 'full',    // 'zoom' while re-fetching for a zoom/pan (subtle spinner)
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
            if (this.view) {
                return formatLocal(isoMinuteFromWallMs(this.view.start)) + ' – '
                    + formatLocal(isoMinuteFromWallMs(this.view.end));
            }
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
            this.setupStickyOffsets();
            this.setupTimeseriesSync();
            this.start();

            // Keep relative ranges fresh while the tab is visible.
            setInterval(() => {
                if (this.phase === 'ready' && this.hours && !this.view
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
            const from = wallMsFromText(params.get('from') || ''), to = wallMsFromText(params.get('to') || '');
            if (Number.isFinite(from) && Number.isFinite(to) && to > from) this.view = { start: from, end: to };
        },
        writeUrl() {
            const params = new URLSearchParams();
            if (this.hours) {
                if (this.hours !== DEFAULT_HOURS) params.set('hours', this.hours);
            } else {
                params.set('start', this.customStart);
                if (this.customEnd) params.set('end', this.customEnd);
            }
            if (this.view) {
                params.set('from', isoMinuteFromWallMs(this.view.start));
                params.set('to', isoMinuteFromWallMs(this.view.end));
            }
            if (this.year) params.set('year', this.year);
            const query = params.toString();
            history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
        },
        rangeQuery() {
            const params = new URLSearchParams();
            if (this.view) {
                const win = this.requestWindow(this.view);
                params.set('start', isoMinuteFromWallMs(win.start));
                params.set('end', isoMinuteFromWallMs(win.end));
            } else if (this.hours) {
                params.set('hours', this.hours);
            } else {
                params.set('start', this.customStart);
                if (this.customEnd) params.set('end', this.customEnd);
            }
            return params.toString();
        },

        // ----------------------------------------------------------- actions
        selectPreset(hours) {
            this.clearView();
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
            this.clearView();
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

        async loadGroup(key, url, targets, seqName, seq, isCurrent = () => true) {
            this.loading[key] = true;
            try {
                const payload = await this.fetchJson(url);
                if (seq !== this.requestSeq[seqName] || !isCurrent()) return null;   // superseded
                for (const [chartKey, targetId] of Object.entries(targets)) {
                    await renderSpec(targetId, payload.charts[chartKey]);
                }
                return payload;
            } catch (e) {
                if (seq !== this.requestSeq[seqName] || !isCurrent()) return null;
                for (const targetId of Object.values(targets)) showMessage(targetId, e.message);
                if (seqName === 'range') this.rangeError = e.message;
                return null;
            } finally {
                if (seq === this.requestSeq[seqName]) this.loading[key] = false;
            }
        },

        async loadRange({ zoom = false } = {}) {
            clearTimeout(this.viewTimer);
            const seq = ++this.requestSeq.range;
            const version = this.viewVersion;
            const isCurrent = () => version === this.viewVersion;   // user zoomed again: drop it
            const query = this.rangeQuery();
            this.refreshKind = zoom ? 'zoom' : 'full';
            this.rangeError = '';
            const results = await Promise.all([
                this.loadGroup('power', '/api/power?' + query, { avg_power: 'avg-power-chart' }, 'range', seq, isCurrent),
                this.loadGroup('strings', '/api/strings?' + query, { string_plot: 'string-chart' }, 'range', seq, isCurrent),
                this.loadGroup('cells', '/api/cells?' + query,
                    { cell_voltage: 'cell-voltage-chart', cell_summary: 'cell-summary-table' }, 'range', seq, isCurrent),
            ]);
            if (seq !== this.requestSeq.range || !isCurrent()) return;
            const first = results.find(Boolean);
            if (first) {
                this.shown = first.range;
                const cells = results[2];
                this.resolution = cells ? cells.resolution : first.resolution;
            }
            // The API may have widened the request (minimum 10 min, no far future); put the
            // charts back on exactly the window the user chose.
            if (this.view) this.applyWindowToCharts(this.view, null);
            this.updatedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        },

        // ----------------------------------------------------------- synchronised zoom/pan
        setupTimeseriesSync() {
            document.addEventListener('ts-xrange', event => {
                const { source, start, end } = event.detail || {};
                this.onChartRange(source, start, end);
            });
            document.addEventListener('ts-reset', () => this.resetView());
            renderSpec.onPlotly = (targetId, el) => {
                const source = PLOTLY_TIMESERIES[targetId];
                if (!source || el._tsSyncBound) return;
                el._tsSyncBound = true;
                el.on('plotly_relayout', update => {
                    // Autoscale button / double-click: back to the header's range.
                    if (update['xaxis.autorange'] === true) {
                        this.resetView();
                        return;
                    }
                    const range = update['xaxis.range'] || [update['xaxis.range[0]'], update['xaxis.range[1]']];
                    if (range[0] === undefined || range[1] === undefined) return;
                    this.onChartRange(source, wallMsFromText(range[0]), wallMsFromText(range[1]));
                });
            };
        },

        currentWindow() {
            if (this.view) return this.view;
            if (!this.shown) return null;
            return { start: wallMsFromText(this.shown.start), end: wallMsFromText(this.shown.end) };
        },

        // A chart's x range changed (user zoom/pan, or the echo of our own sync).
        onChartRange(source, start, end) {
            if (this.phase !== 'ready' || Date.now() < this.ignoreRangeEventsUntil) return;
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
            const current = this.currentWindow();
            const tolerance = Math.max(1000, (end - start) * 0.002);
            if (current && Math.abs(start - current.start) < tolerance
                && Math.abs(end - current.end) < tolerance) return;   // our own echo
            this.view = { start, end };
            this.viewVersion++;
            this.queueSync(this.view, source);
            this.scheduleViewFetch();
        },

        // Move the other charts to the new window, at most once per animation frame.
        queueSync(win, source) {
            this.pendingSync = { win, source };
            if (this.syncFrame) return;
            this.syncFrame = requestAnimationFrame(() => {
                this.syncFrame = null;
                const { win: target, source: from } = this.pendingSync;
                this.applyWindowToCharts(target, from);
            });
        },

        applyWindowToCharts(win, exceptSource) {
            for (const [targetId, names] of Object.entries(BOKEH_TIMESERIES)) {
                for (const doc of bokehDocsByTarget[targetId] || []) {
                    for (const name of names) {
                        if (name === exceptSource) continue;
                        const plot = doc.get_model_by_name(name);
                        if (plot && plot.x_range) plot.x_range.setv({ start: win.start, end: win.end });
                    }
                }
            }
            for (const [targetId, name] of Object.entries(PLOTLY_TIMESERIES)) {
                if (name === exceptSource) continue;
                const el = document.getElementById(targetId);
                if (el && el.classList.contains('js-plotly-plot')) {
                    Plotly.relayout(el, { 'xaxis.range': [plotlyFromWallMs(win.start), plotlyFromWallMs(win.end)] });
                }
            }
        },

        scheduleViewFetch() {
            clearTimeout(this.viewTimer);
            this.viewTimer = setTimeout(() => {
                this.writeUrl();
                this.loadRange({ zoom: true });
            }, VIEW_FETCH_DELAY_MS);
        },

        // Clamp the window to what the API accepts; the charts still show the exact view.
        requestWindow(win) {
            let { start, end } = win;
            const latest = nowWallMs() + MAX_FUTURE_MS;
            if (end > latest) end = latest;
            if (end - start > MAX_VIEW_MS) start = end - MAX_VIEW_MS;
            if (end - start < MIN_VIEW_MS) {
                const middle = (start + end) / 2;
                start = middle - MIN_VIEW_MS / 2;
                end = Math.min(middle + MIN_VIEW_MS / 2, latest);
                start = Math.min(start, end - MIN_VIEW_MS);
            }
            return { start, end };
        },

        // ◀ ▶: move the window by half its width, keeping the width.
        shiftView(direction) {
            const current = this.currentWindow();
            if (!current) return;
            const delta = (current.end - current.start) / 2 * direction;
            this.view = { start: current.start + delta, end: current.end + delta };
            this.viewVersion++;
            this.applyWindowToCharts(this.view, null);
            this.scheduleViewFetch();
        },

        clearView() {
            clearTimeout(this.viewTimer);
            this.view = null;
            this.viewVersion++;
            // Bokeh's reset tool also snaps ranges back; don't mistake that for a new zoom.
            this.ignoreRangeEventsUntil = Date.now() + 400;
        },

        resetView() {
            if (!this.view) {
                // Already on the header range: just put any chart that moved back on it.
                const current = this.currentWindow();
                if (current) this.applyWindowToCharts(current, null);
                this.ignoreRangeEventsUntil = Date.now() + 400;
                return;
            }
            this.clearView();
            this.writeUrl();
            this.loadRange();
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

        // The time bar wraps and grows (custom range form, help, warnings), so publish its real
        // height, and the section bar's, for the sticky offsets and snap margins in the CSS.
        setupStickyOffsets() {
            const root = document.documentElement.style;
            const timeBar = document.getElementById('time-bar');
            const sectionBar = document.querySelector('.section-bar');
            const update = () => {
                if (timeBar && timeBar.offsetHeight) root.setProperty('--timebar-h', timeBar.offsetHeight + 'px');
                if (sectionBar && sectionBar.offsetHeight) {
                    const sticky = getComputedStyle(sectionBar).position === 'sticky';
                    root.setProperty('--sectionbar-h', (sticky ? sectionBar.offsetHeight : 0) + 'px');
                }
            };
            const scroller = timeBar && timeBar.querySelector('.range-scroller');
            const markOverflow = () => {
                if (!scroller) return;
                const hidden = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft;
                scroller.classList.toggle('more-right', hidden > 2);
            };
            if (scroller) scroller.addEventListener('scroll', markOverflow, { passive: true });
            const observer = new ResizeObserver(() => { update(); markOverflow(); });
            [timeBar, sectionBar, scroller].forEach(el => el && observer.observe(el));
            // Rotating can make the section bar sticky or static without resizing it.
            window.addEventListener('resize', update, { passive: true });
            update();
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
