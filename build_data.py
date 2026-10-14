"""Bake live NEA snapshot + Singapore island outline into web/data.js for the site.

Run:  python build_data.py
"""
import json
import math
import os
import re
import time
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (hermes-jarvis) sg-rain-live"}
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data.js")

API = "https://api-open.data.gov.sg/v2/real-time/api/"


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(4 * (i + 1))
    raise RuntimeError(f"fetch failed {url}: {last}")


def simplify(points, tol):
    """Douglas-Peucker on [[lng,lat],...] (closed ring: keep first point)."""
    if len(points) < 3:
        return points

    def dp(pts):
        if len(pts) < 3:
            return pts
        (x1, y1), (x2, y2) = pts[0], pts[-1]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        dmax, idx = -1.0, 0
        for i in range(1, len(pts) - 1):
            x0, y0 = pts[i]
            d = abs(dy * (x0 - x1) - dx * (y0 - y1)) / norm
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol:
            left, right = dp(pts[: idx + 1]), dp(pts[idx:])
            return left[:-1] + right
        return [pts[0], pts[-1]]

    out = []
    for part in split_open(points):
        d = dp(part)
        out.extend(d[:-1] if out else d)
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def split_open(ring):
    """Split a closed ring into two open polylines at the point farthest from ring[0]."""
    pts = list(ring)
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 4:
        return [pts]
    x0, y0 = pts[0]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - x0) ** 2 + (pts[i][1] - y0) ** 2)
    a, b = pts[: far + 1], pts[far:] + [pts[0]]
    return [a, b]


def outline():
    url = ("https://nominatim.openstreetmap.org/search?q=Singapore%20Island"
           "&format=json&polygon_geojson=1&polygon_threshold=0.0001&limit=1")
    j = get(url)
    rings = j[0]["geojson"]["coordinates"]
    best = max(rings, key=len)
    ring = [[round(float(c[0]), 5), round(float(c[1]), 5)] for c in best]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    raw = len(ring)
    tol = 0.0004
    simp = simplify(ring, tol)
    while len(simp) > 2200 and tol > 0.00005:
        tol *= 0.5
        simp = simplify(ring, tol)
    print(f"outline: {raw} pts -> {len(simp)} pts (tol={tol})", file=__import__("sys").stderr)
    return simp


def main():
    rain = get(API + "rainfall")["data"]
    now = get(API + "two-hr-forecast")["data"]
    ring = outline()

    stations = [
        {
            "id": s["id"],
            "name": s["name"],
            "lat": round(float(s["location"]["latitude"]), 5),
            "lng": round(float(s["location"]["longitude"]), 5),
        }
        for s in rain["stations"]
    ]
    reading = rain["readings"][0]
    values = {d["stationId"]: float(d["value"]) for d in reading["data"]}
    for s in stations:
        s["mm"] = values.get(s["id"], 0.0)

    areas = []
    fmap = {f["area"]: f["forecast"] for f in now["items"][0]["forecasts"]}
    for a in now["area_metadata"]:
        areas.append({
            "name": a["name"],
            "lat": round(float(a["label_location"]["latitude"]), 5),
            "lng": round(float(a["label_location"]["longitude"]), 5),
            "forecast": fmap.get(a["name"], "N/A"),
        })

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "reading_time": reading["timestamp"],
        "nowcast": {
            "valid_start": now["items"][0]["valid_period"]["start"],
            "valid_end": now["items"][0]["valid_period"]["end"],
            "text": now["items"][0]["valid_period"]["text"],
            "updated": now["items"][0].get("update_timestamp"),
            "areas": areas,
        },
        "stations": stations,
        "outline": ring,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// Baked fallback snapshot (NEA / data.gov.sg) — used only if live fetch fails.\n")
        fh.write("window.__OUTLINE__ = " + json.dumps(ring, separators=(",", ":")) + ";\n")
        fh.write("window.__SNAPSHOT__ = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    wet = [s for s in stations if s["mm"] > 0]
    print(f"baked {len(stations)} stations ({len(wet)} wet), {len(areas)} areas, "
          f"{len(ring)} outline pts -> {OUT}")


if __name__ == "__main__":
    main()
