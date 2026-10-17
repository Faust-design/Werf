/* werf: Offline-Start. App-Dateien aus dem Speicher, im Hintergrund aktualisiert. */
const V="werf-v3";
const SHELL=["./","index.html","config.js","cloud.js","i18n.js","texte.js","texte-i18n.js","geo.js","manifest.webmanifest","icons/icon-192.png","icons/apple-touch-icon.png","fonts/archivo-latin-wdth-normal.woff2","fonts/archivo-latin-ext-wdth-normal.woff2","rechtliches.html","lib/supabase-2.45.4.js"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V&&k!=="werf-ext").map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);
  /* eigene Dateien: sofort aus dem Speicher, dann frisch nachladen */
  if(u.origin===location.origin){e.respondWith(caches.open(V).then(async c=>{const hit=await c.match(r,{ignoreSearch:true});
    const net=fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res}).catch(()=>hit);return hit||net}));return}
  /* Schrift, Bibliotheken und freie Fotos: einmal laden, dann behalten */
  if(/upload\.wikimedia\.org|commons\.wikimedia\.org/.test(u.host)){
    e.respondWith(caches.open("werf-ext").then(async c=>{const hit=await c.match(r);if(hit)return hit;
      try{const res=await fetch(r);if(res.ok||res.type==="opaque")c.put(r,res.clone());return res}catch(_){return hit||Response.error()}}))}
});
