"""Zweiter Durchgang für Güter ohne Treffer: Overpass-Suche nach Namen und Website, ohne Straßen und Orte."""
import json, re, time, urllib.request, urllib.parse, math, sys
sys.path.insert(0, "tools")
UA = "werf-winelands-guide/1.0 (private travel guide; github.com/Faust-design/werf)"
s, w, n, e = -34.70, 18.10, -33.10, 20.60
exec(open("tools/geo.py").read().split("s, w, n, e = BBOX")[0])  # BASE, GEB, norm, core, dom, hav, get
WEB = {nm: web for nm, web, reg in BASE}; REGN = {nm: reg for nm, web, reg in BASE}
todo = [x.strip() for x in open("tools/todo.txt", encoding="utf-8") if x.strip()]
BAD_PLACE = {"city", "town", "suburb", "neighbourhood", "village", "quarter", "county", "region", "state", "island"}
def score(t, d, c, nm):
    if "highway" in t or "boundary" in t or "waterway" in t or "railway" in t or "route" in t: return -9
    if t.get("place") in BAD_PLACE or t.get("natural") in ("peak", "ridge", "valley", "bay", "beach"): return -9
    if t.get("amenity") in ("hospital", "school", "childcare", "clinic", "parking", "fuel", "place_of_worship") or t.get("leisure") in ("park", "fitness_centre", "pitch"): return -9
    sc = 0
    if d and dom(t.get("website") or t.get("contact:website") or t.get("url") or "") .split(".")[0] == d.split(".")[0]: sc += 10
    if t.get("craft") == "winery" or t.get("tourism") == "wine_cellar" or t.get("building") == "winery": sc += 5
    if t.get("landuse") == "vineyard": sc += 4
    if t.get("place") == "farm" or t.get("landuse") in ("farmyard", "farmland"): sc += 3
    if t.get("tourism") or t.get("amenity") in ("restaurant", "cafe", "bar") or t.get("shop") in ("wine", "alcohol", "farm"): sc += 2
    cn = core(nm)
    if cn == c: sc += 3
    elif c in cn or cn in c: sc += 1
    return sc
out = {}
for name in todo:
    c = core(name); d = dom(WEB.get(name, "")); rl = GEB.get(REGN.get(name))
    words = [re.escape(x) for x in c.split() if len(x) > 2] or [re.escape(c)]
    rx = ".*".join(words)
    parts = [f'nwr["name"~"{rx}",i]({s},{w},{n},{e});']
    if d: parts += [f'nwr["website"~"{re.escape(d.split(".")[0])}",i]({s},{w},{n},{e});', f'nwr["contact:website"~"{re.escape(d.split(".")[0])}",i]({s},{w},{n},{e});']
    q = "[out:json][timeout:60];(" + "".join(parts) + ");out center tags 40;"
    r = get("https://overpass-api.de/api/interpreter", urllib.parse.urlencode({"data": q}).encode()) or {"elements": []}
    best = None
    for el in r.get("elements", []):
        t = el.get("tags", {}); nm = t.get("name", "")
        lat = el.get("lat") or el.get("center", {}).get("lat"); lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None: continue
        km = hav(rl[0], rl[1], lat, lon) if rl else 0
        if km > 40: continue
        sc = score(t, d, c, nm or "")
        if sc < 4: continue
        cand = (sc, -km, lat, lon, nm, {k: v for k, v in t.items() if k in ("craft", "tourism", "landuse", "place", "amenity", "shop", "building", "website")})
        if not best or cand[:2] > best[:2]: best = cand
    if best:
        out[name] = dict(lat=round(best[2], 5), lng=round(best[3], 5), src="osm-suche", osm=best[4], score=best[0], km=round(-best[1], 1), tags=best[5])
    print(name, "->", out.get(name, {}).get("osm"))
    time.sleep(1.5)
json.dump(out, open("tools/geo2.json", "w"), ensure_ascii=False, indent=1, sort_keys=True)
print("found", len(out), "of", len(todo))
