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
    window.CLOUD.editor=profile.role==="editor";await loadStats();await pull();
    if(TRIP){await tripPull();tripSub();await tripMembersLoad()}}
  else{if(tripChan){sb.removeChannel?.(tripChan);tripChan=null}tripMembers=[]}
  render();rerenderPlan();if(current&&!sinner.querySelector(".ed"))buildSheet(current);checkJoin()}
async function loadStats(){if(!user)return;
  const {data}=await sb.from("contributions").select("status").eq("user_id",user.id);
  stats={pending:0,approved:0,rejected:0};(data||[]).forEach(r=>stats[r.status]=(stats[r.status]||0)+1);
  if(window.CLOUD.editor){const a=await sb.from("contributions").select("id",{count:"exact",head:true}).eq("status","pending");
    const b=await sb.from("photos").select("id",{count:"exact",head:true}).eq("status","pending");
    const c=await sb.from("estates").select("id",{count:"exact",head:true}).eq("status","pending");
    const r=await sb.from("reports").select("id",{count:"exact",head:true}).eq("status","open");
    pendingCount=(a.count||0)+(b.count||0)+(c.count||0)+(r.count||0)}}

/* ---------- Freigegebene Inhalte laden und zwischenspeichern ---------- */
async function refreshCommunity(){if(!navigator.onLine)return;
  try{const c=await sb.from("contributions").select("id,user_id,estate_id,lang,field,value,created_at").eq("status","approved").order("created_at").limit(10000);
    const p=await sb.from("photos").select("id,estate_id,path,caption,user_id,created_at").eq("status","approved").order("created_at",{ascending:false}).limit(5000);
    const e=await sb.from("estates").select("id,name,town,web,lat,lng").eq("status","approved").limit(5000);
    if(c.error||p.error||e.error)return;
    const ids=[...new Set([...(p.data||[]),...(c.data||[])].map(x=>x.user_id).filter(Boolean))];let names={};
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
window.cloudDirty=()=>{W("werf-local-at",String(Date.now()));if(!user)return;clearTimeout(pushT);pushT=setTimeout(push,2500);tripDirty()};
function galMeta(){return Object.values(GAL).flat().map(g=>({gid:g.gid,estate:g.estate||Object.keys(GAL).find(k=>GAL[k].includes(g)),date:g.date,path:`${user.id}/${g.gid}.jpg`}))}
function snapshot(){return{saved,plan:PLAN,edits:EDITS,gal:galMeta(),visited:VISITED}}
function applySnapshot(d){if(!d)return;
  if(Array.isArray(d.saved))W("werf-merkliste",JSON.stringify(d.saved));
  if(d.plan&&Array.isArray(d.plan.days)&&!TRIP)W("werf-plan",JSON.stringify(d.plan));
  if(d.visited&&typeof d.visited==="object")W("werf-besucht",JSON.stringify(d.visited));
  if(d.edits&&typeof d.edits==="object")W("werf-edits",JSON.stringify(d.edits))}
function merge(a,b){/* beide Stände zusammenführen: nichts geht verloren */
  const out={saved:[...new Set([...(a.saved||[]),...(b.saved||[])])],edits:Object.assign({},a.edits||{}),gal:[],visited:Object.assign({},b.visited||{})};
  for(const [id,d] of Object.entries(a.visited||{}))if(!out.visited[id]||String(d)<String(out.visited[id]))out.visited[id]=d;
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
const kSet=document.getElementById("kSet"),kSettings=document.getElementById("kSettings"),kDevice=document.getElementById("kDevice");
function render(state){if(!box)return;
  const kb=document.getElementById("kbadge");if(kb)kb.textContent=user&&window.CLOUD.editor&&pendingCount?String(pendingCount):"";
  if(kSettings)kSettings.hidden=!user;if(kDevice)kDevice.hidden=!(user&&window.CLOUD.editor);
  if(state==="offline"){box.innerHTML=`<h3><i></i>${tt("Mitmachen")}</h3><p>${tt("Für Konto und Community braucht die App einmal Internet.")}</p>`;return}
  if(!user){box.innerHTML=`<h3><i></i>${tt("Anmelden und mitmachen")}</h3>
    <p>${tt("Mit einem Konto ist deine Reise gesichert und auf jedem Gerät da, du planst gemeinsam mit anderen und ergänzt Güter für alle. Anmeldung ohne Passwort, mit einem Code per E-Mail.")}</p>
    <div class="row2"><input type="email" id="cEmail" placeholder="${tt("E-Mail-Adresse")}" autocomplete="email" inputmode="email"><button class="btn accent" id="cSend">${tt("Code senden")}</button></div>
    <div class="row2" id="cCodeRow" hidden style="margin-top:8px"><input type="text" id="cCode" placeholder="${tt("6-stelliger Code")}" inputmode="numeric" autocomplete="one-time-code" maxlength="8"><button class="btn" id="cVerify">${tt("Anmelden")}</button></div>
    <p class="msg" id="cMsg" aria-live="polite"></p>
    <p style="margin:0">${tt("Mit der Anmeldung stimmst du den {a} zu.",{a:`<a href="rechtliches.html#nutzung" style="color:#fff">${tt("Nutzungsbedingungen")}</a>`})} <a href="rechtliches.html#datenschutz" style="color:#fff">${tt("Datenschutz")}</a></p>`;
    if(kSet)kSet.innerHTML="";return}
  const st=stats||{pending:0,approved:0},nm=(profile?.name||"").trim(),ini=(nm||user.email||"?").trim().charAt(0).toUpperCase();
  box.innerHTML=`<div class="who"><span class="ava" aria-hidden="true">${esc(ini)}</span><div><b>${esc(nm||tt("Mein Konto"))}</b><span>${esc(user.email)}</span></div></div>
    <div class="stat"><span>${tt("Deine Beiträge:")} <b>${st.approved||0}</b> ${tt("veröffentlicht")}${st.pending?`, <b>${st.pending}</b> ${tt("in Prüfung")}`:""}</span><span>${tt("Gesichert {d}",{d:syncedAt()?new Date(syncedAt()).toLocaleTimeString(LOC,{hour:"2-digit",minute:"2-digit"}):"–"})}</span></div>
    <div class="klist">${window.CLOUD.editor?`<button id="cMod">${tt("Freigaben und Meldungen")}${pendingCount?`<em>${pendingCount}</em>`:""}</button>`:""}<button id="cNew">${tt("Gut vorschlagen")}</button></div>
    <p class="msg" id="cMsg" aria-live="polite"></p>`;
  if(kSet&&!kSet.contains(document.activeElement))kSet.innerHTML=`
    <label class="kfl" for="cName">${tt("Dein Name für Bildnachweise")}</label>
    <div class="krow2"><input type="text" id="cName" value="${esc(profile?.name||"")}" placeholder="${tt("Name")}" maxlength="40"><button class="btn line" id="cNameOk">${tt("Speichern")}</button></div>
    <label class="kfl" for="cMail">${tt("E-Mail-Adresse")}</label>
    <div class="krow2"><input type="email" id="cMail" value="${esc(user.email||"")}" autocomplete="email" inputmode="email"><button class="btn line" id="cMailOk">${tt("Ändern")}</button></div>
    <p class="msg" id="sMsg" aria-live="polite"></p>
    <div class="kfoot2"><button class="wlink" id="cOut">${tt("Abmelden")}</button><button class="wlink" id="cDel">${tt("Konto löschen")}</button></div>`}
window.cloudLoginHint=msg=>{if(user)return;const m=box.querySelector("#cMsg"),i=box.querySelector("#cEmail");if(m)m.textContent=msg;box.scrollIntoView({block:"center",behavior:"smooth"});setTimeout(()=>i?.focus(),400)};
async function onAccountClick(ev){const id=ev.target.id;if(!id)return;const msg=()=>document.getElementById(ev.currentTarget===box?"cMsg":"sMsg");
  if(id==="cSend"){const email=box.querySelector("#cEmail").value.trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){msg().textContent=tt("Bitte eine gültige E-Mail-Adresse eingeben.");return}
    ev.target.disabled=true;const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});ev.target.disabled=false;
    if(error){msg().textContent=tt("Das hat nicht geklappt. Versuche es in ein paar Minuten noch einmal.")+(error.message?` (${error.message})`:"");return}
    box.querySelector("#cCodeRow").hidden=false;box.querySelector("#cCode").focus();msg().textContent=tt("Wir haben dir einen Code geschickt. Gib ihn hier ein oder tippe auf den Link in der E-Mail.");return}
  if(id==="cVerify"){const email=box.querySelector("#cEmail").value.trim(),token=box.querySelector("#cCode").value.replace(/\D/g,"");
    const {error}=await sb.auth.verifyOtp({email,token,type:"email"});if(error){msg().textContent=tt("Der Code stimmt nicht oder ist abgelaufen.")+(error.message?` (${error.message})`:"");return}return}
  if(id==="cOut"){if(!confirm(tt("Abmelden? Deine Daten bleiben auf diesem Gerät und in deinem Konto.")))return;await sb.auth.signOut();try{localStorage.removeItem("werf-sync-at")}catch(_){}setUser(null);return}
  if(id==="cNameOk"){const name=kSet.querySelector("#cName").value.trim().slice(0,40);const {error}=await sb.from("profiles").update({name}).eq("id",user.id);
    if(!error){profile.name=name;kSet.innerHTML="";render()}msg().textContent=error?tt("Speichern hat nicht geklappt."):tt("Gespeichert.");return}
  if(id==="cMailOk"){const email=kSet.querySelector("#cMail").value.trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){msg().textContent=tt("Bitte eine gültige E-Mail-Adresse eingeben.");return}
    if(email.toLowerCase()===String(user.email).toLowerCase()){msg().textContent=tt("Das ist schon deine Adresse.");return}
    ev.target.disabled=true;const {error}=await sb.auth.updateUser({email},{emailRedirectTo:location.origin+location.pathname});ev.target.disabled=false;
    msg().textContent=error?tt("Das hat nicht geklappt.")+(error.message?` (${error.message})`:""):tt("Fast geschafft: Bestätige die neue Adresse über den Link in der E-Mail. Je nach Einstellung kommt auch eine Mail an deine bisherige Adresse. Bis dahin gilt die alte.");return}
  if(id==="cDel"){if(!confirm(tt("Konto endgültig löschen? Deine privaten Daten in der Cloud und deine offenen Vorschläge werden gelöscht. Freigegebene Beiträge bleiben ohne deinen Namen erhalten. Auf diesem Gerät bleibt alles gespeichert.")))return;
    try{for(const b of ["privat","fotos"]){const {data}=await sb.storage.from(b).list(user.id,{limit:1000});const own=(data||[]).map(f=>`${user.id}/${f.name}`);
        if(b==="fotos"){const keep=new Set((COMM.p||[]).map(x=>x.path));const del=own.filter(x=>!keep.has(x));if(del.length)await sb.storage.from(b).remove(del)}else if(own.length)await sb.storage.from(b).remove(own)}
      const {error}=await sb.rpc("delete_me");if(error)throw error;await sb.auth.signOut();try{localStorage.removeItem("werf-sync-at");localStorage.removeItem("werf-trip")}catch(_){}TRIP=null;setUser(null);toast(tt("Dein Konto wurde gelöscht"))}
    catch(_){msg().textContent=tt("Löschen hat nicht geklappt. Versuche es später noch einmal.")}return}
  if(id==="cMod"){openMod();return}
  if(id==="cNew"){openNew();return}}
box?.addEventListener("click",onAccountClick);kSet?.addEventListener("click",onAccountClick);

/* ---------- Gemeinsame Reise ---------- */
let TRIP=null;try{TRIP=JSON.parse(S("werf-trip")||"null")}catch(_){}
let tripAt=+(S("werf-trip-at")||0),tripPushT=0,tripMembers=[],tripChan=null;
const saveTrip=()=>{W("werf-trip",JSON.stringify(TRIP));if(!TRIP)try{localStorage.removeItem("werf-trip")}catch(_){}};
const tripLink=()=>location.origin+location.pathname+"?reise="+encodeURIComponent(TRIP.code);
const rerenderPlan=()=>{if(view==="merkliste")renderPlan({draw:false})};
window.tripBar=()=>{if(!window.CLOUD.ready)return "";
  if(!user)return (saved.length||PLAN.days.length)?`<div class="tripbar"><b>${tt("Sichere deine Reise und melde dich an")}</b><p>${tt("Ohne Konto liegt deine Planung nur in diesem Browser. Safari löscht solche Daten, wenn du die Seite eine Woche nicht öffnest. Mit Konto ist sie gesichert, auf jedem Gerät da und lässt sich mit anderen teilen.")}</p><div class="row2"><button class="btn accent" data-tb="login">${tt("Anmelden")}</button></div></div>`:"";
  if(TRIP){const nameOf=id=>{const m=tripMembers.find(x=>x.id===id);return m?(m.me?tt("dir"):m.name):null};
    const rows=tripMembers.map(m=>`<li><i>${esc(m.name.charAt(0).toUpperCase())}</i><span><b>${esc(m.name)}${m.me?` <em>${tt("(du)")}</em>`:""}</b><small>${m.id===tripMeta.owner?tt("hat die Reise angelegt"):tt("dabei seit {d}",{d:new Date(m.since).toLocaleDateString(LOC,{day:"numeric",month:"short"})})}</small></span></li>`).join("");
    const last=tripMeta.at&&nameOf(tripMeta.by)?`<p class="tlast">${tt("Zuletzt geändert von {x}, {t}",{x:esc(nameOf(tripMeta.by)),t:new Date(tripMeta.at).toLocaleString(LOC,{weekday:"short",hour:"2-digit",minute:"2-digit"})})}</p>`:"";
    return `<div class="tripbar"><b>${tt("Gemeinsame Reise")}</b><p>${tripMembers.length>1?tt("{n} Personen planen mit. Änderungen sehen alle sofort.",{n:tripMembers.length}):tt("Noch plant niemand mit. Schick den Link an deine Mitreisenden.")}</p><ul class="tmembers">${rows}</ul>${last}<div class="row2"><button class="btn accent" data-tb="share">${tt("Link teilen")}</button><button class="btn ghost" data-tb="leave">${tt("Reise verlassen")}</button></div></div>`}
  if(PLAN.days.length)return `<div class="tripbar"><b>${tt("Gemeinsam planen")}</b><p>${tt("Teile diese Reise. Wer den Link öffnet und sich anmeldet, sieht und ändert die Planung mit.")}</p><div class="row2"><button class="btn accent" data-tb="create">${tt("Reise teilen")}</button></div></div>`;
  return ""};
async function tripShare(){const url=tripLink();
  try{if(navigator.share){await navigator.share({title:"werf",text:tt("Plan die Reise mit mir in werf"),url});return}}catch(e){if(e?.name==="AbortError")return}
  try{await navigator.clipboard.writeText(url);toast(tt("Link kopiert"))}catch(_){prompt(tt("Link zum Teilen"),url)}}
let tripMeta={owner:null,by:null,at:0};
async function tripMembersLoad(){if(!TRIP)return;const {data}=await sb.from("trip_members").select("user_id,joined_at").eq("trip_id",TRIP.id);
  const rows=(data||[]).slice().sort((a,b)=>String(a.joined_at).localeCompare(String(b.joined_at)));if(!rows.length){tripMembers=[];return}
  const n=await sb.from("profiles").select("id,name").in("id",rows.map(r=>r.user_id));const nm={};(n.data||[]).forEach(x=>nm[x.id]=x.name);
  const before=new Set(tripMembers.map(m=>m.id));
  tripMembers=rows.map(r=>({id:r.user_id,me:r.user_id===user?.id,name:(nm[r.user_id]||"").trim()||tt("Unbekannt"),since:r.joined_at}));
  if(before.size)tripMembers.filter(m=>!before.has(m.id)&&!m.me).forEach(m=>toast(tt("{x} plant jetzt mit",{x:m.name})))}
function tripSub(){if(tripChan){sb.removeChannel?.(tripChan);tripChan=null}if(!TRIP||!sb.channel)return;
  tripChan=sb.channel("trip-"+TRIP.id).on("postgres_changes",{event:"UPDATE",schema:"public",table:"trips",filter:"id=eq."+TRIP.id},p=>{if(p.new?.updated_by!==user?.id)tripPull()}).subscribe()}
function applyTripData(d){if(!d||!Array.isArray(d.days))return;
  PLAN.days=d.days.map(x=>({...x,stops:(x.stops||[]).filter(s=>byId[s.id])}));if(!PLAN.days.some(x=>x.id===PLAN.active))PLAN.active=PLAN.days[0]?.id||null;
  W("werf-plan",JSON.stringify(PLAN))}
async function tripPull(force){if(!TRIP||!user||!navigator.onLine)return;
  const {data,error}=await sb.from("trips").select("data,updated_at,updated_by,owner").eq("id",TRIP.id).maybeSingle();if(error)return;
  if(data)tripMeta={owner:data.owner,by:data.updated_by,at:Date.parse(data.updated_at)||0};
  if(!data){TRIP=null;saveTrip();toast(tt("Die gemeinsame Reise gibt es nicht mehr. Deine Tage bleiben bei dir."));rerenderPlan();return}
  const at=Date.parse(data.updated_at)||0,n=tripMembers.length;await tripMembersLoad();
  if(force||at>tripAt){applyTripData(data.data);tripAt=at;W("werf-trip-at",String(at));rerenderPlan()}else if(tripMembers.length!==n)rerenderPlan()}
async function tripPush(){if(!TRIP||!user||!navigator.onLine)return;
  /* hat jemand anderes inzwischen geändert? Dann Tage zusammenführen, deine Änderung gewinnt */
  const cur=await sb.from("trips").select("data,updated_at").eq("id",TRIP.id).maybeSingle();
  let days=PLAN.days;if(cur.data&&(Date.parse(cur.data.updated_at)||0)>tripAt){const mine=new Set(days.map(d=>d.id)),gone=new Set(TRIP.deleted||[]);
    days=[...days,...(cur.data.data?.days||[]).filter(d=>!mine.has(d.id)&&!gone.has(d.id))].sort((a,b)=>a.date.localeCompare(b.date));applyTripData({days})}
  const {data,error}=await sb.from("trips").update({data:{days:days.map(({id,date,start,stops})=>({id,date,start,stops}))}}).eq("id",TRIP.id).select("updated_at").maybeSingle();
  if(!error&&data){tripAt=Date.parse(data.updated_at)||Date.now();tripMeta.by=user.id;tripMeta.at=tripAt;W("werf-trip-at",String(tripAt));TRIP.deleted=[];saveTrip()}rerenderPlan()}
const tripDirty=()=>{if(!TRIP)return;clearTimeout(tripPushT);tripPushT=setTimeout(tripPush,1200)};
async function tripCreate(){const {data,error}=await sb.rpc("create_trip",{d:{days:PLAN.days}});
  const row=Array.isArray(data)?data[0]:data;if(error||!row){toast(tt("Das hat nicht geklappt."));return}
  TRIP={id:row.id,code:row.code,deleted:[]};saveTrip();tripAt=Date.now();tripMeta={owner:user.id,by:user.id,at:tripAt};W("werf-trip-at",String(tripAt));tripSub();await tripMembersLoad();rerenderPlan();tripShare()}
async function tripJoin(code){if(TRIP?.code===code){try{localStorage.removeItem("werf-join")}catch(_){}go("merkliste");return}
  if(PLAN.days.length&&!confirm(tt("Einer gemeinsamen Reise beitreten? Deine bisherige Planung wird durch die gemeinsame ersetzt.")))  {try{localStorage.removeItem("werf-join")}catch(_){}return}
  const {data,error}=await sb.rpc("join_trip",{c:code});try{localStorage.removeItem("werf-join")}catch(_){}
  if(error||!data){toast(tt("Diese Reise wurde nicht gefunden."));return}
  if(PLAN.days.length)W("werf-plan-solo",JSON.stringify(PLAN));
  TRIP={id:data,code,deleted:[]};saveTrip();await tripPull(true);tripSub();await tripMembersLoad();go("merkliste");toast(tt("Du planst jetzt gemeinsam"))}
async function tripLeave(){if(!confirm(tt("Gemeinsame Reise verlassen? Die Tage bleiben als deine eigene Planung erhalten.")))return;
  await sb.from("trip_members").delete().eq("trip_id",TRIP.id).eq("user_id",user.id);if(tripChan){sb.removeChannel?.(tripChan);tripChan=null}
  TRIP=null;tripMembers=[];saveTrip();rerenderPlan();toast(tt("Du planst wieder allein"))}
/* gelöschte Tage merken, damit sie beim Zusammenführen nicht zurückkommen */
window.tripDayDeleted=id=>{if(TRIP){TRIP.deleted=[...(TRIP.deleted||[]),id];saveTrip()}};
document.getElementById("plan")?.addEventListener("click",ev=>{const b=ev.target.closest("[data-tb]");if(!b)return;const a=b.dataset.tb;
  if(a==="login"){go("konto");setTimeout(()=>window.cloudLoginHint?.(tt("Melde dich an, um deine Reise zu sichern.")),350)}
  if(a==="create")tripCreate();if(a==="share")tripShare();if(a==="leave")tripLeave()});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")tripPull()});
setInterval(()=>{if(TRIP&&user&&view==="merkliste"&&document.visibilityState==="visible")tripPull()},30000);
/* Einladungslink: ?reise=CODE */
try{const m=location.search.match(/[?&]reise=([0-9a-f]{16,64})/i);if(m){W("werf-join",m[1]);history.replaceState(null,"",location.pathname+location.hash)}}catch(_){}
function checkJoin(){const code=S("werf-join");if(!code)return;
  if(!user){go("konto");setTimeout(()=>window.cloudLoginHint?.(tt("Du wurdest zu einer gemeinsamen Reise eingeladen. Melde dich an, um mitzuplanen.")),400);return}
  tripJoin(code)}

/* ---------- Melden und Entfernen ---------- */
window.cloudReport=(kind,ref,estate)=>{mod.hidden=false;document.body.style.overflow="hidden";
  mod.innerHTML=`<div class="modbar"><button data-mclose>${tt("Schließen")}</button><b>${tt("Melden")}</b><span></span></div><h2 class="cond">${tt("Melden")}</h2>
  <div class="wrap ed" style="padding-top:0"><p class="small grey" style="margin-bottom:var(--s2)">${esc(byId[estate]?.name||"")} · ${kind==="photo"?tt("Foto"):tt("Eintrag")}</p>
  <label class="fld"><span class="fl">${tt("Was stimmt nicht?")}</span><textarea id="repText" rows="5" maxlength="1000" placeholder="${tt("Zum Beispiel: falsche Öffnungszeiten, Gut geschlossen, Foto zeigt Personen ohne Einwilligung, kopierter Text")}"></textarea></label>
  <button class="btn accent" id="repSend" style="background:var(--duene);margin-top:var(--s2)">${tt("Senden")}</button><p class="msg" id="repMsg" style="color:var(--duene);margin-top:8px"></p></div>`;
  mod.dataset.report=JSON.stringify({kind:kind==="estate"?"text":kind,ref,estate});setTimeout(()=>mod.querySelector("#repText")?.focus(),100)};
async function sendReport(){const r=JSON.parse(mod.dataset.report||"{}"),reason=mod.querySelector("#repText").value.trim(),m=mod.querySelector("#repMsg");
  if(reason.length<3){m.textContent=tt("Bitte kurz beschreiben, was nicht stimmt.");return}
  const {error}=await sb.from("reports").insert({kind:r.kind,ref:String(r.ref||"").slice(0,300),estate_id:r.estate,reason});
  if(error){m.textContent=tt("Das hat nicht geklappt.");return}
  mod.hidden=true;mod.innerHTML="";document.body.style.overflow="";toast(tt("Danke. Wir sehen uns das an."))}
window.cloudRemovePhoto=async pid=>{const ph=(COMM.p||[]).find(x=>String(x.id)===String(pid));if(!ph)return;
  const {error}=await sb.from("photos").update({status:"rejected",reviewed_by:user.id,reviewed_at:new Date().toISOString()}).eq("id",+pid);
  if(error){toast(tt("Das hat nicht geklappt."));return}await sb.storage.from("fotos").remove([ph.path]);await refreshCommunity();reloadSoon(tt("Foto für alle entfernt"))};
/* Im Eintrag: was die Community geschrieben hat, für Editoren mit „Entfernen“ */
window.cloudCommList=id=>{if(!window.CLOUD.editor)return "";const rows=(COMM.c||[]).filter(r=>r.estate_id===id&&r.id!=null);if(!rows.length)return "";
  return `<div class="commlist"><h3>${tt("Von der Community")}</h3>${rows.slice().reverse().map(r=>`<div class="crow"><div><b>${tt(FLD[r.field]||r.field)} · ${esc(r.lang.toUpperCase())}</b><small>${esc((COMM.names||{})[r.user_id]||tt("Unbekannt"))} · ${new Date(r.created_at).toLocaleDateString(LOC)}</small><p>${esc(show(r.value)).slice(0,220)}</p></div><button class="wlink" data-crm="${r.id}">${tt("Entfernen")}</button></div>`).join("")}</div>`};
document.addEventListener("click",async ev=>{const b=ev.target.closest("[data-crm]");if(!b||!window.CLOUD.editor)return;
  if(!b.classList.contains("arm")){b.classList.add("arm");b.textContent=tt("Wirklich entfernen?");return}
  const {error}=await sb.from("contributions").update({status:"rejected",reviewed_by:user.id,reviewed_at:new Date().toISOString()}).eq("id",+b.dataset.crm);
  if(error){toast(tt("Das hat nicht geklappt."));return}await refreshCommunity();reloadSoon(tt("Beitrag für alle entfernt"))});

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
  const rp=await sb.from("reports").select("*").eq("status","open").order("created_at").limit(100);
  const [c,p,e]=await Promise.all([sb.from("contributions").select("*").eq("status","pending").order("created_at").limit(200),
    sb.from("photos").select("*").eq("status","pending").order("created_at").limit(100),sb.from("estates").select("*").eq("status","pending").order("created_at").limit(100)]);
  const uids=[...new Set([...(c.data||[]),...(p.data||[]),...(e.data||[])].map(x=>x.user_id).filter(Boolean))];let names={};
  if(uids.length){const n=await sb.from("profiles").select("id,name").in("id",uids);(n.data||[]).forEach(x=>names[x.id]=x.name)}
  const who=x=>esc(names[x.user_id]||tt("Unbekannt"))+" · "+new Date(x.created_at).toLocaleDateString(LOC);
  const cards=[];
  (rp.data||[]).forEach(x=>cards.push(`<div class="mcard rep" data-kind="reports" data-id="${x.id}"><h4>${tt("Meldung")}: ${esc(byId[x.estate_id]?.name||x.estate_id||"")} · ${x.kind==="photo"?tt("Foto"):tt("Eintrag")}</h4><p class="meta">${new Date(x.created_at).toLocaleDateString(LOC)}</p><p class="new">${esc(x.reason)}</p><div class="acts">${byId[x.estate_id]?`<button class="btn line" data-ropen="${esc(x.estate_id)}">${tt("Gut öffnen")}</button>`:""}<button class="btn" data-ok>${tt("Erledigt")}</button></div></div>`));
  (e.data||[]).forEach(x=>cards.push(`<div class="mcard" data-kind="estates" data-id="${esc(x.id)}"><h4>${tt("Neues Gut")}: ${esc(x.name)}</h4><p class="meta">${who(x)}</p><p class="new">${esc(x.town||"")} ${x.web?"· "+esc(x.web):""} ${x.lat!=null?"· "+x.lat.toFixed(4)+", "+x.lng.toFixed(4):""}</p><div class="acts"><button class="btn" data-ok>${tt("Freigeben")}</button><button class="btn line" data-no>${tt("Ablehnen")}</button></div></div>`));
  (c.data||[]).forEach(x=>{const est=byId[x.estate_id];const old=est?(x.field==="abschnitte"?(est._orig?.abschnitte||est.abschnitte?.map(a=>a.p)||[]):(est._orig&&x.field in est._orig?est._orig[x.field]:est[x.field])):"";
    cards.push(`<div class="mcard" data-kind="contributions" data-id="${x.id}"><h4>${esc(est?.name||x.estate_id)} · ${tt(FLD[x.field]||x.field)} · ${esc(x.lang.toUpperCase())}</h4><p class="meta">${who(x)}</p>${show(old)?`<p class="old">${esc(show(old))}</p>`:""}<p class="new">${esc(show(x.value))}</p><div class="acts"><button class="btn" data-ok>${tt("Freigeben")}</button><button class="btn line" data-no>${tt("Ablehnen")}</button></div></div>`)});
  (p.data||[]).forEach(x=>cards.push(`<div class="mcard" data-kind="photos" data-id="${x.id}" data-path="${esc(x.path)}"><h4>${tt("Foto")}: ${esc(byId[x.estate_id]?.name||x.estate_id)}</h4><p class="meta">${who(x)}</p><img src="${CFG.url}/storage/v1/object/public/fotos/${encodeURI(x.path)}" alt=""><div class="acts"><button class="btn" data-ok>${tt("Freigeben")}</button><button class="btn line" data-no>${tt("Ablehnen")}</button></div></div>`));
  mod.querySelector("p.wrap").outerHTML=cards.length?cards.join(""):`<p class="wrap empty">${tt("Nichts zu prüfen. Alles erledigt.")}</p>`}
mod?.addEventListener("click",async ev=>{const t=ev.target;
  if(t.closest("[data-mclose]")){mod.hidden=true;mod.innerHTML="";document.body.style.overflow="";await loadStats();render();return}
  if(t.id==="nSend"){sendNew();return}
  if(t.id==="repSend"){sendReport();return}
  const ro=t.closest("[data-ropen]");if(ro){mod.hidden=true;mod.innerHTML="";document.body.style.overflow="";openEstate(ro.dataset.ropen);return}
  const card=t.closest(".mcard");if(!card||!(t.closest("[data-ok]")||t.closest("[data-no]")))return;
  const ok=!!t.closest("[data-ok]"),kind=card.dataset.kind,id=card.dataset.id;t.disabled=true;
  const upd={status:kind==="reports"?"done":ok?"approved":"rejected"};if(kind!=="estates"&&kind!=="reports"){upd.reviewed_by=user.id;upd.reviewed_at=new Date().toISOString()}
  const {error}=await sb.from(kind).update(upd).eq("id",kind==="estates"?id:+id);if(!error&&kind==="reports"){card.remove();await loadStats();return}
  if(error){t.disabled=false;toast(tt("Das hat nicht geklappt."));return}
  if(!ok&&kind==="photos")await sb.storage.from("fotos").remove([card.dataset.path]);
  card.animate([{opacity:1,transform:"none"},{opacity:0,transform:"translateX("+(ok?"":"-")+"60px)"}],{duration:260,easing:"ease-in"}).onfinish=()=>card.remove();
  refreshCommunity()});

init();
})();
