"""Echte Koordinaten für die Güter aus OpenStreetMap (Overpass + Nominatim).
Läuft als GitHub Action, schreibt tools/geo.json und tools/geo-report.md."""
import json, re, time, unicodedata, math, urllib.request, urllib.parse, difflib, os, sys
UA = "werf-winelands-guide/1.0 (private travel guide; github.com/Faust-design/werf)"
BBOX = (-34.70, 18.10, -33.10, 20.60)  # s, w, n, e
src = open("index.html", encoding="utf-8").read()
BASE = json.loads(re.search(r"const BASE=(\[\[.*?\]\]);", src, re.S).group(1))
GEB = {}
for m in re.finditer(r'"?([a-z\-]+)"?:\{name:"([^"]+)",lat:(-?[\d.]+),lng:(-?[\d.]+)', re.search(r"const GEBIETE=\{.*?\n\};", src, re.S).group(0)):
    GEB[m.group(1)] = (float(m.group(3)), float(m.group(4)))
STOP = set("wine wines estate estates vineyard vineyards winery wineries cellar cellars family farm farms wynlandgoed wynkelder landgoed kelder the and co boutique private vintners vineyards domaine wyn wynmakery organic de la le du".split())
def norm(s):
    s = unicodedata.normalize("NFD", s.lower()); s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9 ]+", " ", s.replace("&", " ").replace("'", ""))
def core(s):
    t = [w for w in norm(s).split() if w not in STOP]
    return " ".join(t) or norm(s).strip()
def dom(u):
    if not u: return ""
    u = re.sub(r"^[a-z]+://", "", u.strip().lower()); u = u.split("/")[0].split("?")[0]
    return re.sub(r"^www\d?\.", "", u)
def hav(a, b, c, d):
    R = 6371; p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))
def get(url, data=None):
    for i in range(2):
        try:
            r = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            return json.loads(urllib.request.urlopen(r, timeout=60).read().decode())
        except Exception as e:
            print("retry", url[:80], e); time.sleep(5 * (i + 1))
    return None

s, w, n, e = BBOX
q = f"""[out:json][timeout:170];
(
 nwr["craft"="winery"]({s},{w},{n},{e});
 nwr["tourism"="wine_cellar"]({s},{w},{n},{e});
 nwr["building"="winery"]({s},{w},{n},{e});
 nwr["industrial"="winery"]({s},{w},{n},{e});
 nwr["produce"~"wine|grape"]({s},{w},{n},{e});
 nwr["landuse"="vineyard"]["name"]({s},{w},{n},{e});
 nwr["place"="farm"]["name"]({s},{w},{n},{e});
 nwr["shop"="wine"]({s},{w},{n},{e});
 nwr["tourism"]["name"~"[Ww]ine|[Ee]state|[Vv]ineyard|[Ww]yn"]({s},{w},{n},{e});
 nwr["amenity"="restaurant"]["name"~"[Ww]ine|[Ee]state|[Vv]ineyard"]({s},{w},{n},{e});
);
out center tags;"""
res = get("https://overpass-api.de/api/interpreter", urllib.parse.urlencode({"data": q}).encode()) or {"elements": []}
OSM = []
for el in res["elements"]:
    t = el.get("tags", {}); nm = t.get("name") or t.get("name:en")
    lat = el.get("lat") or el.get("center", {}).get("lat"); lon = el.get("lon") or el.get("center", {}).get("lon")
    if not nm or lat is None: continue
    kind = "winery" if (t.get("craft") == "winery" or t.get("tourism") == "wine_cellar" or t.get("building") == "winery" or t.get("industrial") == "winery") else (t.get("landuse") or t.get("place") or t.get("tourism") or t.get("amenity") or t.get("shop") or "other")
    OSM.append(dict(name=nm, core=core(nm), lat=lat, lng=lon, dom=dom(t.get("website") or t.get("contact:website") or t.get("url") or ""), kind=kind, id=f'{el["type"]}/{el["id"]}'))
print("OSM candidates", len(OSM))
RANK = {"winery": 0, "vineyard": 1, "farm": 2}
def best(cands, reg):
    rl = GEB.get(reg)
    def key(c): return (RANK.get(c["kind"], 3), hav(rl[0], rl[1], c["lat"], c["lng"]) if rl else 0)
    return sorted(cands, key=key)[0]
out, report = {}, []
for name, web, reg in BASE:
    d, c = dom(web), core(name); rl = GEB.get(reg)
    near = lambda x: (not rl) or hav(rl[0], rl[1], x["lat"], x["lng"]) < 70
    hit, how = None, ""
    cand = [x for x in OSM if d and x["dom"] and (x["dom"] == d or x["dom"].split(".")[0] == d.split(".")[0])]
    if cand: hit, how = best(cand, reg), "osm-website"
    if not hit:
        cand = [x for x in OSM if x["core"] == c and near(x)]
        if cand: hit, how = best(cand, reg), "osm-name"
    if not hit:
        cand = [x for x in OSM if near(x) and len(c) >= 5 and (difflib.SequenceMatcher(None, x["core"], c).ratio() >= .88 or (len(x["core"]) >= 5 and (x["core"] in c or c in x["core"])))]
        if cand: hit, how = best(cand, reg), "osm-fuzzy"
    if hit:
        out[name] = dict(lat=round(hit["lat"], 5), lng=round(hit["lng"], 5), src=how, osm=hit["name"], id=hit["id"], km=round(hav(rl[0], rl[1], hit["lat"], hit["lng"]), 1) if rl else None)
print("matched via overpass", len(out))
# Nominatim für den Rest (höchstens 1 Anfrage pro Sekunde)
vb = f"{w},{n},{e},{s}"
for name, web, reg in BASE:
    if name in out: continue
    rl = GEB.get(reg); c = core(name); found = None
    for qq in [f"{name}", f"{name} wine", f"{c}"]:
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": qq, "format": "jsonv2", "countrycodes": "za", "viewbox": vb, "bounded": 1, "limit": 8, "extratags": 1})
        r = get(url) or []; time.sleep(1.2)
        ok = []
        for x in r:
            lat, lon = float(x["lat"]), float(x["lon"]); km = hav(rl[0], rl[1], lat, lon) if rl else 0
            nm = x.get("name") or x.get("display_name", "").split(",")[0]
            sim = difflib.SequenceMatcher(None, core(nm), c).ratio()
            if km < 70 and (sim >= .8 or (len(c) >= 5 and c in core(x.get("display_name", "")))):
                ok.append((-sim, km, lat, lon, nm, x.get("category", ""), x.get("type", "")))
        if ok:
            ok.sort(); _, km, lat, lon, nm, cat, typ = ok[0]
            found = dict(lat=round(lat, 5), lng=round(lon, 5), src="nominatim", osm=f"{nm} ({cat}/{typ})", km=round(km, 1)); break
    if found: out[name] = found
    else: report.append(name)
json.dump(out, open("tools/geo.json", "w"), ensure_ascii=False, indent=1, sort_keys=True)
with open("tools/geo-report.md", "w") as f:
    f.write(f"# Koordinaten\n\n{len(out)} von {len(BASE)} gefunden.\n\n")
    from collections import Counter
    f.write("Quellen: " + ", ".join(f"{k} {v}" for k, v in Counter(v["src"] for v in out.values()).items()) + "\n\n## Nicht gefunden\n\n" + "\n".join("- " + x for x in report) + "\n\n## Weit vom Ort entfernt (> 25 km)\n\n")
    f.write("\n".join(f"- {k}: {v['osm']} ({v['km']} km)" for k, v in out.items() if (v.get("km") or 0) > 25) + "\n")
json.dump(OSM, open("tools/osm-candidates.json", "w"), ensure_ascii=False)
print("done", len(out), "missing", len(report))
