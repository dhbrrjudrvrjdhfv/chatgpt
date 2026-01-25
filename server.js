import express from "express";
import cookieParser from "cookie-parser";
import { v4 as uuidv4 } from "uuid";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import path from "path";
import { fileURLToPath } from "url";
import net from "net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CLIENTS = 1_000_000;
const COOKIE_NAME = "client_token";
const NIST_HOST = "time.nist.gov";
const NIST_PORT = 13;
const NIST_SYNC_INTERVAL_MS = 5 * 60 * 1000;

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
  clickEvents: [],
  visitsByDay: new Map()
};

const sseClients = new Set();
let countdownEndAt = Date.now() + 60_000;
const nistState = {
  lastSyncMs: 0,
  lastTimestampMs: 0
};

const getRemainingSeconds = () => {
  const remainingMs = countdownEndAt - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
};

const getDateKeyFromTimestamp = (timestampMs) =>
  new Date(timestampMs).toISOString().slice(0, 10);

const parseNistResponse = (payload) => {
  const parts = payload.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const datePart = parts[1];
  const timePart = parts[2];
  const dateMatch = /^(\d{2})-(\d{2})-(\d{2})$/.exec(datePart);
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timePart);
  if (!dateMatch || !timeMatch) return null;
  const year = 2000 + Number(dateMatch[1]);
  const month = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3]);
  return Date.UTC(year, month, day, hour, minute, second);
};

const fetchNistTimestamp = () =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: NIST_HOST, port: NIST_PORT });
    let data = "";
    socket.setTimeout(2000);

    socket.on("data", (chunk) => {
      data += chunk.toString();
    });

    socket.on("end", () => {
      const timestamp = parseNistResponse(data);
      if (!timestamp) {
        reject(new Error("NIST_PARSE_FAILED"));
        return;
      }
      resolve(timestamp);
    });

    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("NIST_TIMEOUT"));
    });

    socket.on("error", (error) => {
      reject(error);
    });
  });

const getNistNow = async () => {
  const now = Date.now();
  if (nistState.lastSyncMs && now - nistState.lastSyncMs < NIST_SYNC_INTERVAL_MS) {
    return nistState.lastTimestampMs + (now - nistState.lastSyncMs);
  }
  try {
    const timestamp = await fetchNistTimestamp();
    nistState.lastSyncMs = now;
    nistState.lastTimestampMs = timestamp;
    return timestamp;
  } catch {
    if (nistState.lastSyncMs) {
      return nistState.lastTimestampMs + (now - nistState.lastSyncMs);
    }
    return now;
  }
};

const recordVisit = async (id) => {
  const timestamp = await getNistNow();
  const dateKey = getDateKeyFromTimestamp(timestamp);

  if (!db) {
    const existing = memoryStore.visitsByDay.get(dateKey) ?? new Set();
    existing.add(String(id));
    memoryStore.visitsByDay.set(dateKey, existing);
    return;
  }

  const visitorRef = db
    .collection("visitDays")
    .doc(dateKey)
    .collection("visitors")
    .doc(String(id));

  await visitorRef.set({ lastSeen: timestamp }, { merge: true });
};

const getVisitsTodayCount = async () => {
  const timestamp = await getNistNow();
  const dateKey = getDateKeyFromTimestamp(timestamp);
  if (!db) {
    const visits = memoryStore.visitsByDay.get(dateKey);
    return visits ? visits.size : 0;
  }
  const snapshot = await db
    .collection("visitDays")
    .doc(dateKey)
    .collection("visitors")
    .get();
  return snapshot.size;
};

const broadcastCountdown = () => {
  const remaining = getRemainingSeconds();
  const payload = `data: ${JSON.stringify({ remaining })}\n\n`;
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
  await recordVisit(id);
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
  await recordVisit(newId);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax" });
  return res.status(200).json({ id: newId });
});

app.get("/api/visits-today", async (req, res) => {
  try {
    const count = await getVisitsTodayCount();
    return res.status(200).json({ count });
  } catch {
    return res.status(500).json({ error: "VISITS_LOOKUP_FAILED" });
  }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  sseClients.add(res);
  const initial = { remaining: getRemainingSeconds() };
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
