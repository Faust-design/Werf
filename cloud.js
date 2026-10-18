/* werf: Konto, Community-Beiträge, Freigaben und Abgleich privater Daten (Supabase).
   Läuft nur, wenn config.js eine Verbindung enthält. Ohne Verbindung bleibt alles lokal. */
(function(){
"use strict";
if(!CLOUD_ON)return;
const LIB="lib/supabase-2.45.4.js"; /* @supabase/supabase-js 2.45.4, MIT-Lizenz, selbst gehostet */
const box=document.getElementById("cloudbox"),mod=document.getElementById("mod");
let sb=null,user=null,profile=null,stats=null,pendingCount=0,pushT=0,lastRemoteGal=[];
window.CLOUD={user:null,editor:false};
const S=k=>{try{return localStorage.getItem(k)}catch(_){return null}},W=(k,v)=>{try{localStorage.setItem(k,v)}catch(_){}};

function loadLib(){return window.supabase?.createClient?Promise.resolve():new Promise((res,rej)=>{const s=document.createElement("script");s.src=LIB;s.onload=res;s.onerror=rej;document.head.appendChild(s)})}

/* ---------- Start ---------- */
async function init(){
  try{await loadLib()}catch(_){return}
  sb=window.supabase.createClient(CFG.url,CFG.anon,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  /* Erst zeigen, wenn die Datenbank eingerichtet ist (Tabellen vorhanden). Ohne Netz: zuletzt bekannten Zustand nutzen. */
  let ready=S("werf-cloud-ready")==="1";
  if(navigator.onLine){try{const h=await sb.from("profiles").select("id",{count:"exact",head:true});ready=!h.error;W("werf-cloud-ready",ready?"1":"0")}catch(_){}}
  if(!ready)return;
  window.CLOUD.ready=true;box.hidden=false;render();
  const {data}=await sb.auth.getSession();await setUser(data?.session?.user||null);
  sb.auth.onAuthStateChange((ev,s)=>{if(ev==="SIGNED_IN"||ev==="SIGNED_OUT")setUser(s?.user||null)});
  refreshCommunity()}
async function setUser(u){if((u?.id||null)===(user?.id||null)&&profile)return;user=u;profile=null;
  window.CLOUD.user=u?{id:u.id,email:u.email}:null;window.CLOUD.editor=false;
  if(u){const {data}=await sb.from("profiles").select("name,role").eq("id",u.id).maybeSingle();profile=data||{name:"",role:"user"};
    window.CLOUD.editor=profile.role==="editor";await loadStats();await pull()}
  render()}
async function loadStats(){if(!user)return;
  const {data}=await sb.from("contributions").select("status").eq("user_id",user.id);
  stats={pending:0,approved:0,rejected:0};(data||[]).forEach(r=>stats[r.status]=(stats[r.status]||0)+1);
  if(window.CLOUD.editor){const a=await sb.from("contributions").select("id",{count:"exact",head:true}).eq("status","pending");
    const b=await sb.from("photos").select("id",{count:"exact",head:true}).eq("status","pending");
    const c=await sb.from("estates").select("id",{count:"exact",head:true}).eq("status","pending");
    pendingCount=(a.count||0)+(b.count||0)+(c.count||0)}}

/* ---------- Freigegebene Inhalte laden und zwischenspeichern ---------- */
async function refreshCommunity(){if(!navigator.onLine)return;
  try{const c=await sb.from("contributions").select("estate_id,lang,field,value,created_at").eq("status","approved").order("created_at").limit(10000);
    const p=await sb.from("photos").select("id,estate_id,path,caption,user_id,created_at").eq("status","approved").order("created_at",{ascending:false}).limit(5000);
    const e=await sb.from("estates").select("id,name,town,web,lat,lng").eq("status","approved").limit(5000);
    if(c.error||p.error||e.error)return;
    const ids=[...new Set((p.data||[]).map(x=>x.user_id).filter(Boolean))];let names={};
    if(ids.length){const n=await sb.from("profiles").select("id,name").in("id",ids);(n.data||[]).forEach(x=>names[x.id]=x.name||"")}
    const next={c:c.data||[],p:p.data||[],e:e.data||[],names,at:Date.now()};
    const changed=JSON.stringify([next.c,next.p,next.e])!==JSON.stringify([COMM.c,COMM.p,COMM.e]);
    W("werf-community",JSON.stringify(next));
    if(!changed)return;const newEstates=next.e.some(x=>!byId[x.id]);COMM=next;
    /* Texte sofort übernehmen, wo du nichts Eigenes geschrieben hast; neue Güter nach dem nächsten Start */
    ESTATES.forEach(e=>{if(!EDITS[e.id]&&next.c.some(r=>r.estate_id===e.id)){applyCommunity(e);refreshDerived(e)}});
    if(view==="register")renderRegister();if(current&&!sinner.querySelector(".ed"))buildSheet(current);
    toast(newEstates?tt("Neue Güter der Community kommen beim nächsten Start dazu"):tt("Neue Beiträge der Community geladen"))}catch(_){}}

/* ---------- Private Daten: Merkliste, Planung, eigene Texte, Fotos ---------- */
const localAt=()=>+(S("werf-local-at")||0),syncedAt=()=>+(S("werf-sync-at")||0);
window.cloudDirty=()=>{W("werf-local-at",String(Date.now()));if(!user)return;clearTimeout(pushT);pushT=setTimeout(push,2500)};
function galMeta(){return Object.values(GAL).flat().map(g=>({gid:g.gid,estate:g.estate||Object.keys(GAL).find(k=>GAL[k].includes(g)),date:g.date,path:`${user.id}/${g.gid}.jpg`}))}
function snapshot(){return{saved,plan:PLAN,edits:EDITS,gal:galMeta()}}
function applySnapshot(d){if(!d)return;
  if(Array.isArray(d.saved))W("werf-merkliste",JSON.stringify(d.saved));
  if(d.plan&&Array.isArray(d.plan.days))W("werf-plan",JSON.stringify(d.plan));
  if(d.edits&&typeof d.edits==="object")W("werf-edits",JSON.stringify(d.edits))}
function merge(a,b){/* beide Stände zusammenführen: nichts geht verloren */
  const out={saved:[...new Set([...(a.saved||[]),...(b.saved||[])])],edits:Object.assign({},a.edits||{}),gal:[]};
  for(const [id,ed] of Object.entries(b.edits||{}))if(!out.edits[id]||(ed._at||0)>(out.edits[id]._at||0))out.edits[id]=ed;
  const days=new Map();[...(a.plan?.days||[]),...(b.plan?.days||[])].forEach(d=>{if(!days.has(d.id))days.set(d.id,d)});
  out.plan={days:[...days.values()].sort((x,y)=>x.date.localeCompare(y.date)),active:a.plan?.active||b.plan?.active||null};
  const g=new Map();[...(a.gal||[]),...(b.gal||[])].forEach(x=>{if(!g.has(x.gid))g.set(x.gid,x)});out.gal=[...g.values()];return out}
async function pull(){if(!user||!navigator.onLine)return;
  const {data,error}=await sb.from("user_data").select("data,updated_at").eq("user_id",user.id).maybeSingle();if(error)return;
  if(!data){await push();return}
  const remoteAt=Date.parse(data.updated_at)||0,remote=data.data||{};lastRemoteGal=remote.gal||[];
  const neverSynced=!syncedAt(),localDirty=localAt()>syncedAt();
  if(neverSynced||(localDirty&&remoteAt>syncedAt())){const m=merge(snapshot(),remote);applySnapshot(m);await fetchPhotos(m.gal);W("werf-sync-at",String(Date.now()));W("werf-local-at",String(Date.now()));await push(m);reloadSoon(tt("Daten von deinem Konto zusammengeführt"));return}
  if(remoteAt>syncedAt()){applySnapshot(remote);await fetchPhotos(remote.gal||[]);W("werf-sync-at",String(remoteAt));W("werf-local-at",String(remoteAt));reloadSoon(tt("Daten von deinem Konto geladen"));return}
  if(localDirty)await push()}
async function push(snap){if(!user||!navigator.onLine)return;const d=snap||snapshot();
  /* eigene Fotos privat hochladen, gelöschte entfernen */
  const local=new Set(d.gal.map(x=>x.gid)),had=new Set(lastRemoteGal.map(x=>x.gid));
  for(const g of Object.values(GAL).flat()){if(had.has(g.gid)||!g.blob)continue;
    await sb.storage.from("privat").upload(`${user.id}/${g.gid}.jpg`,g.blob,{contentType:"image/jpeg",upsert:true})}
  const gone=lastRemoteGal.filter(x=>!local.has(x.gid)).map(x=>x.path);if(gone.length)await sb.storage.from("privat").remove(gone);
  const now=new Date().toISOString();
  const {error}=await sb.from("user_data").upsert({user_id:user.id,data:d,updated_at:now});
  if(!error){lastRemoteGal=d.gal;W("werf-sync-at",String(Date.parse(now)));render()}}
async function fetchPhotos(list){const have=new Set(Object.values(GAL).flat().map(g=>g.gid));
  for(const m of list||[]){if(have.has(m.gid))continue;const {data}=await sb.storage.from("privat").download(m.path);if(!data)continue;
    await DB.galPut(m.gid,{estate:m.estate,blob:data,date:m.date})}}
function reloadSoon(msg){try{sessionStorage.setItem("werf-toast",msg);sessionStorage.setItem("werf-view",view)}catch(_){}setTimeout(()=>location.reload(),300)}
try{const m=sessionStorage.getItem("werf-toast");if(m){sessionStorage.removeItem("werf-toast");setTimeout(()=>toast(m),900)}}catch(_){}
addEventListener("online",()=>{if(user&&localAt()>syncedAt())push();refreshCommunity()});

/* ---------- Vorschläge ---------- */
window.cloudSuggest=async(id,pub)=>{if(!user)return false;
  const rows=Object.entries(pub).map(([field,value])=>({estate_id:id,lang:LANG,field,value}));
  const {data,error}=await sb.from("contributions").insert(rows).select("status");
  if(error){toast(tt("Vorschlag konnte nicht gesendet werden"));return false}
  const live=(data||[]).every(r=>r.status==="approved");
  setTimeout(()=>toast(live?tt("Für alle veröffentlicht"):tt("Danke. Dein Vorschlag erscheint nach der Prüfung für alle.")),1400);await loadStats();render();if(live)refreshCommunity();return true};
window.cloudSuggestPhoto=async(estate,rec)=>{if(!user||!rec?.blob)return false;
  const path=`${user.id}/${estate}-${rec.gid}.jpg`;
  const up=await sb.storage.from("fotos").upload(path,rec.blob,{contentType:"image/jpeg",upsert:true});if(up.error)return false;
  const {data,error}=await sb.from("photos").insert({estate_id:estate,path,taken_at:rec.date?new Date(rec.date).toISOString():null}).select("status").single();
  if(error)return false;await loadStats();render();if(data?.status==="approved"){refreshCommunity();return "live"}return "pending"};

/* ---------- Oberfläche unter „Konto“ ---------- */
function render(state){if(!box)return;
  if(state==="offline"){box.innerHTML=`<h3><i></i>${tt("Mitmachen")}</h3><p>${tt("Für Konto und Community braucht die App einmal Internet.")}</p>`;return}
  if(!user){const kb=document.getElementById("kbadge");if(kb)kb.textContent="";box.innerHTML=`<h3><i></i>${tt("Anmelden und mitmachen")}</h3>
    <p>${tt("Mit einem Konto ergänzt du leere Güter für alle und hast Merkliste, Planung, Notizen und Fotos auf jedem Gerät. Anmeldung ohne Passwort, mit einem Code per E-Mail.")}</p>
    <div class="row2"><input type="email" id="cEmail" placeholder="${tt("E-Mail-Adresse")}" autocomplete="email" inputmode="email"><button class="btn accent" id="cSend">${tt("Code senden")}</button></div>
    <div class="row2" id="cCodeRow" hidden style="margin-top:8px"><input type="text" id="cCode" placeholder="${tt("6-stelliger Code")}" inputmode="numeric" autocomplete="one-time-code" maxlength="8"><button class="btn" id="cVerify">${tt("Anmelden")}</button></div>
    <p class="msg" id="cMsg" aria-live="polite"></p>
    <p style="margin:0">${tt("Mit der Anmeldung stimmst du den {a} zu.",{a:`<a href="rechtliches.html#nutzung" style="color:#fff">${tt("Nutzungsbedingungen")}</a>`})} <a href="rechtliches.html#datenschutz" style="color:#fff">${tt("Datenschutz")}</a></p>`;return}
  const st=stats||{pending:0,approved:0},nm=(profile?.name||"").trim(),ini=(nm||user.email||"?").trim().charAt(0).toUpperCase();
  const kb=document.getElementById("kbadge");if(kb)kb.textContent=window.CLOUD.editor&&pendingCount?String(pendingCount):"";
  box.innerHTML=`<div class="who"><span class="ava" aria-hidden="true">${esc(ini)}</span><div><b>${esc(nm||tt("Mein Konto"))}</b><span>${esc(user.email)}</span></div></div>
    <div class="stat"><span>${tt("Deine Vorschläge:")} <b>${st.pending||0}</b> ${tt("offen")}, <b>${st.approved||0}</b> ${tt("freigegeben")}</span><span>${tt("Synchronisiert {d}",{d:syncedAt()?new Date(syncedAt()).toLocaleTimeString(LOC,{hour:"2-digit",minute:"2-digit"}):"–"})}</span></div>
    <div class="klist">${window.CLOUD.editor?`<button id="cMod">${tt("Freigaben")}${pendingCount?`<em>${pendingCount}</em>`:""}</button>`:""}<button id="cNew">${tt("Gut vorschlagen")}</button></div>
    <label class="fl" for="cName" style="display:block;font-size:13px;color:#9a9a9a;margin-bottom:6px">${tt("Dein Name für Bildnachweise")}</label>
    <div class="row2"><input type="text" id="cName" value="${esc(profile?.name||"")}" placeholder="${tt("Name")}" maxlength="40"><button class="btn ghost" id="cNameOk">${tt("Speichern")}</button></div>
    <p class="msg" id="cMsg" aria-live="polite"></p>
    <div class="kfoot"><button class="wlink" id="cOut" style="color:#fff">${tt("Abmelden")}</button><button class="wlink" id="cDel" style="color:#9a9a9a">${tt("Konto löschen")}</button></div>`}
box?.addEventListener("click",async ev=>{const id=ev.target.id,msg=()=>box.querySelector("#cMsg");
  if(id==="cSend"){const email=box.querySelector("#cEmail").value.trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){msg().textContent=tt("Bitte eine gültige E-Mail-Adresse eingeben.");return}
    ev.target.disabled=true;const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});ev.target.disabled=false;
    if(error){msg().textContent=tt("Das hat nicht geklappt. Versuche es in ein paar Minuten noch einmal.")+(error.message?` (${error.message})`:"");return}
    box.querySelector("#cCodeRow").hidden=false;box.querySelector("#cCode").focus();msg().textContent=tt("Wir haben dir einen Code geschickt. Gib ihn hier ein oder tippe auf den Link in der E-Mail.");return}
  if(id==="cVerify"){const email=box.querySelector("#cEmail").value.trim(),token=box.querySelector("#cCode").value.replace(/\D/g,"");
    const {error}=await sb.auth.verifyOtp({email,token,type:"email"});if(error){msg().textContent=tt("Der Code stimmt nicht oder ist abgelaufen.")+(error.message?` (${error.message})`:"");return}return}
  if(id==="cOut"){if(!confirm(tt("Abmelden? Deine Daten bleiben auf diesem Gerät und in deinem Konto.")))return;await sb.auth.signOut();try{localStorage.removeItem("werf-sync-at")}catch(_){}setUser(null);return}
  if(id==="cNameOk"){const name=box.querySelector("#cName").value.trim().slice(0,40);const {error}=await sb.from("profiles").update({name}).eq("id",user.id);
    msg().textContent=error?tt("Speichern hat nicht geklappt."):tt("Gespeichert.");if(!error){profile.name=name;render();box.querySelector("#cMsg").textContent=tt("Gespeichert.")}return}
  if(id==="cDel"){if(!confirm(tt("Konto endgültig löschen? Deine privaten Daten in der Cloud und deine offenen Vorschläge werden gelöscht. Freigegebene Beiträge bleiben ohne deinen Namen erhalten. Auf diesem Gerät bleibt alles gespeichert.")))return;
    try{for(const b of ["privat","fotos"]){const {data}=await sb.storage.from(b).list(user.id,{limit:1000});const own=(data||[]).map(f=>`${user.id}/${f.name}`);
        if(b==="fotos"){const keep=new Set((COMM.p||[]).map(x=>x.path));const del=own.filter(x=>!keep.has(x));if(del.length)await sb.storage.from(b).remove(del)}else if(own.length)await sb.storage.from(b).remove(own)}
      const {error}=await sb.rpc("delete_me");if(error)throw error;await sb.auth.signOut();try{localStorage.removeItem("werf-sync-at")}catch(_){}setUser(null);toast(tt("Dein Konto wurde gelöscht"))}
    catch(_){msg().textContent=tt("Löschen hat nicht geklappt. Versuche es später noch einmal.")}return}
  if(id==="cMod"){openMod();return}
  if(id==="cNew"){openNew();return}});

/* ---------- Neues Gut vorschlagen ---------- */
function openNew(){mod.hidden=false;document.body.style.overflow="hidden";
  mod.innerHTML=`<div class="modbar"><button data-mclose>${tt("Schließen")}</button><b>${tt("Gut vorschlagen")}</b><span></span></div><h2 class="cond">${tt("Neues Gut")}</h2>
  <div class="wrap ed" style="padding-top:0"><fieldset>
   <label class="fld"><span class="fl">${tt("Name")}</span><input type="text" id="nName" maxlength="80"></label>
   <label class="fld"><span class="fl">${tt("Website")}</span><input type="url" id="nWeb" placeholder="https://"></label>
   <label class="fld"><span class="fl">${tt("Ort")}</span><input type="text" id="nTown" list="nTowns" maxlength="60"><datalist id="nTowns">${Object.values(GEBIETE).map(G=>`<option value="${esc(G.name)}">`).join("")}</datalist></label>
   <label class="fld chk"><input type="checkbox" id="nGps"><i></i><span class="fl">${tt("Ich bin gerade dort: Standort als Lage verwenden")}</span></label>
  </fieldset><button class="btn accent" id="nSend" style="background:var(--duene)">${tt("Vorschlagen")}</button><p class="msg" id="nMsg" style="color:var(--duene);margin-top:8px"></p></div>`}
async function sendNew(){const name=$("#nName").value.trim(),web=$("#nWeb").value.trim(),townName=$("#nTown").value.trim(),m=$("#nMsg");
  if(name.length<2){m.textContent=tt("Bitte einen Namen eingeben.");return}
  if(byId[slugify(name)]||ESTATES.some(e=>norm(e.name)===norm(name))){m.textContent=tt("Dieses Gut gibt es schon.");return}
  if(web&&!/^https?:\/\//i.test(web)){m.textContent=tt("Die Website muss mit https:// beginnen.");return}
  const town=Object.entries(GEBIETE).find(([,G])=>norm(G.name)===norm(townName))?.[0]||slugify(townName)||"";
  let lat=null,lng=null;
  if($("#nGps").checked){try{const p=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:12000}));lat=p.coords.latitude;lng=p.coords.longitude}catch(_){m.textContent=tt("Der Standort ließ sich nicht bestimmen. Wähle einen Ort oder ein Gut.");return}}
  const {data,error}=await sb.from("estates").insert({id:slugify(name),name,web,town,lat,lng}).select("status").single();
  m.textContent=error?tt("Vorschlag konnte nicht gesendet werden"):data?.status==="approved"?tt("Für alle veröffentlicht. Das Gut erscheint beim nächsten Start der App."):tt("Danke. Das Gut erscheint nach der Prüfung für alle.");if(data?.status==="approved")refreshCommunity()}

/* ---------- Freigaben für Editoren ---------- */
const FLD={lead:"Einleitung",architektur:"Architektur",kunst:"Kunst",garten:"Garten",kueche:"Küche",abschnitte:"Text",adresse:"Adresse",zeiten:"Öffnungszeiten",reservierung:"Reservierung",kinder:"Mit Kindern",web:"Website"};
const show=v=>Array.isArray(v)?v.join("\n\n"):String(v??"");
async function openMod(){mod.hidden=false;document.body.style.overflow="hidden";
  mod.innerHTML=`<div class="modbar"><button data-mclose>${tt("Schließen")}</button><b>${tt("Freigaben")}</b><span></span></div><h2 class="cond">${tt("Freigaben")}</h2><p class="wrap small grey">${tt("Wird geladen …")}</p>`;
  const [c,p,e]=await Promise.all([sb.from("contributions").select("*").eq("status","pending").order("created_at").limit(200),
    sb.from("photos").select("*").eq("status","pending").order("created_at").limit(100),sb.from("estates").select("*").eq("status","pending").order("created_at").limit(100)]);
  const uids=[...new Set([...(c.data||[]),...(p.data||[]),...(e.data||[])].map(x=>x.user_id).filter(Boolean))];let names={};
  if(uids.length){const n=await sb.from("profiles").select("id,name").in("id",uids);(n.data||[]).forEach(x=>names[x.id]=x.name)}
  const who=x=>esc(names[x.user_id]||tt("Unbekannt"))+" · "+new Date(x.created_at).toLocaleDateString(LOC);
  const cards=[];
  (e.data||[]).forEach(x=>cards.push(`<div class="mcard" data-kind="estates" data-id="${esc(x.id)}"><h4>${tt("Neues Gut")}: ${esc(x.name)}</h4><p class="meta">${who(x)}</p><p class="new">${esc(x.town||"")} ${x.web?"· "+esc(x.web):""} ${x.lat!=null?"· "+x.lat.toFixed(4)+", "+x.lng.toFixed(4):""}</p><div class="acts"><button class="btn" data-ok>${tt("Freigeben")}</button><button class="btn line" data-no>${tt("Ablehnen")}</button></div></div>`));
  (c.data||[]).forEach(x=>{const est=byId[x.estate_id];const old=est?(x.field==="abschnitte"?(est._orig?.abschnitte||est.abschnitte?.map(a=>a.p)||[]):(est._orig&&x.field in est._orig?est._orig[x.field]:est[x.field])):"";
    cards.push(`<div class="mcard" data-kind="contributions" data-id="${x.id}"><h4>${esc(est?.name||x.estate_id)} · ${tt(FLD[x.field]||x.field)} · ${esc(x.lang.toUpperCase())}</h4><p class="meta">${who(x)}</p>${show(old)?`<p class="old">${esc(show(old))}</p>`:""}<p class="new">${esc(show(x.value))}</p><div class="acts"><button class="btn" data-ok>${tt("Freigeben")}</button><button class="btn line" data-no>${tt("Ablehnen")}</button></div></div>`)});
  (p.data||[]).forEach(x=>cards.push(`<div class="mcard" data-kind="photos" data-id="${x.id}" data-path="${esc(x.path)}"><h4>${tt("Foto")}: ${esc(byId[x.estate_id]?.name||x.estate_id)}</h4><p class="meta">${who(x)}</p><img src="${CFG.url}/storage/v1/object/public/fotos/${encodeURI(x.path)}" alt=""><div class="acts"><button class="btn" data-ok>${tt("Freigeben")}</button><button class="btn line" data-no>${tt("Ablehnen")}</button></div></div>`));
  mod.querySelector("p.wrap").outerHTML=cards.length?cards.join(""):`<p class="wrap empty">${tt("Nichts zu prüfen. Alles erledigt.")}</p>`}
mod?.addEventListener("click",async ev=>{const t=ev.target;
  if(t.closest("[data-mclose]")){mod.hidden=true;mod.innerHTML="";document.body.style.overflow="";await loadStats();render();return}
  if(t.id==="nSend"){sendNew();return}
  const card=t.closest(".mcard");if(!card||!(t.closest("[data-ok]")||t.closest("[data-no]")))return;
  const ok=!!t.closest("[data-ok]"),kind=card.dataset.kind,id=card.dataset.id;t.disabled=true;
  const upd={status:ok?"approved":"rejected"};if(kind!=="estates"){upd.reviewed_by=user.id;upd.reviewed_at=new Date().toISOString()}
  const {error}=await sb.from(kind).update(upd).eq("id",kind==="estates"?id:+id);
  if(error){t.disabled=false;toast(tt("Das hat nicht geklappt."));return}
  if(!ok&&kind==="photos")await sb.storage.from("fotos").remove([card.dataset.path]);
  card.animate([{opacity:1,transform:"none"},{opacity:0,transform:"translateX("+(ok?"":"-")+"60px)"}],{duration:260,easing:"ease-in"}).onfinish=()=>card.remove();
  refreshCommunity()});

init();
})();
