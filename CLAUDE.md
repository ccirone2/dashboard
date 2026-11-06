# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

The **frontend** of the Renewable Power System Dashboard: a static site (no build step) published
by GitHub Pages from `main` at https://ccirone2.github.io/dashboard/. **Committing to `main` is the
deploy.** This repo is public. Never commit secrets, passwords, tokens or database details.

The backend is the private repo `ccirone2/renewable-power-system-dashboard`, a FastAPI JSON API
on Cloud Run. Its CLAUDE.md and DEPLOYMENT.md cover the server side. The API address lives in
`js/config.js`.

## Contract with the backend (change both sides together)

- `EXPECTED_API_VERSION` (`js/app.js`) must equal `API_VERSION` in the backend's `server.py`.
- Endpoints: `GET /health` (no auth: `api_version`, `bokeh_version`, `auth_required`),
  `POST /api/login` → `{token, expires}`, and `GET /api/meta|cells|balance|strings|power|production`
  with `Authorization: Bearer <token>`.
- Chart payloads are `{range, resolution, charts: {key: spec}}`, and each spec is
  `{type: "bokeh", item}`, `{type: "plotly", figure, config}` or `{type: "message", text}`.
  Keys map to element ids in `loadRange()` / `loadProduction()`. `/api/balance` returns
  `cell_balance` → `#cell-balance-chart` and `cell_resistance_balance` → `#cell-resistance-chart`
  (per-cell bars with cells on the x axis, so not part of the zoom sync, but re-fetched for the
  visible window like everything in `loadRange`).
- The API only accepts browser requests from origins in its `ALLOWED_ORIGINS`
  (`https://ccirone2.github.io`). A new hosting origin needs a backend env change.
- **Synchronised zoom/pan**: the backend names its Bokeh figures `cell_voltage_plot`,
  `string_vi_plot` and `string_temp_plot` (`BOKEH_TIMESERIES` here), gives them x-only tools
  (pan as the default drag, x box zoom, no wheel zoom; hover/crosshair start off),
  and fires DOM events `ts-xrange` `{source, start, end}` / `ts-reset` on range change and reset.
  The Plotly `avg-power-chart` reports through `plotly_relayout` (`PLOTLY_TIMESERIES`). Renaming
  a figure on either side breaks the sync for that chart.

## Gotchas

- **BokehJS is loaded dynamically** at the version `/health` reports (`bokehLoader`). Don't
  hard-code Bokeh `<script>` tags. Bokeh 3.x has no separate CSS files; its styles ship inside the JS.
- **Plotly.js is 2.27.0**, which doesn't decode typed-array (`bdata`) data. The backend sends
  plain lists. Upgrading Plotly.js here is fine, but don't downgrade.
- **Re-rendering a chart**: `clearPlotly()` must remove the `js-plotly-plot` class after
  `Plotly.purge()`, and `clearBokeh()` must drop the old Bokeh documents. Otherwise placeholders
  linger next to new plots and `Bokeh.documents` grows.
- **Scroll snapping** (`scroll-snap-type: y mandatory` in `css/dashboard.css`): every region the
  user must reach needs `scroll-snap-align`, or the page can't rest there (the top of the page
  has the empty `.top-snap` anchor, since the sticky time bar can't be a snap point). Controls
  between two snapped cards end up under the sticky bars and can't be reached on phones. That's
  why the Period select lives in the Daily Energy card's header.
- **Sticky stack**: phone header (`--topbar-h`, 48px in portrait below 1024px) → `#time-bar`
  (`--timebar-h`) → `.section-bar` (`--sectionbar-h`, 0 on screens ≤520px tall, where it isn't
  sticky). `setupStickyOffsets()` measures the last two with a ResizeObserver, because the time
  bar grows (custom form, help, warnings). Snap margins and the chart card height
  (`.chart-container.chart-snap`: at most 75vh, shrunk to fit under the stack) use these
  variables. A card taller than the room under the stack lets the page rest with its top
  hidden.
- **Custom range form** sits in the time bar's first row, right of "Custom…", when
  `fitCustomForm()` finds room for everything at natural width (`customInline`). If it only fits
  without the bar's title, the title is hidden while the form is open (`customHidesTitle`; the
  title's width is remembered in `titleWidth`). Otherwise the form wraps onto its own line
  (`order-last basis-full`). It re-checks on open and on every time-bar
  resize, including the nav rail's hover expansion. Toggle things in that row with `:class`, not
  `x-show`: Alpine hides `x-show` elements a frame late, which makes the row wrap for a moment.
- **Chart sizing** comes from CSS: the `.chart-wrapper` flex chain plus absolutely positioned
  children. Bokeh figures use `stretch_both`, and Plotly uses `responsive: true` plus a
  ResizeObserver.
- The app is hidden until `phase === 'ready'` (`x-cloak`). Charts render after `$nextTick` so
  their containers have a size.
- **Zoom/pan sync** (`onChartRange` → `queueSync` → `scheduleViewFetch` → `loadRange({zoom:true})`):
  - All times are "wall ms": Chicago wall-clock time as if UTC, which is what Bokeh datetime
    axes hold and how Plotly's naive strings read. Use `wallMsFromText` / `isoMinuteFromWallMs` /
    `plotlyFromWallMs`; never `new Date(localString)`.
  - Our own `setv` / `Plotly.relayout` echo back as range events. They're ignored by comparing
    against `currentWindow()` within a small tolerance, so set `this.view` *before* syncing.
  - Responses are dropped if `viewVersion` changed meanwhile (the user zoomed again).
    `requestWindow()` clamps to what the API accepts (≥10 min, ≤732 days, ≤ now + 23 h), and the
    exact view is re-applied after rendering.
  - Bokeh's reset tool also snaps the range back, which emits range events. `clearView()` ignores
    range events for 400 ms.
  - Bokeh re-renders are double-buffered (`.bokeh-holder`): the new figure is drawn over the old
    one before the old one is removed.
  - The view lives in the URL as `from`/`to`; presets and custom ranges clear it.
- Tailwind's preflight `svg { display: block }` stacks Plotly's modebar icons; `css/dashboard.css`
  restores `inline-block` for `.modebar svg`.
- `?api=<url>` overrides `js/config.js` for the tab (sessionStorage); `?api=default` clears it.
  Don't persist the override in localStorage on this public origin.

## Testing

There's no test suite here. Check changes in a browser against a local API (see README "Local
development"). The backend session used headless Chromium (Playwright) to script the full
flow: sign-in, wrong password, presets, custom range, year, reload, password rotation, sign-out,
and API down.
