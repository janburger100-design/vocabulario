import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, onSnapshot, setDoc, deleteDoc, getDocFromServer, writeBatch, deleteField } from "firebase/firestore";
import BASE from "./vocab.json";
import SEED from "./seed.json";

/* ===================== Datenhaltung ===================== */
const NEW_PER_SESSION = 20;
const LS_KEY = "vocabulario_v2";
const LS_MODE = "vocabulario_mode";
const BUCKETS = 20;
const S = {
  mode:"loading",            // loading | login | cloud | local
  uid:null, email:"", fs:null, auth:null, unsubs:[],
  base:new Map(), custom:new Map(), vocab:new Map(), prog:new Map(),
  meta:{dir:"de_es", streak:0, lastDay:null},
  progReady:false, customReady:false, metaReady:false,
  pending:false, online: navigator.onLine, authError:"", authBusy:false
};
BASE.forEach(function(r){ S.base.set(r[0], { id:r[0], es:r[1], de:r[2], ex_es:r[3]||"", ex_de:r[4]||"", cat:"", created:1790000000000+parseInt(r[0].slice(1),10) }); });

function today(){ const d=new Date(); return iso(d); }
function iso(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function addDays(s,n){ const d=new Date(s+"T12:00:00"); d.setDate(d.getDate()+n); return iso(d); }

function cleanWord(id, d){
  return { id:id, es:String(d.es||""), de:String(d.de||""), ex_es:String(d.ex_es||""), ex_de:String(d.ex_de||""), cat:String(d.cat||""), created:Number(d.created)||0 };
}
function bodyOf(w){ return { es:w.es, de:w.de, ex_es:w.ex_es||"", ex_de:w.ex_de||"", cat:w.cat||"", created:w.created||Date.now() }; }
function rebuildVocab(){
  const m=new Map();
  S.base.forEach(function(w,id){ const c=S.custom.get(id); if (c && c.del) return; m.set(id, c ? cleanWord(id,c) : w); });
  S.custom.forEach(function(c,id){ if (!c.del && !S.base.has(id)) m.set(id, cleanWord(id,c)); });
  S.vocab=m;
}
function bucketOf(id){ let h=0; for (let i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0; return "b"+String(h%BUCKETS).padStart(2,"0"); }

/* ---- Firebase ---- */
const CONFIG = (typeof window!=="undefined" && window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey) ? window.FIREBASE_CONFIG : null;
function userDoc(){ return doc(S.fs,"users",S.uid); }
function progRef(b){ return doc(S.fs,"users",S.uid,"prog",b); }
function metaRef(){ return doc(S.fs,"users",S.uid,"state","meta"); }
function customRef(id){ return doc(S.fs,"users",S.uid,"custom",id); }

function fsErr(e){
  console.warn(e);
  if (e && e.code==="permission-denied") toast("Speichern abgelehnt. Bitte neu anmelden.");
}

/* ---- Lokal ---- */
let localTimer=null;
function saveLocal(){
  clearTimeout(localTimer);
  localTimer=setTimeout(function(){
    try{ localStorage.setItem(LS_KEY, JSON.stringify({custom:Object.fromEntries(S.custom), prog:Object.fromEntries(S.prog), meta:S.meta})); }catch(e){}
  },250);
}
function loadLocal(){
  let raw=null;
  try{ raw=JSON.parse(localStorage.getItem(LS_KEY)||"null"); }catch(e){}
  if (!raw) raw={custom:SEED.custom, prog:SEED.prog, meta:SEED.meta};
  S.custom=new Map(Object.entries(raw.custom||{}));
  S.prog=new Map(Object.entries(raw.prog||{}));
  S.meta=Object.assign({dir:"de_es",streak:0,lastDay:null}, raw.meta||{});
  rebuildVocab(); S.progReady=S.customReady=S.metaReady=true;
  saveLocal();
}

/* ---- Schreiben (gleiche API für beide Modi) ---- */
function saveProg(id){
  if (S.mode==="cloud"){
    const p=S.prog.get(id); const patch={w:{}}; patch.w[id]= p ? Object.assign({},p) : deleteField();
    setDoc(progRef(bucketOf(id)), patch, {merge:true}).catch(fsErr);
  } else saveLocal();
}
function saveMeta(){
  if (S.mode==="cloud") setDoc(metaRef(), Object.assign({},S.meta), {merge:true}).catch(fsErr);
  else saveLocal();
}
function saveWord(w){
  const b=bodyOf(w); S.custom.set(w.id, b); rebuildVocab();
  if (S.mode==="cloud") setDoc(customRef(w.id), b).catch(fsErr); else saveLocal();
  return Promise.resolve();
}
function deleteWord(id){
  const had=S.prog.has(id); S.prog.delete(id);
  if (S.base.has(id)){
    S.custom.set(id,{del:true}); rebuildVocab();
    if (S.mode==="cloud") setDoc(customRef(id), {del:true}).catch(fsErr);
  } else {
    S.custom.delete(id); rebuildVocab();
    if (S.mode==="cloud") deleteDoc(customRef(id)).catch(fsErr);
  }
  if (had) saveProg(id);
  if (S.mode!=="cloud") saveLocal();
  return Promise.resolve();
}

/* ---- Start / Anmeldung ---- */
function stopListeners(){ S.unsubs.forEach(function(u){ try{u();}catch(e){} }); S.unsubs=[]; }

function startCloud(user){
  stopListeners();
  S.mode="cloud"; S.uid=user.uid; S.email=user.email||"";
  S.progReady=S.customReady=S.metaReady=false;
  S.prog=new Map(); S.custom=new Map(); rebuildVocab();
  render();
  S.unsubs.push(onSnapshot(collection(S.fs,"users",S.uid,"prog"), {includeMetadataChanges:true}, function(snap){
    const m=new Map();
    snap.docs.forEach(function(d){ const w=(d.data()||{}).w||{}; Object.keys(w).forEach(function(id){ if (w[id]) m.set(id, Object.assign({},w[id])); }); });
    S.prog=m; S.progReady=true; S.pending=snap.metadata.hasPendingWrites; softRender();
  }, function(e){ fsErr(e); S.progReady=true; softRender(); }));
  S.unsubs.push(onSnapshot(collection(S.fs,"users",S.uid,"custom"), function(snap){
    const m=new Map(); snap.docs.forEach(function(d){ m.set(d.id, Object.assign({},d.data())); });
    S.custom=m; rebuildVocab(); S.customReady=true; softRender();
  }, function(e){ fsErr(e); S.customReady=true; softRender(); }));
  S.unsubs.push(onSnapshot(metaRef(), function(snap){
    if (snap.exists()) S.meta=Object.assign({dir:"de_es",streak:0,lastDay:null}, snap.data());
    S.metaReady=true; softRender();
  }, function(e){ fsErr(e); S.metaReady=true; softRender(); }));
  maybeSeed();
}

// Einmalig: Lernstand aus der alten Claude-Version übernehmen, wenn das Konto noch leer ist.
async function maybeSeed(){
  try{
    const snap=await getDocFromServer(metaRef());
    if (snap.exists()) return;
    const batch=writeBatch(S.fs);
    const buckets={};
    Object.keys(SEED.prog||{}).forEach(function(id){ const b=bucketOf(id); (buckets[b]=buckets[b]||{})[id]=SEED.prog[id]; });
    Object.keys(buckets).forEach(function(b){ batch.set(progRef(b), {w:buckets[b]}, {merge:true}); });
    Object.keys(SEED.custom||{}).forEach(function(id){ batch.set(customRef(id), SEED.custom[id]); });
    batch.set(metaRef(), Object.assign({dir:"de_es",streak:0,lastDay:null}, SEED.meta||{}, {created:Date.now()}), {merge:true});
    await batch.commit();
  }catch(e){ /* offline oder schon vorhanden: später erneut beim nächsten Start */ }
}

function startLocal(){
  stopListeners();
  S.mode="local"; S.uid=null; S.email="";
  try{ localStorage.setItem(LS_MODE,"local"); }catch(e){}
  loadLocal(); go("dash");
}

function boot(){
  window.addEventListener("online", function(){ S.online=true; softRender(); });
  window.addEventListener("offline", function(){ S.online=false; softRender(); });
  let preferLocal=false; try{ preferLocal = localStorage.getItem(LS_MODE)==="local"; }catch(e){}
  if (!CONFIG){ startLocal(); return; }
  const fbApp=initializeApp(CONFIG);
  S.auth=getAuth(fbApp);
  S.fs=initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  if (preferLocal){ startLocal(); }
  else render();
  onAuthStateChanged(S.auth, function(user){
    if (user){ try{ localStorage.removeItem(LS_MODE); }catch(e){} startCloud(user); go("dash"); }
    else if (S.mode!=="local"){ stopListeners(); S.mode="login"; go("login"); }
  });
}

async function doLogin(kind, email, pass){
  S.authError=""; S.authBusy=true; render();
  try{
    if (kind==="signup") await createUserWithEmailAndPassword(S.auth, email, pass);
    else await signInWithEmailAndPassword(S.auth, email, pass);
  }catch(e){
    const c=(e&&e.code)||"";
    S.authError = c.indexOf("invalid-credential")>=0||c.indexOf("wrong-password")>=0||c.indexOf("user-not-found")>=0 ? "E-Mail oder Passwort stimmt nicht."
      : c.indexOf("email-already-in-use")>=0 ? "Für diese E-Mail gibt es schon ein Konto. Melde dich an."
      : c.indexOf("weak-password")>=0 ? "Das Passwort braucht mindestens 6 Zeichen."
      : c.indexOf("invalid-email")>=0 ? "Die E-Mail-Adresse ist ungültig."
      : c.indexOf("network")>=0 ? "Keine Internetverbindung. Für die erste Anmeldung brauchst du Internet."
      : c.indexOf("operation-not-allowed")>=0 ? "E-Mail-Anmeldung ist im Firebase-Projekt noch nicht aktiviert."
      : "Anmeldung fehlgeschlagen ("+c+").";
  }
  S.authBusy=false; if (S.mode==="login") render();
}
async function doReset(email){
  if (!email){ S.authError="Gib zuerst deine E-Mail ein."; render(); return; }
  try{ await sendPasswordResetEmail(S.auth, email); toast("E-Mail zum Zurücksetzen verschickt"); }
  catch(e){ S.authError="Konnte keine E-Mail senden. Stimmt die Adresse?"; render(); }
}
async function doLogout(){
  stopListeners();
  try{ await signOut(S.auth); }catch(e){}
  S.mode="login"; go("login");
}

/* ===================== Lernlogik ===================== */
function isNew(p){ return !p || !p.last; }
function isLearned(p){ return !!p && !!p.last && (p.int||0) >= 21; }
function isDue(p, t){ return !isNew(p) && p.due <= t; }

function schedule(id, grade){
  const t=today();
  const p=Object.assign({ef:2.5,int:0,reps:0,due:t,flag:false,last:null}, S.prog.get(id)||{});
  if (grade==="hard"){ p.reps=0; p.int=0; p.due=t; p.ef=Math.max(1.3,p.ef-0.2); }
  else if (grade==="normal"){
    p.int = p.reps===0 ? 1 : p.reps===1 ? 3 : Math.max(p.int+1, Math.round(p.int*p.ef));
    p.reps+=1; p.due=addDays(t,p.int);
  } else {
    p.int = p.reps===0 ? 3 : p.reps===1 ? 7 : Math.max(p.int+2, Math.round(p.int*p.ef*1.3));
    p.reps+=1; p.ef=Math.min(3.0,p.ef+0.15); p.due=addDays(t,p.int);
  }
  p.last=t;
  S.prog.set(id,p); saveProg(id);
  if (S.meta.lastDay!==t){
    S.meta.streak = (S.meta.lastDay===addDays(t,-1)) ? (S.meta.streak||0)+1 : 1;
    S.meta.lastDay=t; saveMeta();
  }
}
function toggleFlag(id){
  const p=Object.assign({ef:2.5,int:0,reps:0,due:today(),flag:false,last:null}, S.prog.get(id)||{});
  p.flag=!p.flag; S.prog.set(id,p); saveProg(id); return p.flag;
}
function streakNow(){ const t=today(); return (S.meta.lastDay===t || S.meta.lastDay===addDays(t,-1)) ? (S.meta.streak||0) : 0; }

function stats(){
  const t=today(); let due=0,nw=0,learn=0,ok=0,flag=0,todayN=0;
  S.vocab.forEach(function(w){ const p=S.prog.get(w.id);
    if (isNew(p)) nw++; else if (isLearned(p)) ok++; else learn++;
    if (isDue(p,t)) due++;
    if (p && p.flag) flag++;
    if (p && p.last===t) todayN++;
  });
  return {total:S.vocab.size, due:due, nw:nw, learn:learn, ok:ok, flag:flag, todayN:todayN, startable: due + Math.min(nw,NEW_PER_SESSION)};
}

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* ===================== Sitzung ===================== */
let session=null;
function startSession(kind){
  const t=today(); const all=[...S.vocab.values()]; let q=[];
  if (kind==="flag"){ q=shuffle(all.filter(function(w){ const p=S.prog.get(w.id); return p&&p.flag; }).map(function(w){return w.id;})); }
  else {
    const due=shuffle(all.filter(function(w){ return isDue(S.prog.get(w.id),t); }).map(function(w){return w.id;}));
    const nw=all.filter(function(w){ return isNew(S.prog.get(w.id)); }).sort(function(a,b){ return a.created-b.created; }).slice(0,NEW_PER_SESSION).map(function(w){return w.id;});
    q=due.concat(shuffle(nw));
    if (!q.length) q=shuffle(all.map(function(w){return w.id;})).slice(0,20);
  }
  if (!q.length){ toast(kind==="flag" ? "Du hast noch keine Vokabeln markiert." : "Noch keine Vokabeln vorhanden."); return; }
  session={ kind:kind, queue:q, idx:0, total:q.length, flipped:false, hint:false, res:{easy:0,normal:0,hard:0}, busy:false, history:[] };
  go("study");
}
function curId(){ return session && session.queue[session.idx]; }
function grade(g){
  if (!session || session.busy) return;
  const id=curId(); if (!id) return;
  const prev=S.prog.get(id);
  session.history.push({ id:id, g:g, prog: prev ? Object.assign({},prev) : null, meta:Object.assign({},S.meta), queue:session.queue.slice(), idx:session.idx });
  if (session.history.length>50) session.history.shift();
  schedule(id,g); session.res[g]++;
  if (g==="hard"){ const pos=Math.min(session.queue.length, session.idx+4); session.queue.splice(pos,0,id); }
  session.idx++;
  if (session.idx>=session.queue.length){ go("done"); return; }
  session.flipped=false; session.hint=false; paintCard(true);
}

function undo(){
  if (!session || session.busy || !session.history.length) return;
  const h=session.history.pop();
  const cur=S.prog.get(h.id);
  if (h.prog){ const p=Object.assign({},h.prog); if (cur) p.flag=!!cur.flag; S.prog.set(h.id,p); }
  else if (cur && cur.flag){ S.prog.set(h.id,{ef:2.5,int:0,reps:0,due:today(),flag:true,last:null}); }
  else S.prog.delete(h.id);
  saveProg(h.id);
  if (S.meta.lastDay!==h.meta.lastDay || S.meta.streak!==h.meta.streak){ S.meta.lastDay=h.meta.lastDay; S.meta.streak=h.meta.streak; saveMeta(); }
  session.queue=h.queue; session.idx=h.idx; session.res[h.g]=Math.max(0,session.res[h.g]-1);
  session.flipped=true; session.hint=false;
  if (screen!=="study"){ screen="study"; renderStudy(); } else paintCard(true);
  toast("Letzte Bewertung zurückgenommen");
}

/* ===================== Rendering ===================== */
const app=document.getElementById("app");
let screen="dash", listState={filter:"all", q:""}, editId=null, addTab="single";
function go(s){ screen=s; render(); window.scrollTo(0,0); }
function softRender(){ if (screen==="login") return; if (screen==="study") { if (session && !S.vocab.has(curId())) paintCard(true); return; } if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) { if (screen==="list") paintRows(); return; } render(); }
function h(s){ return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
function toast(msg){ const el=document.getElementById("toast"); el.textContent=msg; el.classList.add("show"); clearTimeout(toast.t); toast.t=setTimeout(function(){el.classList.remove("show");},2400); }

function render(){
  if (screen==="dash") renderDash();
  else if (screen==="study") renderStudy();
  else if (screen==="done") renderDone();
  else if (screen==="list") renderList();
  else if (screen==="add") renderAdd();
  else if (screen==="edit") renderEdit();
  else if (screen==="login") renderLogin();
}

function renderDash(){
  const loading = S.mode==="loading" || !(S.progReady && S.customReady && S.metaReady);
  const st=stats(); const total=st.total||1;
  let cta;
  if (loading) cta='<button class="cta" disabled>Lädt …</button>';
  else if (!st.total) cta='<button class="cta" data-act="add">Erste Vokabeln hinzufügen</button>';
  else if (st.startable) cta='<button class="cta" data-act="learn">Jetzt lernen · '+st.startable+'</button>';
  else cta='<button class="cta idle" data-act="learn">Alles erledigt · frei üben</button>';
  app.innerHTML =
  '<section class="screen">'+
    '<header class="top"><div class="brand"><span class="mark">ñ</span><b>Vocabulario</b></div>'+
    '<button class="icon-btn" data-act="add" aria-label="Vokabeln hinzufügen">+</button></header>'+
    statusBanner()+
    '<div class="tiles">'+
      '<div class="tile due"><span class="v">'+(loading?"–":st.due)+'</span><span class="l">Fällig</span></div>'+
      '<div class="tile"><span class="v">'+(loading?"–":Math.min(st.nw,NEW_PER_SESSION))+'</span><span class="l">Neu</span></div>'+
      '<div class="tile streak"><span class="v">'+(loading?"–":streakNow())+'</span><span class="l">Tage Serie</span></div>'+
    '</div>'+
    '<div class="progress"><div class="head"><span>Fortschritt</span><span>'+st.ok+' von '+st.total+' sicher</span></div>'+
      '<div class="bar"><i style="width:'+(st.ok/total*100)+'%;background:var(--easy)"></i><i style="width:'+(st.learn/total*100)+'%;background:var(--normal)"></i></div>'+
      '<div class="legend"><span style="--c:var(--easy)">Sicher '+st.ok+'</span><span style="--c:var(--normal)">Im Lernen '+st.learn+'</span><span style="--c:var(--surface-2)">Neu '+st.nw+'</span></div></div>'+
    cta+
    '<div class="links">'+
      '<button class="link" data-act="list-all"><b>Alle Vokabeln</b><small>'+st.total+' Wörter</small></button>'+
      '<button class="link" data-act="list-flag"><b>★ Markiert</b><small>'+st.flag+' Wörter ansehen</small></button>'+
      '<button class="link" data-act="learn-flag"><b>Markierte lernen</b><small>Nur Sternchen-Wörter</small></button>'+
      '<button class="link" data-act="add"><b>Hinzufügen</b><small>Einzeln oder als Liste</small></button>'+
    '</div>'+
    '<p class="foot">Heute gelernt: '+st.todayN+'<br><kbd>Leertaste</kbd> umdrehen · <kbd>→</kbd> einfach · <kbd>←</kbd> schwer · <kbd>H</kbd> Tipp · <kbd>S</kbd> Stern · <kbd>D</kbd> löschen · <kbd>Z</kbd> zurück</p>'+
    accountLine()+
  '</section>';
}

function renderStudy(){
  const dir=S.meta.dir||"de_es";
  app.innerHTML =
  '<section class="screen">'+
    '<header class="top"><button class="icon-btn" data-act="home" aria-label="Zurück">←</button>'+
      '<div class="mid"><span class="counter" id="counter"></span><button class="delbtn" data-act="del-ask" aria-label="Vokabel löschen">Löschen · D</button></div>'+
      '<button class="pill" data-act="dir" aria-label="Lernrichtung umschalten">'+(dir==="de_es"?"DE → ES":"ES → DE")+'</button></header>'+
    '<div class="sbar"><i id="sbar"></i></div>'+
    '<div class="stage" id="stage">'+
      '<div class="card" id="card">'+
        '<button class="star" id="star" aria-label="Markieren">☆</button>'+
        '<span class="tag easy" id="tagE">Einfach</span><span class="tag hard" id="tagH">Schwer</span>'+
        '<div class="flip">'+
          '<div class="face front"><span class="lang" id="langF"></span><span class="word" id="front"></span><span class="hint" id="hint"></span><span class="tapnote">Tippen zum Umdrehen</span></div>'+
          '<div class="face back"><span class="lang" id="langB"></span><span class="cat" id="cat"></span><span class="word" id="back"></span><div class="ex"><p class="es" id="exes"></p><p class="de" id="exde"></p></div></div>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div class="tools"><button class="tool" id="undoBtn" data-act="undo" aria-label="Letzte Bewertung zurücknehmen">↶ Zurück</button><button class="tool" id="hintBtn" data-act="hint">Tipp · erster Buchstabe</button></div>'+
    '<div class="grades waiting" id="grades">'+
      '<button class="g hard" data-grade="hard">Schwer<small>nach rechts wischen</small></button>'+
      '<button class="g normal" data-grade="normal">Normal<small>nur Button</small></button>'+
      '<button class="g easy" data-grade="easy">Einfach<small>nach links wischen</small></button>'+
    '</div>'+
    '<p class="help" id="help">Erst umdrehen oder direkt bewerten</p>'+
  '</section>';
  bindCard(); paintCard(true);
}

function stripArticle(s){
  const m=String(s).match(/^(el|la|los|las|un|una|unos|unas|der|die|das|ein|eine)\s+(.+)$/i);
  return m ? {art:m[1]+" ", rest:m[2]} : {art:"", rest:String(s)};
}
function paintCard(instant){
  const id=curId(); const w=S.vocab.get(id);
  const card=document.getElementById("card"); if (!card) return;
  if (!w){ // Wort wurde gelöscht
    session.queue.splice(session.idx,1);
    if (session.idx>=session.queue.length){ go("done"); return; }
    return paintCard(true);
  }
  const p=S.prog.get(id)||{}; const dir=S.meta.dir||"de_es";
  const front = dir==="de_es" ? w.de : w.es, back = dir==="de_es" ? w.es : w.de;
  card.classList.toggle("instant", !!instant);
  card.classList.toggle("flipped", session.flipped);
  card.style.transform=""; card.classList.remove("snap");
  document.getElementById("tagE").style.opacity=0; document.getElementById("tagH").style.opacity=0;
  document.getElementById("langF").textContent = dir==="de_es" ? "Deutsch" : "Español";
  document.getElementById("langB").textContent = dir==="de_es" ? "Español" : "Deutsch";
  document.getElementById("front").textContent=front;
  document.getElementById("back").textContent=back;
  const catEl=document.getElementById("cat"); catEl.textContent=w.cat||""; catEl.hidden=!w.cat;
  const exBox=document.querySelector(".ex"); exBox.hidden=!(w.ex_es||w.ex_de);
  document.getElementById("exes").textContent=w.ex_es||"";
  document.getElementById("exde").textContent=w.ex_de||"";
  const a=stripArticle(back);
  document.getElementById("hint").textContent = session.hint ? (a.art + (a.rest.match(/^[^A-Za-zÀ-ÿ0-9]*./)||[a.rest.charAt(0)])[0] + " …") : "";
  const star=document.getElementById("star"); star.classList.toggle("on",!!p.flag); star.textContent=p.flag?"★":"☆";
  document.getElementById("hintBtn").disabled = session.hint || session.flipped;
  document.getElementById("undoBtn").disabled = !session.history.length;
  document.getElementById("grades").classList.toggle("waiting", !session.flipped);
  document.getElementById("help").textContent = session.flipped ? "Wie gut wusstest du es?" : "Erst umdrehen oder direkt bewerten";
  document.getElementById("counter").textContent = Math.min(session.idx+1, session.queue.length) + " / " + session.queue.length;
  document.getElementById("sbar").style.width = (session.idx/session.queue.length*100)+"%";
  if (instant) requestAnimationFrame(function(){ requestAnimationFrame(function(){ card.classList.remove("instant"); }); });
}
function flip(){ if (!session) return; session.flipped=!session.flipped; paintCard(false); }
function showHint(){ if (!session || session.flipped || session.hint) return; session.hint=true; paintCard(false); }

function fly(g){
  if (!session || session.busy) return;
  const card=document.getElementById("card"); if(!card){ grade(g); return; }
  session.busy=true;
  card.classList.add("snap");
  const x = g==="easy" ? -window.innerWidth : window.innerWidth;
  card.style.transform="translateX("+x+"px) rotate("+(g==="easy"?-18:18)+"deg)";
  document.getElementById(g==="easy"?"tagE":"tagH").style.opacity=1;
  setTimeout(function(){ session.busy=false; grade(g); }, 200);
}

function bindCard(){
  const card=document.getElementById("card"); let d=null;
  card.addEventListener("pointerdown",function(e){
    if (e.target.closest(".star") || session.busy) return;
    d={x:e.clientX,y:e.clientY,dx:0,moved:false,pid:e.pointerId};
    card.classList.remove("snap");
    try{card.setPointerCapture(e.pointerId);}catch(_){}
  });
  card.addEventListener("pointermove",function(e){
    if(!d) return;
    d.dx=e.clientX-d.x; const dy=e.clientY-d.y;
    if (Math.abs(d.dx)>8||Math.abs(dy)>8) d.moved=true;
    if (!d.moved) return;
    card.style.transform="translateX("+d.dx+"px) rotate("+(d.dx/22)+"deg)";
    const k=Math.min(1,Math.abs(d.dx)/110);
    document.getElementById("tagE").style.opacity = d.dx<0 ? k : 0;
    document.getElementById("tagH").style.opacity = d.dx>0 ? k : 0;
  });
  function end(){
    if(!d) return; const s=d; d=null;
    if (!s.moved){ flip(); return; }
    if (s.dx < -100) return fly("easy");   // Finger rechts → links = einfach
    if (s.dx > 100) return fly("hard");    // Finger links → rechts = schwer
    card.classList.add("snap"); card.style.transform="";
    document.getElementById("tagE").style.opacity=0; document.getElementById("tagH").style.opacity=0;
  }
  card.addEventListener("pointerup",end); card.addEventListener("pointercancel",end);
  document.getElementById("star").addEventListener("click",function(e){ e.stopPropagation(); doStar(); });
}
function doStar(){ const id=curId(); if(!id) return; const on=toggleFlag(id); const s=document.getElementById("star"); s.classList.toggle("on",on); s.textContent=on?"★":"☆"; toast(on?"Markiert":"Markierung entfernt"); }

function askDelete(){
  if (!session || session.busy || document.getElementById("confirm")) return;
  const id=curId(); const w=S.vocab.get(id); if(!w) return;
  const el=document.createElement("div"); el.className="confirm"; el.id="confirm";
  el.innerHTML='<div class="confirm-box" role="dialog" aria-modal="true"><h3>Vokabel löschen?</h3><p></p>'+
    '<div class="confirm-row"><button class="c-no" id="c-no">Nein<small>Esc</small></button><button class="c-yes" id="c-yes">Ja, löschen<small>Enter</small></button></div></div>';
  el.querySelector("p").textContent = w.es+" · "+w.de+" wird dauerhaft entfernt, auch dein Lernstand dazu.";
  document.body.appendChild(el);
  el.addEventListener("click",function(e){ if(e.target===el) closeDelete(); });
  document.getElementById("c-no").addEventListener("click",closeDelete);
  document.getElementById("c-yes").addEventListener("click",confirmDelete);
  document.getElementById("c-yes").focus();
}
function closeDelete(){ const el=document.getElementById("confirm"); if(el) el.remove(); }
function confirmDelete(){
  closeDelete(); if(!session) return;
  const id=curId(); const w=S.vocab.get(id);
  deleteWord(id);
  session.queue=session.queue.filter(function(x,i){ return i<session.idx || x!==id; });
  toast((w?"„"+w.es+"“ ":"")+"gelöscht");
  if (session.idx>=session.queue.length){ go("done"); return; }
  session.flipped=false; session.hint=false; paintCard(true);
}

document.addEventListener("keydown",function(e){
  if (screen==="done" && session && (e.key==="z"||e.key==="Z") && !e.metaKey && !e.ctrlKey){ e.preventDefault(); undo(); return; }
  if (screen!=="study" || !session) return;
  if (e.metaKey||e.ctrlKey||e.altKey) return;
  if (document.getElementById("confirm")){
    if (e.key==="Enter"){ e.preventDefault(); confirmDelete(); }
    else if (e.key==="Escape"){ e.preventDefault(); closeDelete(); }
    return;
  }
  if (e.key==="d"||e.key==="D"){ e.preventDefault(); askDelete(); return; }
  if (e.key===" "||e.key==="Enter"){ e.preventDefault(); flip(); }
  else if (e.key==="ArrowRight"){ e.preventDefault(); fly("easy"); }
  else if (e.key==="ArrowLeft"){ e.preventDefault(); fly("hard"); }
  else if (e.key==="h"||e.key==="H"){ showHint(); }
  else if (e.key==="z"||e.key==="Z"||e.key==="Backspace"){ e.preventDefault(); undo(); }
  else if (e.key==="s"||e.key==="S"){ doStar(); }
  else if (e.key==="Escape"){ go("dash"); }
});

function renderDone(){
  const r=session?session.res:{easy:0,normal:0,hard:0}; const n=r.easy+r.normal+r.hard;
  app.innerHTML='<section class="screen"><div class="done">'+
    '<span class="mark" style="width:54px;height:54px;font-size:30px;border-radius:15px">ñ</span>'+
    '<h2>¡Muy bien!</h2><p style="margin:0;color:var(--muted)">'+n+' Bewertungen in dieser Runde</p>'+
    '<div class="sum"><span class="chip" style="background:var(--easy-soft);color:var(--easy)">Einfach '+r.easy+'</span><span class="chip" style="background:var(--normal-soft);color:var(--normal)">Normal '+r.normal+'</span><span class="chip" style="background:var(--hard-soft);color:var(--hard)">Schwer '+r.hard+'</span></div>'+
    '<button class="cta" data-act="home" style="width:100%;max-width:340px">Zum Dashboard</button>'+
    (session && session.history.length ? '<button class="tool" data-act="undo">↶ Letzte Bewertung zurücknehmen</button>' : '')+
  '</div></section>';
}

function statusOf(p){
  if (isNew(p)) return '<span class="st new">Neu</span>';
  if (isLearned(p)) return '<span class="st ok">Sicher</span>';
  const t=today(); const lbl = p.due<=t ? "Fällig" : "in "+Math.round((new Date(p.due+"T12:00:00")-new Date(t+"T12:00:00"))/864e5)+" T.";
  return '<span class="st learn">'+lbl+'</span>';
}
function renderList(){
  app.innerHTML='<section class="screen">'+
    '<header class="top"><button class="icon-btn" data-act="home" aria-label="Zurück">←</button><h1 class="page">'+(listState.filter==="flag"?"Markierte Vokabeln":"Alle Vokabeln")+'</h1><button class="icon-btn" data-act="add" aria-label="Hinzufügen">+</button></header>'+
    '<input id="search" class="search" type="search" placeholder="Spanisch oder Deutsch suchen" value="'+h(listState.q)+'">'+
    '<div class="tabs">'+
      ['all','flag','learn','ok','new'].map(function(f){ return '<button class="tab'+(listState.filter===f?' on':'')+'" data-filter="'+f+'">'+({all:"Alle",flag:"★ Markiert",learn:"Im Lernen",ok:"Sicher",new:"Neu"})[f]+'</button>'; }).join("")+
    '</div><div class="rows" id="rows"></div></section>';
  document.getElementById("search").addEventListener("input",function(e){ listState.q=e.target.value; paintRows(); });
  paintRows();
}
function paintRows(){
  const box=document.getElementById("rows"); if(!box) return;
  const q=listState.q.trim().toLowerCase(); const f=listState.filter;
  const items=[...S.vocab.values()].filter(function(w){
    const p=S.prog.get(w.id);
    if (f==="flag" && !(p&&p.flag)) return false;
    if (f==="new" && !isNew(p)) return false;
    if (f==="ok" && !isLearned(p)) return false;
    if (f==="learn" && (isNew(p)||isLearned(p))) return false;
    if (q && w.es.toLowerCase().indexOf(q)<0 && w.de.toLowerCase().indexOf(q)<0) return false;
    return true;
  }).sort(function(a,b){ return a.es.localeCompare(b.es,"es"); });
  if (!items.length){
    box.innerHTML='<p class="empty">'+(S.vocab.size? (f==="flag"?"Noch nichts markiert. Tippe beim Lernen auf den Stern.":"Keine Treffer.") : "Noch keine Vokabeln. Über + kannst du einzelne Wörter oder eine ganze Liste einfügen.")+'</p>';
    return;
  }
  box.innerHTML=items.map(function(w){ const p=S.prog.get(w.id); const on=p&&p.flag;
    return '<div class="row"><div class="main" data-edit="'+h(w.id)+'"><div class="es">'+h(w.es)+'</div><div class="de">'+h(w.de)+'</div></div>'+statusOf(p)+
      '<button class="rowstar'+(on?' on':'')+'" data-star="'+h(w.id)+'" aria-label="Markieren">'+(on?"★":"☆")+'</button></div>';
  }).join("");
}

function renderAdd(){
  app.innerHTML='<section class="screen">'+
    '<header class="top"><button class="icon-btn" data-act="home" aria-label="Zurück">←</button><h1 class="page">Vokabeln hinzufügen</h1></header>'+
    '<div class="tabs"><button class="tab'+(addTab==="single"?" on":"")+'" data-addtab="single">Einzeln</button><button class="tab'+(addTab==="bulk"?" on":"")+'" data-addtab="bulk">Liste einfügen</button></div>'+
    (addTab==="single" ? wordForm({}) :
    '<form class="form" id="bulkForm"><div class="field"><label for="bulk">Eine Vokabel pro Zeile</label><textarea id="bulk" placeholder="la casa - das Haus&#10;el coche - das Auto - Voy en coche. - Ich fahre mit dem Auto."></textarea></div>'+
    '<div class="note">Reihenfolge: <code>Spanisch - Deutsch</code>, optional danach <code>- Beispiel ES - Beispiel DE</code>. Trennen kannst du mit <code> - </code>, Tab oder <code>;</code>. Doppelte Wörter werden übersprungen.</div>'+
    '<button class="cta" type="submit">Liste importieren</button></form>')+
  '</section>';
  bindForms();
}
function wordForm(w){
  return '<form class="form" id="wordForm">'+
    '<div class="two"><div class="field"><label for="f-es">Spanisch</label><input id="f-es" required autocomplete="off" value="'+h(w.es||"")+'" placeholder="la casa"></div>'+
    '<div class="field"><label for="f-de">Deutsch</label><input id="f-de" required autocomplete="off" value="'+h(w.de||"")+'" placeholder="das Haus"></div></div>'+
    '<div class="field"><label for="f-exes">Beispielsatz Spanisch (optional)</label><input id="f-exes" autocomplete="off" value="'+h(w.ex_es||"")+'"></div>'+
    '<div class="field"><label for="f-exde">Beispielsatz Deutsch (optional)</label><input id="f-exde" autocomplete="off" value="'+h(w.ex_de||"")+'"></div>'+
    '<div class="field"><label for="f-cat">Kategorie (optional)</label><input id="f-cat" autocomplete="off" value="'+h(w.cat||"")+'" placeholder="z.B. Wohnen"></div>'+
    '<button class="cta" type="submit">'+(w.id?"Speichern":"Hinzufügen")+'</button></form>';
}
function renderEdit(){
  const w=S.vocab.get(editId); if(!w){ go("list"); return; }
  app.innerHTML='<section class="screen"><header class="top"><button class="icon-btn" data-act="back-list" aria-label="Zurück">←</button><h1 class="page">Vokabel bearbeiten</h1></header>'+
    wordForm(w)+'<button class="danger" id="del">Vokabel löschen</button></section>';
  bindForms();
  const del=document.getElementById("del");
  del.addEventListener("click",function(){
    if (!del.classList.contains("armed")){ del.classList.add("armed"); del.textContent="Wirklich löschen? Nochmal tippen"; setTimeout(function(){ if(del.isConnected){ del.classList.remove("armed"); del.textContent="Vokabel löschen"; } },3500); return; }
    deleteWord(editId); toast("Gelöscht"); go("list");
  });
}

function slug(s){ return (s.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,60)) || "wort"; }
function newId(es){ const b=slug(es); let id=b,n=2; while(S.vocab.has(id)){ id=b+"_"+n; n++; } return id; }
function existsEs(es, exceptId){ const k=es.trim().toLowerCase(); for (const w of S.vocab.values()){ if (w.id!==exceptId && w.es.trim().toLowerCase()===k) return true; } return false; }

function bindForms(){
  const wf=document.getElementById("wordForm");
  if (wf) wf.addEventListener("submit",function(e){
    e.preventDefault();
    const v=function(id){ return document.getElementById(id).value.trim(); };
    const es=v("f-es"), de=v("f-de"); if(!es||!de) return;
    if (screen==="edit"){
      const old=S.vocab.get(editId);
      saveWord(Object.assign({},old,{es:es,de:de,ex_es:v("f-exes"),ex_de:v("f-exde"),cat:v("f-cat")}));
      toast("Gespeichert"); go("list");
    } else {
      if (existsEs(es)){ toast("„"+es+"“ ist schon vorhanden."); return; }
      saveWord({id:newId(es),es:es,de:de,ex_es:v("f-exes"),ex_de:v("f-exde"),cat:v("f-cat"),created:Date.now()});
      toast("„"+es+"“ hinzugefügt"); wf.reset(); document.getElementById("f-es").focus();
    }
  });
  const bf=document.getElementById("bulkForm");
  if (bf) bf.addEventListener("submit",async function(e){
    e.preventDefault();
    const lines=document.getElementById("bulk").value.split(/\r?\n/).map(function(l){return l.trim();}).filter(Boolean);
    let added=0, dup=0, bad=0; const now=Date.now(); const jobs=[];
    lines.forEach(function(line,i){
      let parts = line.indexOf("\t")>=0 ? line.split("\t") : line.indexOf(";")>=0 ? line.split(";") : line.split(/\s+[-–—=]\s+/);
      parts=parts.map(function(p){return p.trim();});
      if (parts.length<2||!parts[0]||!parts[1]){ bad++; return; }
      if (existsEs(parts[0])){ dup++; return; }
      const w={id:newId(parts[0]),es:parts[0],de:parts[1],ex_es:parts[2]||"",ex_de:parts[3]||"",cat:"",created:now+i};
      jobs.push(saveWord(w)); added++;
    });
    if (!added){ toast(bad?"Kein gültiges Format erkannt.":"Alle Wörter waren schon vorhanden."); return; }
    const btn=bf.querySelector("button"); btn.disabled=true; btn.textContent="Speichert …";
    await Promise.all(jobs);
    toast(added+" hinzugefügt"+(dup?" · "+dup+" doppelt":"")+(bad?" · "+bad+" ungültig":""));
    go("dash");
  });
}

app.addEventListener("click",function(e){
  const t=e.target.closest("[data-act],[data-grade],[data-filter],[data-star],[data-edit],[data-addtab]"); if(!t) return;
  if (t.dataset.grade){ fly2(t.dataset.grade); return; }
  if (t.dataset.filter){ listState.filter=t.dataset.filter; renderList(); return; }
  if (t.dataset.star){ const on=toggleFlag(t.dataset.star); t.classList.toggle("on",on); t.textContent=on?"★":"☆"; return; }
  if (t.dataset.edit){ editId=t.dataset.edit; go("edit"); return; }
  if (t.dataset.addtab){ addTab=t.dataset.addtab; renderAdd(); return; }
  switch(t.dataset.act){
    case "home": closeDelete(); session=null; go("dash"); break;
    case "learn": startSession("due"); break;
    case "learn-flag": startSession("flag"); break;
    case "list-all": listState={filter:"all",q:""}; go("list"); break;
    case "list-flag": listState={filter:"flag",q:""}; go("list"); break;
    case "back-list": go("list"); break;
    case "add": go("add"); break;
    case "hint": showHint(); break;
    case "undo": undo(); break;
    case "signup": { const f=loginFields(); if (!f.mail||f.pass.length<6){ S.authError="Bitte E-Mail und ein Passwort mit mindestens 6 Zeichen eingeben."; render(); } else doLogin("signup", f.mail, f.pass); } break;
    case "reset": doReset(loginFields().mail); break;
    case "local": startLocal(); break;
    case "to-login": try{ localStorage.removeItem("vocabulario_mode"); }catch(e){} S.mode="login"; S.authError=""; go("login"); break;
    case "logout": doLogout(); break;
    case "del-ask": askDelete(); break;
    case "dir": S.meta.dir = S.meta.dir==="es_de" ? "de_es" : "es_de"; saveMeta(); renderStudy(); break;
  }
});
function fly2(g){ if (g==="normal"){ if(!session||session.busy) return; grade("normal"); } else fly(g); }


/* ===================== Anmeldung & Status ===================== */
function renderLogin(){
  app.innerHTML =
  '<section class="screen login">'+
    '<header class="top"><div class="brand"><span class="mark">ñ</span><b>Vocabulario</b></div></header>'+
    '<div class="login-card">'+
      '<h1 class="page">Anmelden</h1>'+
      '<p class="muted">Mit einem Konto wird dein Lernstand zwischen iPhone und MacBook abgeglichen. Lernen geht auch offline, abgeglichen wird, sobald du wieder Internet hast.</p>'+
      '<form class="form" id="loginForm">'+
        '<div class="field"><label for="l-mail">E-Mail</label><input id="l-mail" type="email" autocomplete="username" required value="'+h(S.loginMail||"")+'"></div>'+
        '<div class="field"><label for="l-pass">Passwort</label><input id="l-pass" type="password" autocomplete="current-password" minlength="6" required></div>'+
        (S.authError ? '<div class="banner err">'+h(S.authError)+'</div>' : '')+
        '<button class="cta" type="submit" '+(S.authBusy?"disabled":"")+'>'+(S.authBusy?"Einen Moment …":"Anmelden")+'</button>'+
        '<button class="tool wide" type="button" data-act="signup" '+(S.authBusy?"disabled":"")+'>Neues Konto erstellen</button>'+
      '</form>'+
      '<div class="login-links"><button class="textbtn" data-act="reset">Passwort vergessen</button><button class="textbtn" data-act="local">Ohne Konto nur auf diesem Gerät nutzen</button></div>'+
    '</div>'+
  '</section>';
  const f=document.getElementById("loginForm");
  f.addEventListener("submit",function(e){ e.preventDefault(); S.loginMail=document.getElementById("l-mail").value.trim(); doLogin("login", S.loginMail, document.getElementById("l-pass").value); });
}
function loginFields(){ const m=document.getElementById("l-mail"), p=document.getElementById("l-pass"); S.loginMail=m?m.value.trim():""; return {mail:S.loginMail, pass:p?p.value:""}; }

function statusBanner(){
  if (S.mode==="local") return '<div class="banner">Nur auf diesem Gerät gespeichert, kein Abgleich. '+(CONFIG?'<button class="textbtn inline" data-act="to-login">Mit Konto anmelden</button>':'Der Abgleich wird aktiv, sobald das Firebase-Projekt eingerichtet ist.')+'</div>';
  if (S.mode==="cloud" && !S.online) return '<div class="banner">Offline. Du kannst normal lernen, abgeglichen wird automatisch, sobald du wieder online bist.</div>';
  return "";
}
function accountLine(){
  if (S.mode==="cloud") return '<p class="foot account">'+h(S.email)+' · '+(S.online ? (S.pending?"wird abgeglichen …":"abgeglichen") : "offline")+' · <button class="textbtn inline" data-act="logout">Abmelden</button></p>';
  return "";
}

/* ===================== Service Worker ===================== */
if ("serviceWorker" in navigator && (location.protocol==="https:"||location.hostname==="localhost")) {
  navigator.serviceWorker.register("sw.js").catch(function(){});
  let reloaded=false;
  navigator.serviceWorker.addEventListener("controllerchange", function(){ if (reloaded) return; reloaded=true; if (screen!=="study") location.reload(); });
}
boot();
