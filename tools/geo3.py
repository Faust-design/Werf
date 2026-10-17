"""Dritter Durchgang: alle benannten Orte im Gebiet einmal laden, dann lokal abgleichen."""
import json, re, time, urllib.request, urllib.parse, math, sys, os, difflib
exec(open("tools/geo.py").read().split("s, w, n, e = BBOX")[0])
s, w, n, e = -34.70, 18.10, -33.10, 20.60
WEB = {nm: web for nm, web, reg in BASE}; REGN = {nm: reg for nm, web, reg in BASE}
todo = [x.strip() for x in open("tools/todo.txt", encoding="utf-8") if x.strip()]
diag = {}
q = f"""[out:json][timeout:300][maxsize:536870912];
(
 nwr["name"]["tourism"]({s},{w},{n},{e});
 nwr["name"]["craft"]({s},{w},{n},{e});
 nwr["name"]["amenity"~"restaurant|cafe|bar|pub|events_venue"]({s},{w},{n},{e});
 nwr["name"]["shop"]({s},{w},{n},{e});
 nwr["name"]["landuse"~"vineyard|farmyard|farmland|orchard"]({s},{w},{n},{e});
 nwr["name"]["place"~"farm|isolated_dwelling|hamlet|locality"]({s},{w},{n},{e});
 nwr["name"]["building"~"winery|farm|house|yes|commercial|industrial"]({s},{w},{n},{e});
 nwr["website"]({s},{w},{n},{e});
 nwr["contact:website"]({s},{w},{n},{e});
 nwr["name"]["office"]({s},{w},{n},{e});
);
out center tags;"""
res = None
for ep in ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]:
    try:
        r = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
        res = json.loads(urllib.request.urlopen(r, timeout=400).read().decode()); diag["ep"] = ep; break
    except Exception as ex:
        diag.setdefault("errors", []).append(f"{ep}: {ex}")
els = (res or {}).get("elements", []); diag["elements"] = len(els)
C = []
for el in els:
    t = el.get("tags", {}); lat = el.get("lat") or el.get("center", {}).get("lat"); lon = el.get("lon") or el.get("center", {}).get("lon")
    if lat is None: continue
    C.append((t, lat, lon))
def score(t, d, c):
    nm = t.get("name", "")
    if "highway" in t or "boundary" in t or "waterway" in t or "railway" in t: return -9
    sc = 0; wd = dom(t.get("website") or t.get("contact:website") or t.get("url") or "")
    if d and wd and wd.split(".")[0] == d.split(".")[0]: sc += 10
    cn = core(nm) if nm else ""
    if cn:
        if cn == c: sc += 4
        elif len(c) >= 5 and (re.search(r"\b" + re.escape(c) + r"\b", cn) or (len(cn) >= 5 and re.search(r"\b" + re.escape(cn) + r"\b", c))): sc += 2
        elif difflib.SequenceMatcher(None, cn, c).ratio() >= .86: sc += 2
    if sc == 0: return -9
    if t.get("craft") == "winery" or t.get("tourism") == "wine_cellar" or t.get("building") == "winery": sc += 3
    if t.get("landuse") == "vineyard": sc += 2
    if t.get("place") == "farm" or t.get("landuse") == "farmyard": sc += 2
    if t.get("tourism") or t.get("amenity") or t.get("shop") in ("wine", "alcohol", "farm"): sc += 1
    if re.search(r"wine|wyn|vineyard|cellar|kelder|estate", nm, re.I): sc += 1
    return sc
out = {}
for name in todo:
    c = core(name); d = dom(WEB.get(name, "")); rl = GEB.get(REGN.get(name)); best = None
    for t, lat, lon in C:
        sc = score(t, d, c)
        if sc < 5: continue
        km = hav(rl[0], rl[1], lat, lon) if rl else 0
        if km > 45: continue
        cand = (sc, -km, lat, lon, t.get("name", ""), {k: v for k, v in t.items() if k in ("craft", "tourism", "landuse", "place", "amenity", "shop", "building", "website")})
        if not best or cand[:2] > best[:2]: best = cand
    if best: out[name] = dict(lat=round(best[2], 5), lng=round(best[3], 5), src="osm-suche", osm=best[4], score=best[0], km=round(-best[1], 1), tags=best[5])
json.dump({"diag": diag, "found": out}, open("tools/geo3.json", "w"), ensure_ascii=False, indent=1, sort_keys=True)
print(diag, len(out))
