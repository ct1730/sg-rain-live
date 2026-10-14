import re
import time
import urllib.request

URL = "https://ct1730.github.io/sg-rain-live/"
UA = {"User-Agent": "Mozilla/5.0 (hermes-jarvis) verify"}
for i in range(30):
    try:
        req = urllib.request.Request(URL, headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
        ok = r.status == 200 and "Singapore Rain" in body
        print(f"[{i}] HTTP {r.status} bytes={len(body)} has_title={'Singapore Rain' in body} "
              f"app_js={'app.js' in body} vendor={'vendor/leaflet/leaflet.js' in body}")
        if ok and "app.js" in body:
            for f in ("app.js", "data.js", "vendor/leaflet/leaflet.js"):
                with urllib.request.urlopen(urllib.request.Request(URL + f, headers=UA), timeout=20) as rr:
                    print(f"   {f}: {rr.status} {len(rr.read())} bytes")
            print("LIVE OK ->", URL)
            break
    except Exception as e:  # noqa: BLE001
        print(f"[{i}] not yet: {type(e).__name__} {e}")
    time.sleep(12)
else:
    print("TIMED OUT waiting for Pages")
