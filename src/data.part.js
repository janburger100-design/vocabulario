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

