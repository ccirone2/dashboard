# Renewable Power Dashboard (frontend)

Static web page for the Renewable Power System Dashboard, served by GitHub Pages at
**https://ccirone2.github.io/dashboard/**.

The page has no server of its own. It signs in to the dashboard API (a Cloud Run service built
from the private `ccirone2/renewable-power-system-dashboard` repo) and draws the charts that
API returns: Bokeh items and Plotly figures as JSON.

**Deploying is committing.** Push to `main` and GitHub Pages republishes within about a minute.
Browsers may cache files for up to 10 minutes; hard-refresh to see a change immediately.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup: sign-in screen, sticky time bar with the range controls, chart containers (Tailwind + Alpine.js) |
| `css/dashboard.css` | Chart sizing (flex height chain), scroll snapping, navigation rail, loaders |
| `js/config.js` | **The API address** (`apiBase`). Change it if the Cloud Run URL changes |
| `js/app.js` | App logic: startup, sign-in, API client, chart rendering, range/period state |
| `404.html` | Sends any unknown path (old bookmarks) to the dashboard, keeping the query string |
| `.nojekyll` | Serve files as-is (no Jekyll processing) |

## How it works

1. `GET /health` (no auth) returns the API's `api_version`, `bokeh_version` and `auth_required`.
2. BokehJS is loaded from cdn.bokeh.org **at the version the API reports**, so a backend Bokeh
   upgrade needs no change here. Plotly.js (2.27.0), Tailwind and Alpine.js are pinned in `index.html`.
3. If auth is required and there is no saved token, the sign-in form posts to `/api/login`. The
   returned token (valid 30 days) is kept in `localStorage` and sent as `Authorization: Bearer …`.
   Any `401` signs the browser out. Changing the dashboard password signs everyone out.
4. The time bar's range (a 7d, 30d or 6M preset, 7d by default, or a custom start/end in Central time) drives the power, string,
   cell-voltage and summary charts (`/api/power`, `/api/strings`, `/api/cells`). The time bar
   stays pinned at the top while you scroll; its "?" button shows the zoom/pan help, and Sign out
   is in the navigation rail (the ☰ menu on phones). The "Period" select, in the Daily Energy
   card's header, drives the production totals (`/api/production`). The view is kept in the URL
   (`?hours=`, `?start=&end=`, `?year=`).

## Zooming and panning

On the Bokeh time charts (cell voltages, string charts), dragging **pans** through time; zoom with
the toolbar's x box-zoom tool. On the average-power chart, dragging box-zooms. All time charts
follow the same window, ◀ ▶ step it, and the toolbar's reset (power chart: double-click or
autoscale) returns to the time bar's range. There's no wheel zoom, so the wheel scrolls the page.
Hover readouts and crosshairs are in each Bokeh toolbar, off by default. After you stop, the page
re-fetches the visible window from the API, so detail increases as the window narrows (for
example 30-minute averages for a month, raw 5-minute samples within 72 hours). The zoomed window
is kept in the URL (`from`/`to`) and shown as a "Zoomed" chip with "Reset zoom". Y axes never
zoom. The daily/monthly/annual production charts aren't part of this; they follow the Period
selector.

## API contract

`EXPECTED_API_VERSION` in `js/app.js` must match `API_VERSION` in the backend's `server.py`.
Bump both when an endpoint or payload shape changes; the page shows a warning if they differ.
Chart payload keys map to element ids in `loadRange()` / `loadProduction()` in `js/app.js`.

## Local development

Serve this repo's **parent** folder (so the page lives at `/dashboard/`, as on Pages), then point
the page at a local API with `?api=`. The override lasts for the browser tab; `?api=default`
clears it.

```bash
cd .. && python3 -m http.server 8090 --bind 127.0.0.1
```

Open http://127.0.0.1:8090/dashboard/?api=http://127.0.0.1:8080. The local API must allow that
origin: start it with `ALLOWED_ORIGINS=http://127.0.0.1:8090` (see the backend README).
