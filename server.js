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
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const MAX_CLIENTS = 1_000_000;
const COOKIE_NAME = "client_token";
const isProd = process.env.NODE_ENV === "production";
const cookieOptions = { httpOnly: true, sameSite: "lax", secure: isProd, path: "/" };

// ===== PAYOUT CYCLE =====
const PAYOUT_TABLE = [
  1,1.4,2,2.8,4,5.7,8.1,11.5,16.2,22.8,31.8,44.1,60.6,82.4,110,145,187,237,294,358,
  425,493,559,620,676,726,769,806,837,864,887,906,922,936,948,958,967,976,986,1000
];
let payoutCycleIndex = 1; // 1..40
const PAYOUT_CYCLE_DOC = "payoutCycleIndex";

// ===== NIST / TIME CONFIG =====
const NIST_URLS = ["https://time.gov/actualtime.cgi","https://time.nist.gov/actualtime.cgi"];
const NIST_DAYTIME_SERVERS = ["time.nist.gov","time-a.nist.gov","time-b.nist.gov","time-a-b.nist.gov","time-b-b.nist.gov"];
const NIST_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const WINDOW_SECONDS = 86400;
const MS_PER_DAY = 86400000;

// ===== FIRESTORE / MEMORY =====
let db = null;
if (process.env.firebase_service_account) {
  const serviceAccount = JSON.parse(process.env.firebase_service_account);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
}

const memoryStore = {
  clientCounter: 0,
  clients: new Map(),
  clickCounts: new Map(),
  clickEvents: [],
  dailyVisits: new Map()
};

// ===== SSE =====
const sseClients = new Set();

// ===== Countdown =====
let countdownEndAt = Date.now() + 60_000;

// ===== NIST TIME & WINDOW =====
let nistOffsetMs = 0;
let hasNistSync = false;
let visitsDayOffsetMs = null;
let visitsDayKeyCache = null;
let visitsTodayCache = null;
let lastWindowKey = null;

// ===== META DOCS =====
const COUNTDOWN_META_DOC = "countdownEndAt";
const VISITS_OFFSET_META_DOC = "visitsDayOffsetMs";

// ===== HELPERS =====
const normalizeMsNumber = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const normalizeOffsetMsNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? ((v % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY : null);

const getRemainingSeconds = () => Math.max(0, Math.ceil((countdownEndAt - Date.now()) / 1000));

const normalizeNistMs = (rawValue) => {
  if (!rawValue) return null;
  const t = String(rawValue).trim();
  if (!/^\d{10,}$/.test(t)) return null;
  if (t.length === 10) return Number(t) * 1000;
  if (t.length > 13) return Number(t.slice(0, 13));
  return Number(t);
};

const parseNistDaytime = (payload) => {
  const m = payload.match(/(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yy, mm, dd, hh, mi, ss] = m;
  return Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
};

// ===== FETCH NIST TIME =====
const fetchNistDaytimeTimestamp = async () => {
  const errors = [];
  for (const host of NIST_DAYTIME_SERVERS) {
    try {
      const result = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: 13 });
        const to = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 5000);
        let buf = "";
        socket.on("data", c => { buf += c.toString("utf8"); if (buf.includes("\n")) socket.end(); });
        socket.on("end", () => { clearTimeout(to); resolve(buf.trim()); });
        socket.on("error", (err) => { clearTimeout(to); reject(err); });
      });
      const ms = parseNistDaytime(result);
      if (ms) return ms;
    } catch (e) { errors.push(`${host} ${e?.message}`); }
  }
  throw new Error(`Daytime NIST failed: ${errors.join("; ")}`);
};

const fetchNistTimestamp = async () => {
  const errors = [];
  for (const base of NIST_URLS) {
    try {
      const r = await fetch(`${base}?cacheBust=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
      if (!r.ok) { errors.push(`${base} ${r.status}`); continue; }
      const t = await r.text();
      const m = t.match(/"time"\s*:\s*"?(\d{10,})"?/);
      const ms = normalizeNistMs(m ? m[1] : null);
      if (ms) return ms;
    } catch (e) { errors.push(`${base} ${e?.message}`); }
  }
  try { return await fetchNistDaytimeTimestamp(); } catch (e) { errors.push(e?.message); }
  throw new Error(`NIST fetch failed: ${errors.join("; ")}`);
};

const getNistNowMs = () => Date.now() + nistOffsetMs;
const isWindowReady = () => hasNistSync && visitsDayOffsetMs !== null;
const getAdjustedNistNowMs = () => getNistNowMs() - (visitsDayOffsetMs ?? 0);

const getPayoutRemainingSeconds = () => {
  if (!isWindowReady()) return null;
  const s = Math.floor(getAdjustedNistNowMs() / 1000);
  const into = ((s % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS;
  const rem = WINDOW_SECONDS - into;
  return rem === 0 ? WINDOW_SECONDS : rem;
};

const getWindowDayKey = () => isWindowReady() ? new Date(getAdjustedNistNowMs()).toISOString().slice(0, 10) : null;

// ===== VISITS LOGIC =====
const refreshVisitsTodayCacheIfNeeded = () => {
  if (!isWindowReady()) { visitsDayKeyCache = null; visitsTodayCache = null; return; }
  const key = getWindowDayKey();
  if (!key) { visitsDayKeyCache = null; visitsTodayCache = null; return; }
  if (visitsDayKeyCache === key && visitsTodayCache !== null) return;
  visitsDayKeyCache = key; visitsTodayCache = 0;
  if (!db) { const s = memoryStore.dailyVisits.get(key); visitsTodayCache = s ? s.size : 0; return; }
  db.collection("dailyVisits").doc(key).get().then(d => { visitsTodayCache = d.exists ? (d.data()?.count || 0) : 0; }).catch(()=>{});
};

const markVisitToday = async (clientId) => {
  if (!isWindowReady()) return null;
  const key = getWindowDayKey();
  if (!key) return null;
  if (visitsDayKeyCache !== key) { visitsDayKeyCache = key; visitsTodayCache = 0; }
  if (!db) {
    let set = memoryStore.dailyVisits.get(key);
    if (!set) { set = new Set(); memoryStore.dailyVisits.set(key, set); }
    set.add(String(clientId));
    visitsTodayCache = set.size;
    return set.size;
  }
  const dailyRef = db.collection("dailyVisits").doc(key);
  const visitorRef = dailyRef.collection("visitors").doc(String(clientId));
  const newCount = await db.runTransaction(async tx => {
    const [d,v] = await Promise.all([tx.get(dailyRef), tx.get(visitorRef)]);
    const cur = d.exists && typeof d.data()?.count === "number" ? d.data().count : 0;
    if (v.exists) return cur;
    tx.set(visitorRef, { seenAt: FieldValue.serverTimestamp() }, { merge: true });
    const next = cur + 1;
    tx.set(dailyRef, { count: next, windowSeconds: WINDOW_SECONDS, visitsDayOffsetMs }, { merge: true });
    return next;
  });
  visitsTodayCache = typeof newCount === "number" ? newCount : visitsTodayCache;
  return visitsTodayCache;
};

// ===== BROADCAST SSE =====
const broadcastCountdown = () => {
  refreshVisitsTodayCacheIfNeeded();
  const payload = `data: ${JSON.stringify({
    remaining: getRemainingSeconds(),
    endsAt: countdownEndAt,
    payoutRemaining: getPayoutRemainingSeconds(),
    nistReady: isWindowReady(),
    visitsToday: isWindowReady() ? visitsTodayCache : null,
    payoutValue: isWindowReady() ? `$${PAYOUT_TABLE[payoutCycleIndex-1]}` : null
  })}\n\n`;
  for (const res of sseClients) res.write(payload);
};
setInterval(broadcastCountdown, 1000);

// ===== CLIENT LOGIC =====
const getClientId = async (token) => {
  if (!db) return memoryStore.clients.get(token) ?? null;
  const doc = await db.collection("clients").doc(token).get();
  return doc.exists ? doc.data().id : null;
};

const assignClientId = async (token) => {
  if (!db) {
    if (memoryStore.clientCounter >= MAX_CLIENTS) return null;
    const next = ++memoryStore.clientCounter;
    memoryStore.clients.set(token, next);
    memoryStore.clickCounts.set(String(next), 0);
    return next;
  }
  const counterRef = db.collection("meta").doc("clientCounter");
  return db.runTransaction(async tx => {
    const snap = await tx.get(counterRef);
    const cur = snap.exists ? snap.data().value : 0;
    if (cur >= MAX_CLIENTS) return null;
    const next = cur + 1;
    tx.set(counterRef, { value: next }, { merge: true });
    tx.set(db.collection("clients").doc(token), { id: next });
    tx.set(db.collection("clickCounts").doc(String(next)), { count: 0 }, { merge: true });
    return next;
  });
};

// ===== API =====
app.get("/api/me", async (req,res)=>{
  const token = req.cookies[COOKIE_NAME];
  if(!token) return res.json({hasId:false,visitsToday:null});
  const id = await getClientId(token);
  if(!id) return res.json({hasId:false,visitsToday:null});
  const visitsToday = isWindowReady() ? await markVisitToday(id) : null;
  return res.json({hasId:true,id,visitsToday});
});

app.post("/api/consent", async (req,res)=>{
  const token = req.cookies[COOKIE_NAME] || uuidv4();
  const existingId = await getClientId(token);
  if(existingId){ res.cookie(COOKIE_NAME, token, cookieOptions); return res.json({id:existingId}); }
  const newId = await assignClientId(token);
  if(!newId) return res.status(403).json({error:"MAX_CLIENTS_REACHED"});
  res.cookie(COOKIE_NAME, token, cookieOptions);
  return res.json({id:newId});
});

app.get("/events",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  refreshVisitsTodayCacheIfNeeded();
  res.write(`data: ${JSON.stringify({
    remaining:getRemainingSeconds(),
    endsAt:countdownEndAt,
    payoutRemaining:getPayoutRemainingSeconds(),
    nistReady:isWindowReady(),
    visitsToday:isWindowReady()?visitsTodayCache:null,
    payoutValue:isWindowReady()?`$${PAYOUT_TABLE[payoutCycleIndex-1]}`:null
  })}\n\n`);
  req.on("close",()=>sseClients.delete(res));
});

app.post("/api/click", async (req,res)=>{
  const token = req.cookies[COOKIE_NAME];
  if(!token) return res.status(401).json({error:"NOT_AUTHENTICATED"});
  const id = await getClientId(token);
  if(!id) return res.status(401).json({error:"NOT_AUTHENTICATED"});
  if(getRemainingSeconds()===0) return res.json({remaining:0});
  countdownEndAt = Date.now()+60_000;
  if(db){ await db.collection("meta").doc(COUNTDOWN_META_DOC).set({value:countdownEndAt},{merge:true}); }
  broadcastCountdown();
  return res.json({remaining:getRemainingSeconds()});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

// ===== NIST SYNC + PAYOUT CYCLE =====
const syncNistTime = async () => {
  try {
    const ms = await fetchNistTimestamp();
    nistOffsetMs = ms - Date.now();
    hasNistSync = true;
    if(visitsDayOffsetMs===null){
      visitsDayOffsetMs = ms%MS_PER_DAY;
      if(db) await db.collection("meta").doc(VISITS_OFFSET_META_DOC).set({value:visitsDayOffsetMs},{merge:true});
    }
    const key = getWindowDayKey();
    if(lastWindowKey && key && key!==lastWindowKey){
      if(payoutCycleIndex<40){
        payoutCycleIndex+=1;
        if(db) await db.collection("meta").doc(PAYOUT_CYCLE_DOC).set({value:payoutCycleIndex},{merge:true});
      }
    }
    lastWindowKey = key;
  } catch(e){
    console.warn("NIST sync failed",e?.message||e);
  }
};

// ===== INIT SERVER =====
const initialize = async () => {
  if(db) await Promise.all([
    db.collection("meta").doc(COUNTDOWN_META_DOC).get().then(snap=>{if(snap.exists) countdownEndAt=normalizeMsNumber(snap.data()?.value)||countdownEndAt;}),
    db.collection("meta").doc(VISITS_OFFSET_META_DOC).get().then(snap=>{visitsDayOffsetMs = snap.exists?normalizeOffsetMsNumber(snap.data()?.value):null;}),
    db.collection("meta").doc(PAYOUT_CYCLE_DOC).get().then(snap=>{if(snap.exists){ const v = snap.data()?.value; if(typeof v==="number"&&v>=1) payoutCycleIndex=Math.min(40,Math.floor(v)); }})
  ]);
  await syncNistTime();
  lastWindowKey = getWindowDayKey();
  setInterval(syncNistTime,NIST_SYNC_INTERVAL_MS);
  app.listen(PORT,()=>console.log(`Server running on ${PORT}`));
};

initialize();

/*
POTENTIAL SHORTCOMINGS / PROBLEMS:
1. SSE clients: if many clients connect, memory use grows unbounded.
2. Firestore transactions: high concurrency on clickEvents and dailyVisits could hit contention limits.
3. Payout rollover: if server restarts mid-window, payoutCycleIndex may mismatch with prior cycle unless Firestore writes succeed.
4. NIST sync fallback: daytime TCP fallback is slow; if both HTTP and TCP fail, window initialization may be delayed.
5. Cookie-based authentication: no expiration handling; persistent cookies may accumulate invalid tokens.
6. No logging on failed Firestore writes for clicks or visits (warnings may be silent).
*/

