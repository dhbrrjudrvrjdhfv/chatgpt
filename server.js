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
const PORT = process.env.PORT || 3000;

const MAX_CLIENTS = 1_000_000;
const COOKIE_NAME = "client_token";

const NIST_URLS = ["https://time.gov/actualtime.cgi", "https://time.nist.gov/actualtime.cgi"];

const NIST_DAYTIME_SERVERS = [
  "time.nist.gov",
  "time-a.nist.gov",
  "time-b.nist.gov",
  "time-a-b.nist.gov",
  "time-b-b.nist.gov"
];

const NIST_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ===== 24h payout window (NOT calendar; starts when offset is initialized) =====
const PAYOUT_CYCLE_SECONDS = 86400;

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
  clients: new Map(), // token -> id
  clickCounts: new Map(), // id -> count
  clickEvents: [],
  dailyVisits: new Map() // dayKey -> Set(clientId)
};

// ===== SSE =====
const sseClients = new Set();

// ===== Countdown (local time) =====
// NOTE: this is boot-restored from Firestore if enabled
let countdownEndAt = Date.now() + 60_000;

// ===== NIST offset =====
let nistOffsetMs = 0;
let deploymentStartNistMs = null; // legacy (not used for payout anymore)
let hasNistSync = false;

// ===== Visits Today cache =====
let visitsDayKeyCache = null;
let visitsTodayCache = null; // null => LOADING / not ready

// ===== “Day boundary” offset (auto-initialized on first NIST sync if meta is empty) =====
// IMPORTANT: null means “uninitialized”; this is how we detect a fresh /meta wipe.
let visitsDayOffsetMs = null;

// ===== Helpers =====
const getRemainingSeconds = () => {
  const remainingMs = countdownEndAt - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
};

// ===== Firestore: legacy deployment start =====
const loadDeploymentStart = async () => {
  if (!db) return;
  const doc = await db.collection("meta").doc("deploymentStartNistMs").get();
  if (doc.exists) deploymentStartNistMs = doc.data().value;
};

const persistDeploymentStart = async (value) => {
  if (!db) return;
  await db.collection("meta").doc("deploymentStartNistMs").set({ value }, { merge: true });
};

// ===== Firestore: countdown meta (DEPLOYMENT-PROOF) =====
const COUNTDOWN_META_DOC = "countdownEndAt"; // meta/countdownEndAt { value: <ms> }

const normalizeMsNumber = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v <= 0) return null;
  return v;
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

  // If missing/invalid, create one immediately.
  countdownEndAt = Date.now() + 60_000;
  await ref.set({ value: countdownEndAt }, { merge: true });
};

const persistCountdownEndAt = async () => {
  if (!db) return;
  await db.collection("meta").doc(COUNTDOWN_META_DOC).set({ value: countdownEndAt }, { merge: true });
};

// ===== Firestore: visits offset meta (AUTO-INIT ON FRESH META) =====
const VISITS_OFFSET_META_DOC = "visitsDayOffsetMs"; // meta/visitsDayOffsetMs { value: <ms> }

const normalizeOffsetMsNumber = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // clamp to [0, 86400000)
  return ((v % 86400000) + 86400000) % 86400000;
};

const loadVisitsDayOffsetMs = async () => {
  if (!db) return;

  const ref = db.collection("meta").doc(VISITS_OFFSET_META_DOC);
  const snap = await ref.get();

  if (!snap.exists) {
    // DO NOT create a default (0). Missing means “fresh start needed”.
    visitsDayOffsetMs = null;
    return;
  }

  const stored = normalizeOffsetMsNumber(snap.data()?.value);
  visitsDayOffsetMs = stored; // may be null if invalid
};

const persistVisitsDayOffsetMs = async () => {
  if (!db) return;
  if (visitsDayOffsetMs === null) return;

  await db
    .collection("meta")
    .doc(VISITS_OFFSET_META_DOC)
    .set({ value: normalizeOffsetMsNumber(visitsDayOffsetMs) }, { merge: true });
};

// ===== NIST helpers =====
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

const fetchNistDaytimeTimestamp = async () => {
  const errors = [];
  for (const host of NIST_DAYTIME_SERVERS) {
    try {
      const result = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: 13 });
        const timeoutId = setTimeout(() => {
          socket.destroy();
          reject(new Error("timeout"));
        }, 5000);

        let buffer = "";

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (buffer.includes("\n")) socket.end();
        });

        socket.on("end", () => {
          clearTimeout(timeoutId);
          resolve(buffer.trim());
        });

        socket.on("error", (error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
      });

      const nistMs = parseNistDaytime(result);
      if (!nistMs) {
        errors.push(`${host} parse`);
        continue;
      }
      return nistMs;
    } catch (error) {
      errors.push(`${host} ${error?.message || error}`);
    }
  }
  throw new Error(`NIST daytime failed: ${errors.join("; ")}`);
};

const fetchNistTimestamp = async () => {
  const errors = [];
  for (const baseUrl of NIST_URLS) {
    try {
      const response = await fetch(`${baseUrl}?cacheBust=${Date.now()}`, {
        headers: {
          "Cache-Control": "no-cache",
          "User-Agent": "Mozilla/5.0"
        }
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

  try {
    return await fetchNistDaytimeTimestamp();
  } catch (error) {
    errors.push(error?.message || error);
  }

  throw new Error(`NIST fetch failed: ${errors.join("; ")}`);
};

const syncNistTime = async () => {
  try {
    const nistMs = await fetchNistTimestamp();
    nistOffsetMs = nistMs - Date.now();

    // legacy meta; keep writing it so older data expectations don't break
    if (!deploymentStartNistMs) {
      deploymentStartNistMs = nistMs;
      await persistDeploymentStart(deploymentStartNistMs);
    }

    hasNistSync = true;

    // AUTO-INIT: if meta was wiped and visitsDayOffsetMs is missing,
    // set the “day boundary” to NOW so payout starts at 24:00:00 and visits count from now.
    if (visitsDayOffsetMs === null) {
      const now = getNistNowMs();
      visitsDayOffsetMs = now % 86400000;

      try {
        await persistVisitsDayOffsetMs();
      } catch (e) {
        console.warn("Failed to persist visitsDayOffsetMs:", e?.message || e);
      }

      visitsDayKeyCache = null;
      visitsTodayCache = 0;

      broadcastCountdown();
    }
  } catch (error) {
    console.warn("NIST sync failed, using local time.", error?.message || error);
  }
};

const getNistNowMs = () => Date.now() + nistOffsetMs;

const isNistReadyForWindow = () => hasNistSync && visitsDayOffsetMs !== null;

const getAdjustedNistNowMs = () => getNistNowMs() - (visitsDayOffsetMs ?? 0);

// ===== 24h payout based on the same adjusted NIST window =====
const getPayoutRemainingSeconds = () => {
  if (!isNistReadyForWindow()) return null;

  const adjustedSeconds = Math.floor(getAdjustedNistNowMs() / 1000);
  const secondsIntoWindow =
    ((adjustedSeconds % PAYOUT_CYCLE_SECONDS) + PAYOUT_CYCLE_SECONDS) % PAYOUT_CYCLE_SECONDS;

  const remaining = PAYOUT_CYCLE_SECONDS - secondsIntoWindow;

  // If exactly on boundary, show full 24h rather than 00:00:00
  return remaining === 0 ? PAYOUT_CYCLE_SECONDS : remaining;
};

// ===== Visits “Today” (window) =====
// Day key uses the adjusted clock. It is NOT “calendar-following” once offset is initialized at deploy-time.
const getNistDayKey = () => {
  if (!isNistReadyForWindow()) return null;
  return new Date(getAdjustedNistNowMs()).toISOString().slice(0, 10); // YYYY-MM-DD (UTC) of adjusted clock
};

const refreshVisitsTodayCacheIfNeeded = () => {
  if (!isNistReadyForWindow()) {
    visitsDayKeyCache = null;
    visitsTodayCache = null;
    return;
  }

  const dayKey = getNistDayKey();
  if (!dayKey) {
    visitsDayKeyCache = null;
    visitsTodayCache = null;
    return;
  }

  if (visitsDayKeyCache === dayKey && visitsTodayCache !== null) return;

  visitsDayKeyCache = dayKey;
  visitsTodayCache = 0;

  if (!db) {
    const set = memoryStore.dailyVisits.get(dayKey);
    visitsTodayCache = set ? set.size : 0;
    return;
  }

  db.collection("dailyVisits")
    .doc(dayKey)
    .get()
    .then((doc) => {
      if (!doc.exists) {
        visitsTodayCache = 0;
        return;
      }
      const count = doc.data()?.count;
      visitsTodayCache = typeof count === "number" ? count : 0;
    })
    .catch(() => {});
};

const markVisitToday = async (clientId) => {
  if (!isNistReadyForWindow()) return null;

  const dayKey = getNistDayKey();
  if (!dayKey) return null;

  if (visitsDayKeyCache !== dayKey) {
    visitsDayKeyCache = dayKey;
    visitsTodayCache = 0;
  }

  if (!db) {
    let set = memoryStore.dailyVisits.get(dayKey);
    if (!set) {
      set = new Set();
      memoryStore.dailyVisits.set(dayKey, set);
    }
    set.add(String(clientId));
    visitsTodayCache = set.size;
    return set.size;
  }

  const dailyRef = db.collection("dailyVisits").doc(dayKey);
  const visitorRef = dailyRef.collection("visitors").doc(String(clientId));

  const newCount = await db.runTransaction(async (transaction) => {
    const [dailySnap, visitorSnap] = await Promise.all([transaction.get(dailyRef), transaction.get(visitorRef)]);

    const currentCount =
      dailySnap.exists && typeof dailySnap.data()?.count === "number" ? dailySnap.data().count : 0;

    if (visitorSnap.exists) return currentCount;

    transaction.set(visitorRef, { seenAt: FieldValue.serverTimestamp() }, { merge: true });
    const nextCount = currentCount + 1;

    // Store window info for debugging/traceability (optional but helpful)
    transaction.set(
      dailyRef,
      {
        count: nextCount,
        windowSeconds: PAYOUT_CYCLE_SECONDS,
        visitsDayOffsetMs: visitsDayOffsetMs ?? null
      },
      { merge: true }
    );

    return nextCount;
  });

  visitsTodayCache = typeof newCount === "number" ? newCount : visitsTodayCache;
  return visitsTodayCache;
};

// ===== SSE broadcast =====
const broadcastCountdown = () => {
  refreshVisitsTodayCacheIfNeeded();

  const remaining = getRemainingSeconds();
  const payoutRemaining = getPayoutRemainingSeconds();

  const payload = `data: ${JSON.stringify({
    remaining,
    endsAt: countdownEndAt,
    payoutRemaining,
    nistReady: isNistReadyForWindow(),
    visitsToday: isNistReadyForWindow() ? visitsTodayCache : null
  })}\n\n`;

  for (const res of sseClients) res.write(payload);
};

setInterval(() => {
  broadcastCountdown();
}, 1000);

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
  if (!token) return res.status(200).json({ hasId: false, visitsToday: null });

  const id = await getClientId(token);
  if (!id) return res.status(200).json({ hasId: false, visitsToday: null });

  let visitsToday = null;
  if (isNistReadyForWindow()) visitsToday = await markVisitToday(id);

  return res.status(200).json({ hasId: true, id, visitsToday });
});

app.post("/api/consent", async (req, res) => {
  const token = req.cookies[COOKIE_NAME] || uuidv4();

  const existingId = await getClientId(token);
  if (existingId) {
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax" });
    return res.status(200).json({ id: existingId });
  }

  const newId = await assignClientId(token);
  if (!newId) return res.status(403).json({ error: "MAX_CLIENTS_REACHED" });

  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax" });
  return res.status(200).json({ id: newId });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);

  refreshVisitsTodayCacheIfNeeded();

  const initial = {
    remaining: getRemainingSeconds(),
    endsAt: countdownEndAt,
    payoutRemaining: getPayoutRemainingSeconds(),
    nistReady: isNistReadyForWindow(),
    visitsToday: isNistReadyForWindow() ? visitsTodayCache : null
  };

  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.post("/api/click", async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const id = await getClientId(token);
  if (!id) return res.status(401).json({ error: "NOT_AUTHENTICATED" });

  const remaining = getRemainingSeconds();
  if (remaining === 0) return res.status(200).json({ remaining });

  // Reset timer
  countdownEndAt = Date.now() + 60_000;

  // Persist timer reset (deployment-proof)
  try {
    await persistCountdownEndAt();
  } catch (e) {
    console.warn("Failed to persist countdownEndAt:", e?.message || e);
  }

  broadcastCountdown();

  const timestamp = Date.now();
  const orderKey = `${timestamp.toString().padStart(13, "0")}_${String(id).padStart(7, "0")}`;

  if (!db) {
    memoryStore.clickEvents.push({ id, timestamp, orderKey });
    const currentCount = memoryStore.clickCounts.get(String(id)) ?? 0;
    memoryStore.clickCounts.set(String(id), currentCount + 1);
  } else {
    await db.runTransaction(async (transaction) => {
      const clickRef = db.collection("clickEvents").doc();
      transaction.set(clickRef, { id, timestamp, orderKey });

      const countRef = db.collection("clickCounts").doc(String(id));
      transaction.set(countRef, { count: FieldValue.increment(1) }, { merge: true });
    });
  }

  return res.status(200).json({ remaining: getRemainingSeconds() });
};

// ===== Admin reset token =====
const requireResetToken = (req) => {
  const token = process.env.RESET_PAYOUT_TOKEN;
  return token && req.headers["x-reset-token"] === token;
};

// ===== Admin: reset the 24h window start NOW (both Visits Today + payout) =====
app.post("/api/visits/reset", async (req, res) => {
  if (!requireResetToken(req)) return res.status(403).json({ error: "FORBIDDEN" });
  if (!hasNistSync) return res.status(400).json({ error: "NIST_NOT_READY" });

  const now = getNistNowMs();
  visitsDayOffsetMs = now % 86400000;

  try {
    await persistVisitsDayOffsetMs();
  } catch (e) {
    console.warn("Failed to persist visitsDayOffsetMs:", e?.message || e);
  }

  visitsDayKeyCache = null;
  visitsTodayCache = 0;

  broadcastCountdown();

  return res.status(200).json({
    resetAtNistMs: now,
    newDayKey: getNistDayKey()
  });
});

// Back-compat: payout/reset does the same thing
app.post("/api/payout/reset", async (req, res) => {
  if (!requireResetToken(req)) return res.status(403).json({ error: "FORBIDDEN" });
  if (!hasNistSync) return res.status(400).json({ error: "NIST_NOT_READY" });

  const now = getNistNowMs();
  visitsDayOffsetMs = now % 86400000;

  try {
    await persistVisitsDayOffsetMs();
  } catch (e) {
    console.warn("Failed to persist visitsDayOffsetMs:", e?.message || e);
  }

  visitsDayKeyCache = null;
  visitsTodayCache = 0;

  broadcastCountdown();

  return res.status(200).json({
    resetAtNistMs: now,
    newDayKey: getNistDayKey()
  });
});

// ===== SPA fallback =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Init + Start server =====
const initialize = async () => {
  // Restore Firestore-backed values before serving traffic (if Firestore enabled)
  if (db) {
    await Promise.all([loadDeploymentStart(), loadCountdownEndAt(), loadVisitsDayOffsetMs()]);
  }

  // NIST sync (syncNistTime will also auto-init visitsDayOffsetMs if meta was wiped)
  await syncNistTime();
  setInterval(syncNistTime, NIST_SYNC_INTERVAL_MS);

  // If Firestore enabled but countdown doc still missing for any reason, persist once
  if (db) {
    try {
      await persistCountdownEndAt();
    } catch {}
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

initialize().catch((err) => {
  console.error("Fatal initialize error:", err);

  // Still try to start; NIST sync may succeed later via interval and auto-init offset then.
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
