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

/* =========================
   NEW: Trust Render proxy
   ========================= */
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const MAX_CLIENTS = 1_000_000;
const COOKIE_NAME = "client_token";

/* =========================
   NEW: Secure cookie options
   ========================= */
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/"
};

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

// ===== In-memory fallback store =====
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

// ===== NIST offset =====
let nistOffsetMs = 0;
let deploymentStartNistMs = null;
let hasNistSync = false;

// ===== Visits cache =====
let visitsDayKeyCache = null;
let visitsTodayCache = null;

// ===== Window anchor =====
let visitsDayOffsetMs = null;

// ===== Helpers =====
const getRemainingSeconds = () => {
  const remainingMs = countdownEndAt - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
};

const normalizeMsNumber = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v <= 0) return null;
  return v;
};

const normalizeOffsetMsNumber = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return ((v % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
};

// ===== Firestore meta =====
const COUNTDOWN_META_DOC = "countdownEndAt";
const VISITS_OFFSET_META_DOC = "visitsDayOffsetMs";

const loadDeploymentStart = async () => {
  if (!db) return;
  const doc = await db.collection("meta").doc("deploymentStartNistMs").get();
  if (doc.exists) deploymentStartNistMs = doc.data().value;
};

const persistDeploymentStart = async (value) => {
  if (!db) return;
  await db.collection("meta").doc("deploymentStartNistMs").set({ value }, { merge: true });
};

const loadCountdownEndAt = async () => {
  if (!db) return;

  const ref = db.collection("meta").doc(COUNTDOWN_META_DOC);
  const snap = await ref.get();

  const stored = snap.exists ? normalizeMsNumber(snap.data()?.value) : null;
  if (stored) {
    countdownEndAt = stored;
    return;
  }

  countdownEndAt = Date.now() + 60_000;
  await ref.set({ value: countdownEndAt }, { merge: true });
};

const persistCountdownEndAt = async () => {
  if (!db) return;
  await db.collection("meta").doc(COUNTDOWN_META_DOC).set({ value: countdownEndAt }, { merge: true });
};

const loadVisitsDayOffsetMs = async () => {
  if (!db) return;

  const ref = db.collection("meta").doc(VISITS_OFFSET_META_DOC);
  const snap = await ref.get();

  if (!snap.exists) {
    visitsDayOffsetMs = null;
    return;
  }

  visitsDayOffsetMs = normalizeOffsetMsNumber(snap.data()?.value);
};

const persistVisitsDayOffsetMs = async () => {
  if (!db) return;
  if (visitsDayOffsetMs === null) return;

  await db
    .collection("meta")
    .doc(VISITS_OFFSET_META_DOC)
    .set({ value: normalizeOffsetMsNumber(visitsDayOffsetMs) }, { merge: true });
};

// ===== NIST =====
const normalizeNistMs = (rawValue) => {
  if (!rawValue) return null;
  const trimmed = String(rawValue).trim();
  if (!/^\d{10,}$/.test(trimmed)) return null;
  if (trimmed.length === 10) return Number(trimmed) * 1000;
  if (trimmed.length > 13) return Number(trimmed.slice(0, 13));
  return Number(trimmed);
};

const parseNistDaytime = (payload) => {
  const match = payload.match(/(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, yy, mm, dd, hh, min, ss] = match;
  const year = 2000 + Number(yy);
  return Date.UTC(year, Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss));
};

const fetchNistTimestamp = async () => {
  const errors = [];

  for (const baseUrl of NIST_URLS) {
    try {
      const response = await fetch(`${baseUrl}?cacheBust=${Date.now()}`, {
        headers: { "Cache-Control": "no-cache", "User-Agent": "Mozilla/5.0" }
      });

      if (!response.ok) {
        errors.push(`${baseUrl} ${response.status}`);
        continue;
      }

      const text = await response.text();
      const match = text.match(/"time"\s*:\s*"?(\d{10,})"?/);
      const nistMs = normalizeNistMs(match ? match[1] : null);

      if (!nistMs) {
        errors.push(`${baseUrl} parse`);
        continue;
      }

      return nistMs;
    } catch (error) {
      errors.push(`${baseUrl} ${error?.message || error}`);
    }
  }

  throw new Error(`NIST fetch failed: ${errors.join("; ")}`);
};

const getNistNowMs = () => Date.now() + nistOffsetMs;
const isWindowReady = () => hasNistSync && visitsDayOffsetMs !== null;
const getAdjustedNistNowMs = () => getNistNowMs() - (visitsDayOffsetMs ?? 0);

// ===== Window logic =====
const getPayoutRemainingSeconds = () => {
  if (!isWindowReady()) return null;

  const adjustedSeconds = Math.floor(getAdjustedNistNowMs() / 1000);
  const secondsIntoWindow =
    ((adjustedSeconds % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS;

  const remaining = WINDOW_SECONDS - secondsIntoWindow;
  return remaining === 0 ? WINDOW_SECONDS : remaining;
};

const getWindowDayKey = () => {
  if (!isWindowReady()) return null;
  return new Date(getAdjustedNistNowMs()).toISOString().slice(0, 10);
};

// ===== Clients =====
const getClientId = async (token) => {
  if (!db) return memoryStore.clients.get(token) ?? null;

  const doc = await db.collection("clients").doc(token).get();
  if (!doc.exists) return null;
  return doc.data().id;
};

const assignClientId = async (token) => {
  if (!db) {
    if (memoryStore.clientCounter >= MAX_CLIENTS) return null;
    const next = memoryStore.clientCounter + 1;
    memoryStore.clientCounter = next;
    memoryStore.clients.set(token, next);
    memoryStore.clickCounts.set(String(next), 0);
    return next;
  }

  const counterRef = db.collection("meta").doc("clientCounter");

  return db.runTransaction(async (transaction) => {
    const counterSnap = await transaction.get(counterRef);
    const current = counterSnap.exists ? counterSnap.data().value : 0;

    if (current >= MAX_CLIENTS) return null;

    const next = current + 1;
    transaction.set(counterRef, { value: next }, { merge: true });
    transaction.set(db.collection("clients").doc(token), { id: next });
    transaction.set(db.collection("clickCounts").doc(String(next)), { count: 0 }, { merge: true });
    return next;
  });
};

// ===== API =====
app.get("/api/me", async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(200).json({ hasId: false });

  const id = await getClientId(token);
  if (!id) return res.status(200).json({ hasId: false });

  return res.status(200).json({ hasId: true, id });
});

app.post("/api/consent", async (req, res) => {
  const token = req.cookies[COOKIE_NAME] || uuidv4();

  const existingId = await getClientId(token);
  if (existingId) {
    res.cookie(COOKIE_NAME, token, cookieOptions);
    return res.status(200).json({ id: existingId });
  }

  const newId = await assignClientId(token);
  if (!newId) return res.status(403).json({ error: "MAX_CLIENTS_REACHED" });

  res.cookie(COOKIE_NAME, token, cookieOptions);
  return res.status(200).json({ id: newId });
});

// ===== SPA fallback =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Start server =====
const initialize = async () => {
  if (db) {
    await Promise.all([loadDeploymentStart(), loadCountdownEndAt(), loadVisitsDayOffsetMs()]);
  }

  try {
    const nistMs = await fetchNistTimestamp();
    nistOffsetMs = nistMs - Date.now();
    hasNistSync = true;
  } catch {}

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

initialize();
