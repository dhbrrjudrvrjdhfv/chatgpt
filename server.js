// server.js
import express from "express";
import cookieParser from "cookie-parser";
import { v4 as uuidv4 } from "uuid";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust Render / reverse proxy so secure cookies work correctly behind HTTPS termination.
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const MAX_CLIENTS = 1_000_000;
const COOKIE_NAME = "client_token";

const isProd = process.env.NODE_ENV === "production";
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: isProd,
  path: "/"
};

// NIST / Time servers
const NIST_URLS = ["https://time.gov/actualtime.cgi", "https://time.nist.gov/actualtime.cgi"];
const NIST_DAYTIME_SERVERS = [
  "time.nist.gov",
  "time-a.nist.gov",
  "time-b.nist.gov",
  "time-a-b.nist.gov",
  "time-b-b.nist.gov"
];
const NIST_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// 24h window length
const WINDOW_SECONDS = 86400;
const MS_PER_DAY = 86400000;

// ===== PAYOUT LADDER (from File 2) =====
const PAYOUT_TABLE = [
  1, 1.4, 2, 2.8, 4, 5.7, 8.1, 11.5, 16.2, 22.8,
  31.8, 44.1, 60.6, 82.4, 110, 145, 187, 237, 294, 358,
  425, 493, 559, 620, 676, 726, 769, 806, 837, 864,
  887, 906, 922, 936, 948, 958, 967, 976, 986, 1000
];
let payoutCycleIndex = 1;
let lastWindowKey = null;
const PAYOUT_CYCLE_DOC = "payoutCycleIndex";

// ===== Middleware =====
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ===== Firestore optional =====
let db = null;
if (process.env.firebase_service_account) {
  const serviceAccount = JSON.parse(process.env.firebase_service_account);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
}

// ===== In-memory fallback =====
const memoryStore = {
  clientCounter: 0,
  clients: new Map(), // token -> id
  clickCounts: new Map(), // id -> count
  clickEvents: [],
  dailyVisits: new Map() // dayKey -> Set(clientId)
};

// ===== SSE =====
const sseClients = new Set();

// ===== Countdown =====
let countdownEndAt = Date.now() + 60_000;

// ===== NIST offset =====
let nistOffsetMs = 0;
let deploymentStartNistMs = null;
let hasNistSync = false;

// ===== Window / visits tracking =====
let visitsDayOffsetMs = null;
let visitsDayKeyCache = null;
let visitsTodayCache = null;

// ===== Helpers =====
const getRemainingSeconds = () => Math.max(0, Math.ceil((countdownEndAt - Date.now()) / 1000));
const normalizeMsNumber = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const normalizeOffsetMsNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? ((v % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY : null);

// ===== Firestore meta docs =====
const COUNTDOWN_META_DOC = "countdownEndAt";
const VISITS_OFFSET_META_DOC = "visitsDayOffsetMs";

// ===== Deployment / countdown persistence =====
const loadDeploymentStart = async () => {
  if (!db) return;
  const doc = await db.collection("meta").doc("deploymentStartNistMs").get();
  if (doc.exists) deploymentStartNistMs = doc.data().value;
};
const persistDeploymentStart = async (value) => { if (!db) return; await db.collection("meta").doc("deploymentStartNistMs").set({ value }, { merge: true }); };

const loadCountdownEndAt = async () => {
  if (!db) return;
  const ref = db.collection("meta").doc(COUNTDOWN_META_DOC);
  const snap = await ref.get();
  const stored = snap.exists ? normalizeMsNumber(snap.data()?.value) : null;
  if (stored) { countdownEndAt = stored; return; }
  countdownEndAt = Date.now() + 60_000;
  await ref.set({ value: countdownEndAt }, { merge: true });
};
const persistCountdownEndAt = async () => { if (!db) return; await db.collection("meta").doc(COUNTDOWN_META_DOC).set({ value: countdownEndAt }, { merge: true }); };

const loadVisitsDayOffsetMs = async () => {
  if (!db) return;
  const ref = db.collection("meta").doc(VISITS_OFFSET_META_DOC);
  const snap = await ref.get();
  visitsDayOffsetMs = snap.exists ? normalizeOffsetMsNumber(snap.data()?.value) : null;
};
const persistVisitsDayOffsetMs = async () => {
  if (!db || visitsDayOffsetMs === null) return;
  await db.collection("meta").doc(VISITS_OFFSET_META_DOC).set({ value: normalizeOffsetMsNumber(visitsDayOffsetMs) }, { merge: true });
};

// ===== PAYOUT persistence =====
const loadPayoutCycle = async () => {
  if (!db) return;
  const snap = await db.collection("meta").doc(PAYOUT_CYCLE_DOC).get();
  const v = snap.exists ? snap.data()?.value : null;
  if (typeof v === "number" && v >= 1) payoutCycleIndex = Math.floor(v);
};
const persistPayoutCycle = async () => { if (!db) return; await db.collection("meta").doc(PAYOUT_CYCLE_DOC).set({ value: payoutCycleIndex }, { merge: true }); };

// ===== NIST parsing / fetch =====
const normalizeNistMs = (raw) => {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!/^\d{10,}$/.test(t)) return null;
  if (t.length === 10) return Number(t) * 1000;
  if (t.length > 13) return Number(t.slice(0, 13));
  return Number(t);
};
const parseNistDaytime = (payload) => {
  const m = payload.match(/(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yy, mm, dd, hh, mi, ss] = m;
  return Date.UTC(2000 + Number(yy), Number(mm)-1, Number(dd), Number(hh), Number(mi), Number(ss));
};
const fetchNistDaytimeTimestamp = async () => {
  for (const host of NIST_DAYTIME_SERVERS) {
    try {
      const result = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: 13 });
        const to = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 5000);
        let buf = "";
        socket.on("data", c => { buf += c.toString("utf8"); if (buf.includes("\n")) socket.end(); });
        socket.on("end", () => { clearTimeout(to); resolve(buf.trim()); });
        socket.on("error", e => { clearTimeout(to); reject(e); });
      });
      const ms = parseNistDaytime(result);
      if (ms) return ms;
    } catch {}
  }
  throw new Error("NIST daytime fetch failed");
};
const fetchNistTimestamp = async () => {
  for (const base of NIST_URLS) {
    try {
      const res = await fetch(`${base}?cacheBust=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) continue;
      const text = await res.text();
      const m = text.match(/"time"\s*:\s*"?(\d{10,})"?/);
      const ms = normalizeNistMs(m ? m[1] : null);
      if (ms) return ms;
    } catch {}
  }
  return fetchNistDaytimeTimestamp();
};

const getNistNowMs = () => Date.now() + nistOffsetMs;
const isWindowReady = () => hasNistSync && visitsDayOffsetMs !== null;
const getAdjustedNistNowMs = () => getNistNowMs() - (visitsDayOffsetMs ?? 0);

const getWindowDayKey = () => isWindowReady() ? new Date(getAdjustedNistNowMs()).toISOString().slice(0,10) : null;
const getPayoutRemainingSeconds = () => {
  if (!isWindowReady()) return null;
  const adjSeconds = Math.floor(getAdjustedNistNowMs()/1000);
  const secIntoWindow = ((adjSeconds % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS;
  return secIntoWindow === 0 ? WINDOW_SECONDS : WINDOW_SECONDS - secIntoWindow;
};

// ===== Visits caching =====
const refreshVisitsTodayCacheIfNeeded = () => {
  if (!isWindowReady()) { visitsDayKeyCache = null; visitsTodayCache = null; return; }
  const dayKey = getWindowDayKey();
  if (!dayKey) { visitsDayKeyCache = null; visitsTodayCache = null; return; }
  if (visitsDayKeyCache === dayKey && visitsTodayCache !== null) return;
  visitsDayKeyCache = dayKey;
  visitsTodayCache = db ? 0 : (memoryStore.dailyVisits.get(dayKey)?.size ?? 0);
  if (!db) return;
  db.collection("dailyVisits").doc(dayKey).get().then(doc => { visitsTodayCache = doc.exists ? doc.data()?.count ?? 0 : 0; }).catch(()=>{});
};

const markVisitToday = async (clientId) => {
  if (!isWindowReady()) return null;
  const dayKey = getWindowDayKey();
  if (!dayKey) return null;
  if (visitsDayKeyCache !== dayKey) { visitsDayKeyCache = dayKey; visitsTodayCache = 0; }

  if (!db) {
    let set = memoryStore.dailyVisits.get(dayKey);
    if (!set) { set = new Set(); memoryStore.dailyVisits.set(dayKey,set); }
    set.add(String(clientId));
    visitsTodayCache = set.size;
    return set.size;
  }

  const dailyRef = db.collection("dailyVisits").doc(dayKey);
  const visitorRef = dailyRef.collection("visitors").doc(String(clientId));
  const newCount = await db.runTransaction(async (transaction) => {
    const [dailySnap, visitorSnap] = await Promise.all([transaction.get(dailyRef), transaction.get(visitorRef)]);
    const currentCount = dailySnap.exists ? dailySnap.data()?.count ?? 0 : 0;
    if (visitorSnap.exists) return currentCount;
    transaction.set(visitorRef, { seenAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(dailyRef, { count: currentCount+1, windowSeconds: WINDOW_SECONDS, visitsDayOffsetMs }, { merge: true });
    return currentCount+1;
  });
  visitsTodayCache = typeof newCount==="number"?newCount:visitsTodayCache;
  return visitsTodayCache;
};

// ===== SSE =====
const broadcastCountdown = () => {
  refreshVisitsTodayCacheIfNeeded();
  const payload = `data: ${JSON.stringify({
    remaining: getRemainingSeconds(),
    endsAt: countdownEndAt,
    payoutRemaining: getPayoutRemainingSeconds(),
    payoutValue: isWindowReady() ? `$${PAYOUT_TABLE[Math.min(payoutCycleIndex-1, PAYOUT_TABLE.length-1)]}` : null,
    nistReady: isWindowReady(),
    visitsToday: isWindowReady()?visitsTodayCache:null
  })}\n\n`;
  for (const res of sseClients) res.write(payload);
};
setInterval(broadcastCountdown, 1000);

// ===== NIST sync + payout rollover =====
const syncNistTime = async () => {
  try {
    const nistMs = await fetchNistTimestamp();
    nistOffsetMs = nistMs - Date.now();
    hasNistSync = true;

    if (!deploymentStartNistMs) { deploymentStartNistMs = nistMs; try { await persistDeploymentStart(deploymentStartNistMs); } catch {} }

    const key = getWindowDayKey();
    if (lastWindowKey && key && key !== lastWindowKey) {
      payoutCycleIndex += 1;
      await persistPayoutCycle();
    }
    lastWindowKey = key;

    if (visitsDayOffsetMs===null) {
      visitsDayOffsetMs = getNistNowMs() % MS_PER_DAY;
      try { await persistVisitsDayOffsetMs(); } catch {}
      visitsDayKeyCache = null;
      visitsTodayCache = 0;
      broadcastCountdown();
    }
  } catch (e) { console.warn("NIST sync failed:", e?.message || e); }
};

// ===== Clients =====
const getClientId = async (token) => { if (!token) return null; if (!db) return memoryStore.clients.get(token) ?? null; const doc = await db.collection("clients").doc(token).get(); return doc.exists ? doc.data().id : null; };
const assignClientId = async (token) => {
  if (!db) {
    if (memoryStore.clientCounter>=MAX_CLIENTS) return null;
    const next = memoryStore.clientCounter+1;
    memoryStore.clientCounter = next;
    memoryStore.clients.set(token,next);
    memoryStore.clickCounts.set(String(next),0);
    return next;
  }
  const counterRef = db.collection("meta").doc("clientCounter");
  return db.runTransaction(async transaction => {
    const counterSnap = await transaction.get(counterRef);
    const current = counterSnap.exists ? counterSnap.data().value : 0;
    if (current>=MAX_CLIENTS) return null;
    const next = current+1;
    transaction.set(counterRef,{value:next},{merge:true});
    transaction.set(db.collection("clients").doc(token),{id:next});
    transaction.set(db.collection("clickCounts").doc(String(next)),{count:0},{merge:true});
    return next;
  });
};

// ===== API =====
app.get("/api/me", async (req,res)=>{
  const token=req.cookies[COOKIE_NAME];
  const id=await getClientId(token);
  const visitsToday=isWindowReady()?await markVisitToday(id):null;
  return res.status(200).json({hasId:!!id,id,visitsToday});
});

app.post("/api/consent", async (req,res)=>{
  const token=req.cookies[COOKIE_NAME]||uuidv4();
  const existingId=await getClientId(token);
  if(existingId){res.cookie(COOKIE_NAME,token,cookieOptions);return res.status(200).json({id:existingId});}
  const newId=await assignClientId(token);
  if(!newId) return res.status(403).json({error:"MAX_CLIENTS_REACHED"});
  res.cookie(COOKIE_NAME,token,cookieOptions);
  return res.status(200).json({id:newId});
});

app.get("/events",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  broadcastCountdown();
  req.on("close",()=>{sseClients.delete(res);});
});

app.post("/api/click", async (req,res)=>{
  const token=req.cookies[COOKIE_NAME];
  const id=await getClientId(token);
  if(!id) return res.status(401).json({error:"NOT_AUTHENTICATED"});
  countdownEndAt=Date.now()+60_000;
  try { await persistCountdownEndAt(); } catch {}
  broadcastCountdown();
  const timestamp=Date.now();
  const orderKey=`${timestamp.toString().padStart(13,"0")}_${String(id).padStart(7,"0")}`;
  if(!db){ memoryStore.clickEvents.push({id,timestamp,orderKey}); memoryStore.clickCounts.set(String(id),(memoryStore.clickCounts.get(String(id))||0)+1); }
  else { await db.runTransaction(async t=>{ const clickRef=db.collection("clickEvents").doc(); t.set(clickRef,{id,timestamp,orderKey}); const countRef=db.collection("clickCounts").doc(String(id)); t.set(countRef,{count:FieldValue.increment(1)},{merge:true}); }); }
  return res.status(200).json({remaining:getRemainingSeconds()});
});

// ===== Admin =====
const requireResetToken=(req)=>process.env.RESET_PAYOUT_TOKEN&&req.headers["x-reset-token"]===process.env.RESET_PAYOUT_TOKEN;
const doResetWindowNow=async()=>{
  if(!hasNistSync) return {ok:false,error:"NIST_NOT_READY"};
  visitsDayOffsetMs=getNistNowMs()%MS_PER_DAY;
  try{await persistVisitsDayOffsetMs();}catch{}
  visitsDayKeyCache=null; visitsTodayCache=0;
  broadcastCountdown();
  return {ok:true,resetAtNistMs:getNistNowMs(),newDayKey:getWindowDayKey()};
};
app.post("/api/visits/reset", async (req,res)=>{ if(!requireResetToken(req)) return res.status(403).json({error:"FORBIDDEN"}); const r=await doResetWindowNow(); if(!r.ok) return res.status(400).json({error:r.error}); return res.status(200).json({resetAtNistMs:r.resetAtNistMs,newDayKey:r.newDayKey}); });
app.post("/api/payout/reset", async (req,res)=>{ if(!requireResetToken(req)) return res.status(403).json({error:"FORBIDDEN"}); const r=await doResetWindowNow(); if(!r.ok) return res.status(400).json({error:r.error}); return res.status(200).json({resetAtNistMs:r.resetAtNistMs,newDayKey:r.newDayKey}); });

// ===== SPA fallback =====
app.get("*",(req,res)=>{ res.sendFile(path.join(__dirname,"public","index.html")); });

// ===== Init + Start =====
const initialize=async()=>{
  if(db) await Promise.all([loadDeploymentStart(),loadCountdownEndAt(),loadVisitsDayOffsetMs(),loadPayoutCycle()]);
  await syncNistTime();
  setInterval(syncNistTime,NIST_SYNC_INTERVAL_MS);
  if(db) try{await persistCountdownEndAt();}catch{}
  app.listen(PORT,()=>{console.log(`Server running on port ${PORT}`);});
};
initialize().catch(err=>{console.error("Fatal initialize error:",err); app.listen(PORT,()=>{console.log(`Server running on port ${PORT}`);});});
