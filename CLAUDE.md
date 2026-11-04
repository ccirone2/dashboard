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
  `POST /api/login` → `{token, expires}`, and `GET /api/meta|cells|strings|power|production`
  with `Authorization: Bearer <token>`.
- Chart payloads are `{range, resolution, charts: {key: spec}}`, and each spec is
  `{type: "bokeh", item}`, `{type: "plotly", figure, config}` or `{type: "message", text}`.
  Keys map to element ids in `loadRange()` / `loadProduction()`.
- The API only accepts browser requests from origins in its `ALLOWED_ORIGINS`
  (`https://ccirone2.github.io`). A new hosting origin needs a backend env change.

## Gotchas

- **BokehJS is loaded dynamically** at the version `/health` reports (`bokehLoader`). Don't
  hard-code Bokeh `<script>` tags. Bokeh 3.x has no separate CSS files; its styles ship inside the JS.
- **Plotly.js is 2.27.0**, which doesn't decode typed-array (`bdata`) data. The backend sends
  plain lists. Upgrading Plotly.js here is fine, but don't downgrade.
- **Re-rendering a chart**: `clearPlotly()` must remove the `js-plotly-plot` class after
  `Plotly.purge()`, and `clearBokeh()` must drop the old Bokeh documents. Otherwise placeholders
  linger next to new plots and `Bokeh.documents` grows.
- **Scroll snapping** (`scroll-snap-type: y mandatory` in `css/dashboard.css`): every region the
  user must reach, including the header with the range controls, needs `scroll-snap-align`, or
  the page can't rest there.
- **Chart sizing** comes from CSS: the `.chart-wrapper` flex chain plus absolutely positioned
  children. Bokeh figures use `stretch_both`, and Plotly uses `responsive: true` plus a
  ResizeObserver.
- The app is hidden until `phase === 'ready'` (`x-cloak`). Charts render after `$nextTick` so
  their containers have a size.
- `?api=<url>` overrides `js/config.js` for the tab (sessionStorage); `?api=default` clears it.
  Don't persist the override in localStorage on this public origin.

## Testing

There's no test suite here. Check changes in a browser against a local API (see README "Local
development"). The backend session used headless Chromium (Playwright) to script the full
flow: sign-in, wrong password, presets, custom range, year, reload, password rotation, sign-out,
and API down.
