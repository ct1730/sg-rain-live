/* Singapore Rain — Live
   Live NEA rainfall (89 gauges, 5-min totals) + 2-hour nowcast (47 areas) from data.gov.sg.
   All rendering client-side. Fallback snapshot in data.js when the API is unreachable. */
'use strict';

const API = 'https://api-open.data.gov.sg/v2/real-time/api/';
const SGT = { timeZone: 'Asia/Singapore' };
const REFRESH_MS = 180000;          // data refreshes upstream ~every 5 min
const STALE_MS = 20 * 60 * 1000;    // reading older than this = stale
const HIST_KEY = 'sgrain.hist.v1';

/* ---------------------------------------------------------------- scale ---- */
// NEA rain gauge unit: millimetres of rain in the last 5 minutes.
const BANDS = [
  { max: 0.2, label: 'trace',   color: '#8ec9ee' },
  { max: 0.5, label: '0.2–0.5', color: '#5aa9e6' },
  { max: 1.5, label: '0.5–1.5', color: '#2f6fd0' },
  { max: 3.0, label: '1.5–3',   color: '#6a5bd8' },
  { max: 8.0, label: '3–8',     color: '#f2b134' },
  { max: 15.0, label: '8–15',   color: '#ec6a2a' },
  { max: Infinity, label: '15+', color: '#c81e4a' },
];
function band(mm) {
  for (const b of BANDS) if (mm < b.max) return b;
  return BANDS[BANDS.length - 1];
}
function bandLabel(mm) {
  if (!(mm > 0)) return 'dry';
  return band(mm).label + ' mm/5min';
}

const CATS = {
  fair:     { color: '#7fd4ff', emoji: '☀️', label: 'Fair' },
  cloudy:   { color: '#9fb2cb', emoji: '☁️', label: 'Cloudy' },
  windy:    { color: '#9fd8c8', emoji: '💨', label: 'Windy' },
  hazy:     { color: '#cbb98a', emoji: '🌫️', label: 'Hazy' },
  light:    { color: '#5aa9e6', emoji: '🌦️', label: 'Light rain / passing showers' },
  rain:     { color: '#2f6fd0', emoji: '🌧️', label: 'Moderate rain / showers' },
  heavy:    { color: '#ec6a2a', emoji: '🌧️', label: 'Heavy rain / heavy showers' },
  thundery: { color: '#c81e4a', emoji: '⛈️', label: 'Thundery showers' },
};
function catOf(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('thundery')) return 'thundery';
  if (t.includes('heavy') && (t.includes('rain') || t.includes('shower'))) return 'heavy';
  if (t.includes('shower') || t.includes('rain') || t.includes('drizzle')) return 'light';
  if (t.includes('wind')) return 'windy';
  if (t.includes('haz')) return 'hazy';
  if (t.includes('cloud')) return 'cloudy';
  if (t.includes('fair') || t.includes('sunny')) return 'fair';
  return 'cloudy';
}
const isRainyCat = k => k === 'light' || k === 'rain' || k === 'heavy' || k === 'thundery';

/* ------------------------------------------------------------------ util --- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function sgtTime(iso, withDate) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const opt = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (withDate) { opt.day = 'numeric'; opt.month = 'short'; }
  return new Intl.DateTimeFormat('en-SG', Object.assign({ timeZone: SGT.timeZone }, opt)).format(d) + ' SGT';
}
function km(a, b, c, d) {  // haversine, km
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLon = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ----------------------------------------------------------------- state --- */
const state = {
  source: 'live',          // 'live' | 'cached' | 'demo'
  readingTime: null,
  stations: [],
  nowcast: null,
  lastOk: null,
  history: [],
  you: null,               // {lat,lng}
  layers: { field: true, gauge: true, area: true },
  zoom: 12,
};

/* ------------------------------------------------------------------- map --- */
const SG = { lat: 1.3521, lng: 103.8198 };
const map = L.map('map', {
  center: [SG.lat, SG.lng], zoom: 12, zoomControl: true, minZoom: 10, maxZoom: 17,
  maxBounds: [[1.10, 103.45], [1.58, 104.22]], maxBoundsViscosity: 0.6,
  zoomSnap: 0.5, wheelPxPerZoomLevel: 90,
});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: 'Rainfall &amp; forecast: <b>NEA / data.gov.sg</b> · Map &copy; OpenStreetMap contributors',
}).addTo(map);
map.createPane('fieldPane'); map.getPane('fieldPane').style.zIndex = 350;
map.createPane('areaPane');  map.getPane('areaPane').style.zIndex  = 420;
map.createPane('labelPane'); map.getPane('labelPane').style.zIndex = 430;

const fieldLayer = L.layerGroup().addTo(map);
const gaugeLayer = L.layerGroup().addTo(map);
const areaLayer  = L.layerGroup().addTo(map);
let demoMode = null;   // set by the #demo= dev hook; re-applied after every refresh
let youMarker = null;

/* ------------------------------------------------------------ rain field --- */
// Inverse-distance interpolation of the gauge network, clipped to the main island.
// Honest about its limits: this is NOT radar, it cannot see rain between gauges.
function outlineBbox() {
  const o = window.__OUTLINE__ || [];
  const lats = o.map(p => p[1]), lngs = o.map(p => p[0]);
  return {
    minLat: Math.min(...lats) - 0.006, maxLat: Math.max(...lats) + 0.006,
    minLng: Math.min(...lngs) - 0.006, maxLng: Math.max(...lngs) + 0.006,
  };
}
function buildFieldImage(stations) {
  const b = outlineBbox();
  const step = 0.002;                                   // ≈ 220 m per cell
  const W = Math.ceil((b.maxLng - b.minLng) / step);
  const H = Math.ceil((b.maxLat - b.minLat) / step);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const pts = stations.filter(s => s.lat != null);

  for (let y = 0; y < H; y++) {
    const lat = b.maxLat - (y + 0.5) * step;            // image row 0 = north
    for (let x = 0; x < W; x++) {
      const lng = b.minLng + (x + 0.5) * step;
      let num = 0, den = 0, nearest = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const s = pts[i];
        const dy = (s.lat - lat) * 111.32;
        const dx = (s.lng - lng) * 111.32 * Math.cos(lat * Math.PI / 180);
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { num = s.mm; den = 1; nearest = 0; break; }
        if (d2 < nearest) nearest = d2;
        const w = 1 / (d2 + 0.02);                      // p≈2, mild regularisation
        num += w * s.mm; den += w;
      }
      let v = den ? num / den : 0;
      if (nearest > 36) v = 0;                          // >6 km from any gauge → no data
      const i4 = 4 * (y * W + x);
      if (v < 0.12) { img.data[i4 + 3] = 0; continue; }
      const c = band(v).color;
      const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), bl = parseInt(c.slice(5, 7), 16);
      img.data[i4] = r; img.data[i4 + 1] = g; img.data[i4 + 2] = bl;
      img.data[i4 + 3] = Math.round(clamp(60 + 150 * Math.min(1, Math.sqrt(v / 8)), 60, 205));
    }
  }
  ctx.putImageData(img, 0, 0);

  // clip to the island polygon so the field never paints the sea
  const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
  const mctx = mask.getContext('2d');
  const o = window.__OUTLINE__ || [];
  if (o.length > 2) {
    mctx.beginPath();
    o.forEach(([lng, lat], i) => {
      const px = (lng - b.minLng) / step, py = (b.maxLat - lat) / step;
      i ? mctx.lineTo(px, py) : mctx.moveTo(px, py);
    });
    mctx.closePath(); mctx.fillStyle = '#fff'; mctx.fill();
  } else {
    mctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  return {
    url: cv.toDataURL('image/png'),
    bounds: [[b.minLat, b.minLng], [b.maxLat, b.maxLng]],
    wetCells: (() => { let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) n++; return n; })(),
  };
}

function renderField() {
  fieldLayer.clearLayers();
  if (!state.layers.field) return;
  const wet = state.stations.some(s => s.mm > 0.12);
  if (!wet) return;                                     // nothing to shade
  const out = buildFieldImage(state.stations);
  L.imageOverlay(out.url, out.bounds, { opacity: 0.78, interactive: false, pane: 'fieldPane' })
    .addTo(fieldLayer);
}

/* ---------------------------------------------------------- gauge markers -- */
function renderGauges() {
  gaugeLayer.clearLayers();
  if (!state.layers.gauge) return;
  const t = state.readingTime;
  for (const s of state.stations) {
    const wet = s.mm > 0;
    const b = band(s.mm);
    const r = wet ? 4 + 11 * Math.sqrt(Math.min(s.mm, 20) / 20) : 2.8;
    const m = L.circleMarker([s.lat, s.lng], {
      radius: r,
      color: wet ? '#0b1220' : '#5d7290',
      weight: wet ? 1.4 : 1,
      fillColor: wet ? b.color : '#3c4f6a',
      fillOpacity: wet ? 0.95 : 0.45,
      pane: 'areaPane',
    });
    m.bindPopup(
      `<div class="pop-h">${s.name}</div>` +
      `<div class="pop-r"><span>Rain, last 5 min</span><b>${s.mm.toFixed(s.mm % 1 ? 1 : 0)} mm</b></div>` +
      `<div class="pop-r"><span>Intensity</span><b>${bandLabel(s.mm)}</b></div>` +
      `<div class="pop-r"><span>Reading</span><b>${sgtTime(t)}</b></div>` +
      `<div class="pop-r" style="margin-top:6px"><span>Gauge ${s.id}</span><span>${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</span></div>`
    );
    m.addTo(gaugeLayer);
  }
  $('gauge-n').textContent = `${state.stations.filter(s => s.mm > 0).length}/${state.stations.length}`;
}

/* ------------------------------------------------------- nowcast area dots -- */
let areaLabelMode = null;
function renderAreas() {
  areaLayer.clearLayers();
  if (!state.layers.area || !state.nowcast) return;
  const wantLabels = state.zoom >= 12;
  areaLabelMode = wantLabels;
  for (const a of state.nowcast.areas) {
    const k = catOf(a.forecast), c = CATS[k];
    const m = L.circleMarker([a.lat, a.lng], {
      radius: isRainyCat(k) ? 5.5 : 3.6, color: c.color, weight: 1.6,
      fillColor: c.color, fillOpacity: isRainyCat(k) ? 0.85 : 0.30, pane: 'areaPane',
    });
    m.bindPopup(
      `<div class="pop-h">${c.emoji} ${a.name}</div>` +
      `<div class="pop-r"><span>2-hour forecast</span><b>${a.forecast}</b></div>` +
      `<div class="pop-r"><span>Valid</span><b>${state.nowcast.text || sgtTime(state.nowcast.validStart) + '–' + sgtTime(state.nowcast.validEnd)}</b></div>`
    );
    if (wantLabels) {
      const showName = isRainyCat(k) || a.name.length <= 14;
      m.bindTooltip(`${c.emoji}${showName ? ' ' + a.name : ''}`, {
        permanent: true, direction: 'right', offset: [7, 0], className: 'lbl', pane: 'labelPane',
      });
    }
    m.addTo(areaLayer);
  }
}
let zoomTimer = null;
map.on('zoomend', () => {
  state.zoom = map.getZoom();
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => { const w = state.zoom >= 12; if (w !== areaLabelMode) renderAreas(); }, 220);
});

/* ------------------------------------------------------------- side panel -- */
function forecastCounts() {
  const by = {};
  for (const a of (state.nowcast ? state.nowcast.areas : [])) {
    const k = catOf(a.forecast);
    (by[k] = by[k] || []).push(a.name);
  }
  return by;
}

function renderPanel() {
  const wet = state.stations.filter(s => s.mm > 0);
  const maxS = wet.slice().sort((a, b) => b.mm - a.mm)[0];
  const total = wet.reduce((s, x) => s + x.mm, 0);
  $('asof').textContent = 'reading ' + sgtTime(state.readingTime, true);

  // verdict
  const by = forecastCounts();
  const rainyAreas = Object.keys(by).filter(isRainyCat).reduce((n, k) => n + by[k].length, 0);
  const worst = ['thundery', 'heavy', 'rain', 'light'].find(k => by[k]);
  let emo = '☀️', line = 'No rain anywhere in Singapore right now', sub = '';
  if (wet.length) {
    const b = band(maxS.mm);
    emo = maxS.mm >= 8 ? '⛈️' : maxS.mm >= 3 ? '🌧️' : maxS.mm >= 1.5 ? '🌦️' : '🌦️';
    const spread = wet.length / state.stations.length;
    line = `Rain in ${wet.length} of ${state.stations.length} gauge areas`;
    sub = `Heaviest: ${maxS.name} — ${maxS.mm.toFixed(1)} mm in 5 min (${b.label}). ` +
          (spread < 0.15 ? 'Localised shower activity.' : spread < 0.45 ? 'Scattered showers across the island.' : 'Widespread rain.');
  } else {
    sub = rainyAreas
      ? `Gauges are dry, but the 2-hour nowcast still calls for ${CATS[worst].label.toLowerCase()} in ${rainyAreas} area${rainyAreas > 1 ? 's' : ''}.`
      : 'Every gauge reads 0.0 mm and the 2-hour nowcast is dry island-wide.';
  }
  $('emo').textContent = emo;
  $('verdict').textContent = line;
  $('verdict-sub').textContent = sub;
  $('s-wet').textContent = wet.length + '/' + state.stations.length;
  $('s-max').textContent = maxS ? maxS.mm.toFixed(1) : '0.0';
  $('s-area').textContent = rainyAreas + '/' + (state.nowcast ? state.nowcast.areas.length : 0);

  const near = wet.filter(s => s.mm > 0.12).length;
  $('fld').innerHTML =
    `Island total across wet gauges: <b>${total.toFixed(1)} mm</b> per 5-min interval · ` +
    `met area: <b>${state.stations.length} gauges</b>` +
    (near ? '' : ' · field shading hidden (nothing above trace)');

  // wettest gauges
  const bars = $('bars');
  bars.innerHTML = '';
  if (!wet.length) {
    bars.innerHTML = `<div class="empty">💧 No gauge reports rain at ${sgtTime(state.readingTime)}. Check back after the next 5-minute update.</div>`;
  } else {
    const top = wet.sort((a, b) => b.mm - a.mm).slice(0, 8);
    const mx = top[0].mm;
    for (const s of top) {
      const b = band(s.mm);
      const el = document.createElement('div');
      el.className = 'bar';
      el.innerHTML =
        `<div><div class="nm">${s.name}</div><div class="track"><div class="fill" style="width:${clamp(100 * s.mm / mx, 4, 100)}%;background:${b.color}"></div></div></div>` +
        `<div class="val">${s.mm.toFixed(1)}<small>mm/5min</small></div>`;
      bars.appendChild(el);
    }
  }

  // nowcast grouping
  $('now-valid').textContent = state.nowcast
    ? (state.nowcast.text || '') + ' · ' + sgtTime(state.nowcast.validStart) + '–' + sgtTime(state.nowcast.validEnd)
    : '—';
  const rows = $('nowcast');
  rows.innerHTML = '';
  const order = ['thundery', 'heavy', 'rain', 'light', 'cloudy', 'windy', 'hazy', 'fair'];
  for (const k of order) {
    const list = (by[k] || []).slice();
    if (!list.length) continue;
    const c = CATS[k];
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span>${c.emoji} ${c.label}</span><span><b>${list.length}</b></span>`;
    rows.appendChild(row);
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.style.margin = '0 0 9px';
    for (const n of list.sort()) {
      const el = document.createElement('span');
      el.className = 'chip' + (isRainyCat(k) ? ' wet' : '');
      el.textContent = n;
      el.style.cursor = 'pointer';
      el.title = 'Show on map';
      el.onclick = () => {
        const a = state.nowcast.areas.find(x => x.name === n);
        if (a) { map.flyTo([a.lat, a.lng], 14, { duration: .7 }); }
      };
      chips.appendChild(el);
    }
    rows.appendChild(chips);
  }
  if (!rows.childElementCount) rows.innerHTML = '<div class="empty">Nowcast unavailable.</div>';

  renderLegend();
  renderNearMe();
  renderTrend();
}

function renderLegend() {
  $('scale').innerHTML = BANDS.map(b => {
    const nm = b.label === 'trace' ? 'trace' : b.label;
    return `<span class="swatch"><i style="background:${b.color}"></i>${nm}</span>`;
  }).join('');
  const by = forecastCounts();
  const keys = ['thundery', 'heavy', 'light', 'cloudy', 'fair'].filter(k => by[k]);
  $('cats').innerHTML = (keys.length ? keys : ['cloudy']).map(k => {
    const c = CATS[k];
    return `<span class="cat"><i style="background:${c.color}"></i>${c.emoji} ${c.label}${by[k] ? ' (' + by[k].length + ')' : ''}</span>`;
  }).join('');
}

/* --------------------------------------------------------------- near me --- */
function nearestWetGauge(lat, lng) {
  let best = null;
  for (const s of state.stations) {
    if (!(s.mm > 0)) continue;
    const d = km(lat, lng, s.lat, s.lng);
    if (!best || d < best.d) best = { d, s };
  }
  return best;
}
function nearestArea(lat, lng) {
  let best = null;
  for (const a of (state.nowcast ? state.nowcast.areas : [])) {
    const d = km(lat, lng, a.lat, a.lng);
    if (!best || d < best.d) best = { d, a };
  }
  return best;
}
function renderNearMe() {
  const el = $('nearme');
  if (!state.you) {
    el.innerHTML = 'Tap <b>📍 Near me</b> (or open <code>#test=1.3521,103.8198</code>) to see the nearest rain and your area’s forecast.';
    return;
  }
  const { lat, lng } = state.you;
  const w = nearestWetGauge(lat, lng);
  const a = nearestArea(lat, lng);
  const dry = state.stations.map(s => ({ d: km(lat, lng, s.lat, s.lng), s })).sort((x, y) => x.d - y.d)[0];
  const rainLine = w
    ? `<b style="color:${band(w.s.mm).color}">${w.s.name}</b> — ${w.s.mm.toFixed(1)} mm/5min, ${w.d < 1 ? (w.d * 1000).toFixed(0) + ' m' : w.d.toFixed(1) + ' km'} away`
    : `no rain recorded by any gauge. Closest gauge <b>${dry.s.name}</b> (${dry.d.toFixed(1)} km) reads 0.0 mm.`;
  const k = a ? catOf(a.a.forecast) : null;
  el.innerHTML =
    `<div class="rows">` +
    `<div class="row"><span>Nearest rain</span><span>${rainLine}</span></div>` +
    `<div class="row"><span>Your area</span><span><b>${a ? a.a.name : '—'}</b> · ${a ? a.a.forecast : ''} ${k ? CATS[k].emoji : ''}</span></div>` +
    `<div class="row"><span>Straight-line dist.</span><span>${a ? a.d.toFixed(1) + ' km to area centre' : '—'}</span></div>` +
    `</div>` +
    `<div style="margin-top:8px;color:var(--dim2)">Rain gauges are ~4 km apart on average, so “nearest rain” is the closest instrument reporting rain — a shower between gauges can be missed.</div>`;
}
function locate(lat, lng, label) {
  state.you = { lat, lng };
  if (youMarker) map.removeLayer(youMarker);
  youMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: '', html: '<div style="width:16px;height:16px;border-radius:50%;background:#3ecf8e;border:3px solid #0b1220;box-shadow:0 0 0 5px rgba(62,207,142,.25)"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    pane: 'labelPane', zIndexOffset: 900,
  }).addTo(map);
  youMarker.bindPopup(`<div class="pop-h">You are here</div><div class="pop-r"><span>${label || 'Your location'}</span><b>${lat.toFixed(4)}, ${lng.toFixed(4)}</b></div>`);
  map.flyTo([lat, lng], Math.max(map.getZoom(), 13), { duration: .7 });
  const h = $('hint');
  h.style.display = 'block';
  h.innerHTML = '📍 Located you. The <b>Near me</b> panel shows the closest rain.';
  setTimeout(() => { h.style.display = 'none'; }, 5000);
  renderNearMe();
}

/* ----------------------------------------------------------------- trend --- */
function loadHistory() {
  try { state.history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]') || []; }
  catch (e) { state.history = []; }
}
function pushHistory() {
  if (!state.readingTime) return;
  const wet = state.stations.filter(s => s.mm > 0);
  const rec = {
    t: state.readingTime,
    wet: wet.length,
    total: +wet.reduce((s, x) => s + x.mm, 0).toFixed(1),
    max: +Math.max(0, ...state.stations.map(s => s.mm)).toFixed(1),
    wetMax: wet.length ? wet.reduce((a, b) => a.mm > b.mm ? a : b).name : null,
  };
  const i = state.history.findIndex(r => r.t === rec.t);
  if (i >= 0) state.history[i] = rec; else state.history.push(rec);
  state.history = state.history.slice(-288);            // ~24 h at 5-min intervals
  try { localStorage.setItem(HIST_KEY, JSON.stringify(state.history)); } catch (e) { /* ignore */ }
}
function renderTrend() {
  const h = state.history;
  const svg = $('spark');
  $('trend-n').textContent = h.length ? `${h.length} sample${h.length > 1 ? 's' : ''}` : 'no samples yet';
  if (h.length < 2) {
    svg.innerHTML = '';
    $('t0').textContent = h.length ? sgtTime(h[0].t) : '—';
    $('t1').textContent = h.length ? sgtTime(h[h.length - 1].t) : '—';
    $('trend-txt').textContent = 'Stored in this browser only; a curve appears after the second refresh (~3 min).';
    return;
  }
  const W = 300, H = 64, pad = 6;
  const xs = h.map((_, i) => pad + i * (W - 2 * pad) / (h.length - 1));
  const mx = Math.max(2, ...h.map(r => r.wet));
  const ys = h.map(r => H - pad - (r.wet / mx) * (H - 2 * pad));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${H - pad} L${xs[0].toFixed(1)},${H - pad} Z`;
  svg.innerHTML =
    `<path d="${area}" fill="rgba(61,155,240,.18)"/>` +
    `<path d="${line}" fill="none" stroke="#3d9bf0" stroke-width="2" stroke-linejoin="round"/>` +
    h.map((r, i) => `<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="${r.wet === mx ? 3 : 1.8}" fill="${r.wet === mx ? '#f2b134' : '#7fb6ee'}"/>`).join('') +
    `<text x="${pad}" y="11" fill="#93a4bf" font-size="9">peak ${mx} wet gauges</text>`;
  $('t0').textContent = sgtTime(h[0].t);
  $('t1').textContent = sgtTime(h[h.length - 1].t);
  const now = h[h.length - 1], prev = h[h.length - 2];
  const dWet = now.wet - prev.wet, dTot = +(now.total - prev.total).toFixed(1);
  const arrow = dWet > 0 ? '▲' : dWet < 0 ? '▼' : '▬';
  const col = dWet > 0 ? '#ec6a2a' : dWet < 0 ? '#3ecf8e' : '#93a4bf';
  $('trend-txt').innerHTML =
    `Wet gauges <b>${prev.wet} → ${now.wet}</b> <span style="color:${col}">${arrow}</span> · ` +
    `island total ${prev.total.toFixed(1)} → <b>${now.total.toFixed(1)} mm</b> ` +
    `(${dTot >= 0 ? '+' : ''}${dTot}) · peak gauge now <b>${now.wetMax || '—'}</b> ${now.max.toFixed(1)} mm/5min.` +
    `<div style="margin-top:4px;color:var(--dim2)">History is kept in this browser only and builds up while the page is open (up to 24 h).</div>`;
}

/* ---------------------------------------------------------------- fetching - */
function shapeFromApi(rain, now) {
  const reading = rain.readings && rain.readings[0];
  const values = {};
  (reading ? reading.data : []).forEach(d => { values[d.stationId] = +d.value; });
  const stations = rain.stations.map(s => ({
    id: s.id, name: s.name,
    lat: +s.location.latitude, lng: +s.location.longitude,
    mm: +(values[s.id] || 0),
  }));
  const item = now.items && now.items[0] || {};
  const fmap = {};
  (item.forecasts || []).forEach(f => { fmap[f.area] = f.forecast; });
  return {
    readingTime: reading ? reading.timestamp : null,
    stations,
    nowcast: {
      text: (item.valid_period || {}).text || '',
      validStart: (item.valid_period || {}).start,
      validEnd: (item.valid_period || {}).end,
      updated: item.update_timestamp,
      areas: now.area_metadata.map(a => ({
        name: a.name, lat: +a.label_location.latitude, lng: +a.label_location.longitude,
        forecast: fmap[a.name] || 'N/A',
      })),
    },
    source: 'live',
  };
}
function shapeFromSnapshot(s) {
  return {
    readingTime: s.reading_time,
    stations: s.stations.map(x => ({ id: x.id, name: x.name, lat: x.lat, lng: x.lng, mm: +x.mm })),
    nowcast: { text: s.nowcast.text, validStart: s.nowcast.valid_start, validEnd: s.nowcast.valid_end, updated: s.nowcast.updated, areas: s.nowcast.areas },
    source: 'cached',
  };
}

async function loadLive(silent) {
  if (!silent) $('status').textContent = 'Refreshing…';
  let data = null, err = null;
  try {
    const [r1, r2] = await Promise.all([
      fetch(API + 'rainfall', { cache: 'no-store' }),
      fetch(API + 'two-hr-forecast', { cache: 'no-store' }),
    ]);
    if (!r1.ok || !r2.ok) throw new Error(`HTTP ${r1.status}/${r2.status}`);
    const j1 = await r1.json(), j2 = await r2.json();
    if (!j1.data || !j2.data) throw new Error('unexpected API shape (' + JSON.stringify(j1).slice(0, 80) + ')');
    data = shapeFromApi(j1.data, j2.data);
  } catch (e) { err = e; }

  if (!data) {
    const snap = window.__SNAPSHOT__;
    if (snap) data = shapeFromSnapshot(snap);
    else { $('status').textContent = 'Offline — ' + (err ? err.message : 'no data'); $('dot').className = 'dot off'; return; }
  }
  applyData(data, err);
}

function applyData(data, err) {
  Object.assign(state, data);
  state.lastOk = Date.now();
  pushHistory();
  renderGauges();
  renderAreas();
  renderField();
  renderPanel();

  const notice = $('notice');
  if (data.source === 'cached') {
    notice.innerHTML = `<div class="notice">⚠️ Live NEA feed unreachable from this browser${err ? ' (' + err.message + ')' : ''} —
      showing the last snapshot baked at <b>${sgtTime(data.readingTime, true)}</b>. Press Refresh to retry.</div>`;
  } else notice.innerHTML = '';

  const age = data.readingTime ? Date.now() - new Date(data.readingTime).getTime() : 0;
  const stale = age > STALE_MS;
  $('dot').className = 'dot' + (data.source === 'cached' ? ' off' : stale ? ' stale' : '');
  $('status').innerHTML =
    `${data.source === 'cached' ? 'Cached' : 'Live'} · as of <b>${sgtTime(data.readingTime)}</b>` +
    (stale ? ' · <span style="color:#f2b134">feed may be delayed</span>' : '') +
    ` · next check in <span id="cd">${(REFRESH_MS / 1000) | 0}s</span>`;
  startCountdown();
  if (demoMode) applyDemo(demoMode);   // keep the dev hook effective across refreshes
}

let cdTimer = null;
function startCountdown() {
  clearInterval(cdTimer);
  let left = REFRESH_MS / 1000;
  cdTimer = setInterval(() => {
    left -= 1;
    const el = $('cd');
    if (el) el.textContent = Math.max(0, left | 0) + 's';
    if (left <= 0) { clearInterval(cdTimer); loadLive(true); }
  }, 1000);
}

/* ------------------------------------------------------------------- demo -- */
// Dev/demo hook so the wet state can be screenshotted even on a dry island:
//   #demo=wet  → synthetic storm cells;  #demo=heavy → intense storm.
function applyDemo(mode) {
  const cells = mode === 'heavy'
    ? [[1.3500, 103.8490, 18], [1.4360, 103.7860, 12], [1.3260, 103.9300, 9], [1.3400, 103.7000, 6]]
    : [[1.3500, 103.8490, 4.2], [1.4360, 103.7860, 2.6], [1.3260, 103.9300, 1.4], [1.3400, 103.7000, 0.6]];
  for (const s of state.stations) {
    let best = 0;
    for (const [la, ln, mm] of cells) {
      const d = km(s.lat, s.lng, la, ln);
      best = Math.max(best, mm * Math.exp(-(d * d) / (2 * 2.2 * 2.2)));
    }
    s.mm = +best.toFixed(1);
  }
  const areas = state.nowcast ? state.nowcast.areas : [];
  for (const a of areas) {
    let cn = 0;
    for (const [la, ln] of cells) if (km(a.lat, a.lng, la, ln) < 5) cn++;
    a.forecast = cn >= 2 ? 'Heavy Thundery Showers' : cn === 1 ? (mode === 'heavy' ? 'Heavy Rain' : 'Light Rain') : a.forecast;
  }
  const rainy = areas.filter(a => isRainyCat(catOf(a.forecast))).map(a => a.name);
  const counts = {};
  for (const a of areas) { const k = catOf(a.forecast); counts[k] = (counts[k] || 0) + 1; }
  if (state.nowcast) state.nowcast.text = (state.nowcast.text || '') + ' · DEMO DATA (not live)';
  state.source = 'demo';
  $('notice').innerHTML = `<div class="notice">🧪 Demo mode <code>#demo=${mode}</code> — gauge values are synthetic, so the wet-state visuals can be checked. Remove the hash for live data.</div>`;
  renderGauges(); renderAreas(); renderField(); renderPanel();
  $('status').innerHTML = `Demo data · rainiest: <b>${rainy.slice(0, 3).join(', ') || '—'}</b> · live feed still refreshing`;
}

/* ------------------------------------------------------------------ boot --- */
function wire() {
  $('btn-refresh').onclick = () => loadLive(false);
  $('btn-me').onclick = () => {
    if (!navigator.geolocation) { $('nearme').textContent = 'Geolocation is not available in this browser.'; return; }
    $('nearme').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      p => locate(p.coords.latitude, p.coords.longitude, 'Your device location'),
      e => { $('nearme').innerHTML = `Location blocked or unavailable (${e.message}). Use <code>#test=lat,lng</code> instead.`; },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 30000 }
    );
  };
  const bind = (id, key, after) => {
    const el = $(id);
    const cb = el.querySelector('input');
    cb.checked = state.layers[key];
    el.classList.toggle('on', cb.checked);
    cb.onchange = () => {
      state.layers[key] = cb.checked;
      el.classList.toggle('on', cb.checked);
      after();
    };
  };
  bind('p-field', 'field', renderField);
  bind('p-gauge', 'gauge', renderGauges);
  bind('p-area', 'area', renderAreas);

  const hash = location.hash.slice(1);
  const test = /test=([-\d.]+),([-\d.]+)/.exec(hash);
  const demo = /demo=(\w+)/.exec(hash);
  if (test) setTimeout(() => locate(+test[1], +test[2], 'Test point (#test hook)'), 400);
  if (demo) demoMode = demo[1];   // applied by applyData() once real data has landed
}

loadHistory();
wire();
loadLive(false);
