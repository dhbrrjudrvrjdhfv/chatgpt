// ===== server.js =====
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

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: isProd,
  path: "/"
};

const NIST_URLS = [
  "https://time.gov/actualtime.cgi",
  "https://time.nist.gov/actualtime.cgi"
];

const NIST_DAYTIME_SERVERS = [
  "time.nist.gov",
  "time-a.nist.gov",
  "time-b.nist.gov",
  "time-a-b.nist.gov",
  "time-b-b.nist.gov"
];

const NIST_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const WINDOW_SECONDS = 86400;
const MS_PER_DAY = 86400000;

// ===== NEW: 40-day payout ladder =====
const PAYOUT_TABLE = [
  1,1.4,2,2.8,4,5.7,8.1,11.5,16.2,22.8,31.8,44.1,60.6,82.4,110,145,187,237,294,358,
  425,493,559,620,676,726,769,806,837,864,887,906,922,936,948,958,967,976,986,1000
];

let payoutCycleIndex = 1; // 1..40
let lastWindowKey = null;
const PAYOUT_CYCLE_DOC = "payoutCycleIndex";

// ===== Express =====
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ===== Firestore =====
let db = null;
if (process.env.firebase_service_account) {
  const serviceAccount = JSON.parse(process.env.firebase_service_account);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
}

// ===== In-memory fallback =====
const memoryStore = {
  clientCounter: 0,
  clients: new Map(),
  clickCounts: new Map(),
  clickEvents: [],
  dailyVisits: new Map()
};

const sseClients = new Set();
let countdownEndAt = Date.now() + 60_000;

let nistOffsetMs = 0;
let deploymentStartNistMs = null;
let hasNistSync = false;

let visitsDayOffsetMs = null;
let visitsDayKeyCache = null;
let visitsTodayCache = null;

// ===== Meta docs =====
const COUNTDOWN_META_DOC = "countdownEndAt";
const VISITS_OFFSET_META_DOC = "visitsDayOffsetMs";

// ===== Helpers =====
const getRemainingSeconds = () =>
  Math.max(0, Math.ceil((countdownEndAt - Date.now()) / 1000));

const normalizeMsNumber = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

const normalizeOffsetMsNumber = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? ((v % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY
    : null;

// ===== Load / Persist =====
const loadCountdownEndAt = async () => {
  if (!db) return;
  const snap = await db.collection("meta").doc(COUNTDOWN_META_DOC).get();
  const stored = snap.exists ? normalizeMsNumber(snap.data()?.value) : null;
  if (stored) countdownEndAt = stored;
};

const persistCountdownEndAt = async () => {
  if (!db) return;
  await db.collection("meta").doc(COUNTDOWN_META_DOC)
    .set({ value: countdownEndAt }, { merge: true });
};

const loadVisitsDayOffsetMs = async () => {
  if (!db) return;
  const snap = await db.collection("meta").doc(VISITS_OFFSET_META_DOC).get();
  visitsDayOffsetMs = snap.exists
    ? normalizeOffsetMsNumber(snap.data()?.value)
    : null;
};

const persistVisitsDayOffsetMs = async () => {
  if (!db || visitsDayOffsetMs === null) return;
  await db.collection("meta").doc(VISITS_OFFSET_META_DOC)
    .set({ value: visitsDayOffsetMs }, { merge: true });
};

// ===== NEW payout persistence =====
const loadPayoutCycle = async () => {
  if (!db) return;
  const snap = await db.collection("meta").doc(PAYOUT_CYCLE_DOC).get();
  const v = snap.exists ? snap.data()?.value : null;
  if (typeof v === "number" && v >= 1)
    payoutCycleIndex = Math.min(40, Math.floor(v));
};

const persistPayoutCycle = async () => {
  if (!db) return;
  await db.collection("meta").doc(PAYOUT_CYCLE_DOC)
    .set({ value: payoutCycleIndex }, { merge: true });
};

// ===== NIST =====
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

const fetchNistTimestamp = async () => {
  for (const base of NIST_URLS) {
    const r = await fetch(`${base}?cacheBust=${Date.now()}`, { headers:{ "Cache-Control":"no-cache"}});
    if (!r.ok) continue;
    const t = await r.text();
    const m = t.match(/"time"\s*:\s*"?(\d{10,})"?/);
    const ms = normalizeNistMs(m ? m[1] : null);
    if (ms) return ms;
  }
  for (const host of NIST_DAYTIME_SERVERS) {
    const result = await new Promise((resolve,reject)=>{
      const socket = net.createConnection({host,port:13});
      const to = setTimeout(()=>{socket.destroy();reject();},5000);
      let buf="";
      socket.on("data",c=>{buf+=c.toString("utf8"); if(buf.includes("\n")) socket.end();});
      socket.on("end",()=>{clearTimeout(to);resolve(buf.trim());});
      socket.on("error",()=>{clearTimeout(to);reject();});
    });
    const ms = parseNistDaytime(result);
    if (ms) return ms;
  }
  throw new Error("NIST failed");
};

const getNistNowMs = () => Date.now() + nistOffsetMs;
const isWindowReady = () => hasNistSync && visitsDayOffsetMs !== null;
const getAdjustedNistNowMs = () => getNistNowMs() - (visitsDayOffsetMs ?? 0);

const getPayoutRemainingSeconds = () => {
  if (!isWindowReady()) return null;
  const s = Math.floor(getAdjustedNistNowMs() / 1000);
  const into = ((s % WINDOW_SECONDS)+WINDOW_SECONDS)%WINDOW_SECONDS;
  const rem = WINDOW_SECONDS - into;
  return rem === 0 ? WINDOW_SECONDS : rem;
};

const getWindowDayKey = () =>
  isWindowReady()
    ? new Date(getAdjustedNistNowMs()).toISOString().slice(0,10)
    : null;

// ===== NIST sync + payout rollover =====
const syncNistTime = async () => {
  const ms = await fetchNistTimestamp();
  nistOffsetMs = ms - Date.now();
  hasNistSync = true;

  if (visitsDayOffsetMs === null) {
    visitsDayOffsetMs = getNistNowMs() % MS_PER_DAY;
    await persistVisitsDayOffsetMs();
  }

  const key = getWindowDayKey();

  if (lastWindowKey && key && key !== lastWindowKey) {
    if (payoutCycleIndex < 40) {
      payoutCycleIndex++;
      await persistPayoutCycle();
    }
  }

  lastWindowKey = key;
};

// ===== SSE =====
const broadcastCountdown = () => {
  const payload = `data: ${JSON.stringify({
    remaining: getRemainingSeconds(),
    endsAt: countdownEndAt,
    payoutRemaining: getPayoutRemainingSeconds(),
    payoutValue: isWindowReady()
      ? `$${PAYOUT_TABLE[payoutCycleIndex-1]}`
      : null
  })}\n\n`;
  for (const res of sseClients) res.write(payload);
};

setInterval(broadcastCountdown,1000);

// ===== Routes =====
app.get("/events",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close",()=>sseClients.delete(res));
});

app.post("/api/click",async(req,res)=>{
  if(getRemainingSeconds()===0) return res.json({remaining:0});
  countdownEndAt = Date.now()+60000;
  await persistCountdownEndAt();
  broadcastCountdown();
  return res.json({remaining:getRemainingSeconds()});
});

app.get("*",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

// ===== Init =====
const initialize = async () => {
  if (db)
    await Promise.all([
      loadCountdownEndAt(),
      loadVisitsDayOffsetMs(),
      loadPayoutCycle()
    ]);

  await syncNistTime();
  lastWindowKey = getWindowDayKey();
  setInterval(syncNistTime,NIST_SYNC_INTERVAL_MS);

  app.listen(PORT,()=>console.log(`Server running on ${PORT}`));
};

initialize();
