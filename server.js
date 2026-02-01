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
const PAYOUT_CYCLE_SECONDS = 3600;
const PAYOUT_TICK_SECONDS = PAYOUT_CYCLE_SECONDS + 1;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({
    credential: cert(serviceAccount)
  });
  db = getFirestore();
}

const memoryStore = {
  clientCounter: 0,
  clients: new Map(),
  clickCounts: new Map(),
  clickEvents: []
};

const sseClients = new Set();
let countdownEndAt = Date.now() + 60_000;
let nistOffsetMs = 0;
let deploymentStartNistMs = Date.now();
let hasNistSync = false;

const getRemainingSeconds = () => {
  const remainingMs = countdownEndAt - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
};

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
          if (buffer.includes("\n")) {
            socket.end();
          }
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
    if (!hasNistSync) {
      deploymentStartNistMs += nistOffsetMs;
    }
    hasNistSync = true;
  } catch (error) {
    console.warn("NIST sync failed, using local time.", error?.message || error);
  }
};

const getNistNowMs = () => Date.now() + nistOffsetMs;

const getPayoutRemainingSeconds = () => {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((getNistNowMs() - deploymentStartNistMs) / 1000)
  );
  const offset = elapsedSeconds % PAYOUT_TICK_SECONDS;
  return PAYOUT_CYCLE_SECONDS - offset;
};

const broadcastCountdown = () => {
  const remaining = getRemainingSeconds();
  const payoutRemaining = hasNistSync ? getPayoutRemainingSeconds() : null;
  const payload = `data: ${JSON.stringify({
    remaining,
    endsAt: countdownEndAt,
    payoutRemaining,
    nistReady: hasNistSync
  })}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
};

setInterval(() => {
  broadcastCountdown();
}, 1000);

const getClientId = async (token) => {
  if (!db) {
    return memoryStore.clients.get(token) ?? null;
  }
  const doc = await db.collection("clients").doc(token).get();
  if (!doc.exists) {
    return null;
  }
  return doc.data().id;
};

const assignClientId = async (token) => {
  if (!db) {
    if (memoryStore.clientCounter >= MAX_CLIENTS) {
      return null;
    }
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
    if (current >= MAX_CLIENTS) {
      return null;
    }
    const next = current + 1;
    transaction.set(counterRef, { value: next }, { merge: true });
    transaction.set(db.collection("clients").doc(token), { id: next });
    transaction.set(db.collection("clickCounts").doc(String(next)), { count: 0 }, { merge: true });
    return next;
  });
};

app.get("/api/me", async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(200).json({ hasId: false });
  }
  const id = await getClientId(token);
  if (!id) {
    return res.status(200).json({ hasId: false });
  }
  return res.status(200).json({ hasId: true, id });
});

app.post("/api/consent", async (req, res) => {
  const token = req.cookies[COOKIE_NAME] || uuidv4();
  const existingId = await getClientId(token);
  if (existingId) {
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax" });
    return res.status(200).json({ id: existingId });
  }
  const newId = await assignClientId(token);
  if (!newId) {
    return res.status(403).json({ error: "MAX_CLIENTS_REACHED" });
  }
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax" });
  return res.status(200).json({ id: newId });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  const initial = {
    remaining: getRemainingSeconds(),
    endsAt: countdownEndAt,
    payoutRemaining: hasNistSync ? getPayoutRemainingSeconds() : null,
    nistReady: hasNistSync
  };
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.post("/api/click", async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "NOT_AUTHENTICATED" });
  }
  const id = await getClientId(token);
  if (!id) {
    return res.status(401).json({ error: "NOT_AUTHENTICATED" });
  }

  const remaining = getRemainingSeconds();
  if (remaining === 0) {
    return res.status(200).json({ remaining });
  }

  countdownEndAt = Date.now() + 60_000;
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
      transaction.set(clickRef, {
        id,
        timestamp,
        orderKey
      });
      const countRef = db.collection("clickCounts").doc(String(id));
      transaction.set(
        countRef,
        { count: FieldValue.increment(1) },
        { merge: true }
      );
    });
  }

  return res.status(200).json({ remaining: getRemainingSeconds() });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

syncNistTime();
setInterval(syncNistTime, NIST_SYNC_INTERVAL_MS);
