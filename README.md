# Singapore Rain — Live 🌧️

A single-page, backend-free dashboard that shows **what the rain is doing in Singapore right now**.

Live: **https://ct1730.github.io/sg-rain-live/**

## What it shows

| Layer | Source | Notes |
|---|---|---|
| **Rain field** (shaded) | IDW interpolation of the 89 NEA gauges | Indicative only, clipped to the main island. Not a radar image. |
| **Gauges** (bubbles) | `v2/real-time/api/rainfall` (data.gov.sg / NEA) | mm of rain in the **last 5 minutes** per station; size + colour scale. |
| **2-h nowcast** (labels/dots) | `v2/real-time/api/two-hr-forecast` | 47 forecast areas, colour-coded by forecast type. |

Side panel: plain-language verdict, wet-gauge counts, peak intensity, top-8 wettest gauges,
nowcast breakdown by area (click a chip to fly to it), a **Near me** panel (nearest rain +
your area’s forecast), and a **trend** sparkline built from readings seen while the page is open.

Nothing is served from a server of ours: the browser fetches NEA directly every ~3 minutes
(the upstream feed updates every 5). `data.js` holds a baked fallback snapshot, used — and
clearly labelled — only if the API is unreachable.

## Files

```
web/index.html        markup + CSS (dark dashboard, responsive)
web/app.js            all logic: fetch, IDW field, Leaflet layers, panels, trend
web/data.js           baked snapshot fallback + Singapore island outline (from build_data.py)
web/vendor/leaflet/   Leaflet 1.9.4 self-hosted (no CDN dependency for the app shell)
build_data.py         regenerates web/data.js (snapshot + outline) — run to refresh the fallback
shots/                QA screenshots (not part of the site)
```

## Dev / QA hooks

* `#demo=wet` or `#demo=heavy` — inject synthetic storm cells (clearly labelled **DEMO DATA**) so the
  wet-state visuals can be checked even when the island is dry.
* `#test=1.3521,103.8198` — pretend the visitor is at that coordinate (used for the *Near me* panel,
  also lets headless browsers screenshot the located state without a geolocation prompt).

## Data & attribution

* Rainfall + nowcast: National Environment Agency via data.gov.sg (free, no API key, CORS-enabled).
* Island outline: © OpenStreetMap contributors (via Nominatim). Map tiles: OpenStreetMap.
* Rain gauges are ~4 km apart, so the field and the “nearest rain” answer are indicative: a shower
  between two gauges can go unseen. The official radar view is
  [weather.gov.sg/weather-rain-area-50km](https://www.weather.gov.sg/weather-rain-area-50km/).
