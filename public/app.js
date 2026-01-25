// public/app.js
// Smooth continuous SVG ring flow (no 1Hz snapping).
// Key idea: maintain a client-side continuous "endsAtMs" and IGNORE normal 1-second SSE ticks,
// only resync on real resets (jump up) or large drift.

const countdownButton = document.getElementById("countdown-button");
const countdownValue = document.getElementById("countdown-value");
const ringForeground = document.querySelector(".countdown-ring-fg");

const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieStatus = document.getElementById("cookie-status");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");
const nextPayoutTimer = document.getElementById("next-payout-timer");

const navLinks = Array.from(document.querySelectorAll("[data-route]"));
const views = Array.from(document.querySelectorAll(".view[data-view]"));
const visitsCount = document.getElementById("visits-count");

let hasConsent = false;

const countdownSeconds = 60;

// ---------- Continuous timer model ----------
let endsAtMs = 0; // performance.now() time when countdown should hit 0
let lastServerRemainingInt = null;

// Tuning: tolerate small network jitter/drift without visible snaps
const DRIFT_TOLERANCE_MS = 300; // only hard-resync if drift is bigger than this
const DRIFT_SMOOTHING = 0.05;   // small gradual correction factor

let animationFrame = null;
let ringCircumference = 0;

const clickBoostDuration = 1000;
let clickBoostEndsAt = 0;

let sse = null;
let visitsInterval = null;

/* ---------- Ring setup (guarded) ---------- */
if (ringForeground && ringForeground.r && ringForeground.r.baseVal) {
  const radius = ringForeground.r.baseVal.value;
  ringCircumference = 2 * Math.PI * radius;
  ringForeground.style.strokeDasharray = `${ringCircumference} ${ringCircumference}`;
  ringForeground.style.strokeDashoffset = "0";
}

/* ---------- Cookie/consent helpers (guarded) ---------- */
const setCookieStatus = (message, { show = true } = {}) => {
  if (!cookieStatus) return;
  cookieStatus.textContent = message;
  cookieStatus.hidden = !show;
};

const setConsentState = (granted) => {
  document.body.classList.toggle("has-consent", granted);
};

const showCookieModal = () => {
  setConsentState(false);
  if (!cookieModal) return;
  cookieModal.classList.add("is-visible");
  cookieModal.setAttribute("aria-hidden", "false");
};

const hideCookieModal = () => {
  setConsentState(true);
  if (!cookieModal) return;
  cookieModal.classList.remove("is-visible");
  cookieModal.setAttribute("aria-hidden", "true");
  if (cookieError) cookieError.hidden = true;
  if (cookieLimit) cookieLimit.hidden = true;
  if (cookieStatus) cookieStatus.hidden = true;
};

const checkConsent = async () => {
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (!response.ok) throw new Error("status");

    const data = await response.json();
    if (!data.hasId) {
      hasConsent = false;
      showCookieModal();
      setCookieStatus('No cookie ID detected yet. Tap “Allow Cookies” to create one.');
      stopSSE();
      startAnimation();
      return false;
    }

    hasConsent = true;
    hideCookieModal();
    startSSE();
    startAnimation();
    refreshVisitsCount();
    return true;
  } catch {
    hasConsent = false;
    showCookieModal();
    setCookieStatus("Unable to reach the server. Please try again.");
    stopSSE();
    startAnimation();
    return false;
  }
};

const requestConsent = async () => {
  if (cookieError) cookieError.hidden = true;
  if (cookieLimit) cookieLimit.hidden = true;

  setCookieStatus("Requesting cookie consent…");

  try {
    const response = await fetch("/api/consent", {
      method: "POST",
      credentials: "same-origin"
    });

    if (response.status === 403) {
      if (cookieLimit) cookieLimit.hidden = false;
      setCookieStatus("The 1,000,000 user limit has been reached.");
      return;
    }

    if (!response.ok) {
      if (cookieError) cookieError.hidden = false;
      setCookieStatus("Cookie request failed. Please try again.");
      return;
    }

    await checkConsent();
    if (!hasConsent && cookieError) cookieError.hidden = false;
  } catch {
    if (cookieError) cookieError.hidden = false;
    setCookieStatus("Network error. Please try again.");
  }
};

if (allowCookiesButton) {
  allowCookiesButton.addEventListener("click", requestConsent);
}

/* ---------- Visits today ---------- */
const setVisitsCount = (value) => {
  if (!visitsCount) return;
  visitsCount.textContent = value;
};

const refreshVisitsCount = async () => {
  if (!visitsCount) return;
  try {
    const response = await fetch("/api/visits-today", { credentials: "same-origin" });
    if (!response.ok) return;
    const data = await response.json();
    if (typeof data.count === "number") {
      setVisitsCount(String(data.count));
    }
  } catch {
    // ignore
  }
};

/* ---------- Payout timer ---------- */
const formatPayoutTime = (totalSeconds) => {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}`;
};

const setNextPayoutTimer = (remainingSeconds) => {
  if (!nextPayoutTimer) return;
  nextPayoutTimer.textContent = formatPayoutTime(remainingSeconds);
};

/* ---------- Apply server time WITHOUT 1Hz snapping ---------- */
const applyServerRemaining = (remainingInt) => {
  if (typeof remainingInt !== "number" || Number.isNaN(remainingInt)) return;

  const now = performance.now();
  const newEndsAt = now + remainingInt * 1000;

  // First sync
  if (!endsAtMs || lastServerRemainingInt === null) {
    endsAtMs = newEndsAt;
    lastServerRemainingInt = remainingInt;
    return;
  }

  // Detect true reset/jump-up (e.g., 12 -> 60 after click)
  const jumpedUp = remainingInt > lastServerRemainingInt + 1;

  // Compare where our current endsAt thinks we are vs. server-implied endsAt
  const driftMs = newEndsAt - endsAtMs;
  const bigDrift = Math.abs(driftMs) > DRIFT_TOLERANCE_MS;

  if (jumpedUp || bigDrift) {
    // Hard resync only on real resets or large drift
    endsAtMs = newEndsAt;
  } else {
    // Ignore normal 1-second ticks; optionally do a tiny smoothing correction
    // to prevent long-term drift without visible snapping.
    endsAtMs = endsAtMs + driftMs * DRIFT_SMOOTHING;
  }

  lastServerRemainingInt = remainingInt;
};

const getSmoothRemaining = () => {
  if (!endsAtMs) return countdownSeconds;
  const remaining = (endsAtMs - performance.now()) / 1000; // float seconds
  return Math.max(0, Math.min(countdownSeconds, remaining));
};

const getDisplayRemainingInt = () => Math.max(0, Math.ceil(getSmoothRemaining()));

/* ---------- Countdown UI updates (guarded) ---------- */
const updateShakeState = (displayRemainingInt) => {
  if (!countdownButton) return;

  countdownButton.classList.remove("shake-subtle", "shake-medium", "shake-heavy");

  if (displayRemainingInt <= 0 || displayRemainingInt >= 31) return;

  if (displayRemainingInt <= 5) countdownButton.classList.add("shake-heavy");
  else if (displayRemainingInt <= 15) countdownButton.classList.add("shake-medium");
  else countdownButton.classList.add("shake-subtle");
};

const updateShellStateSmooth = (smoothRemainingFloat) => {
  if (!ringForeground || !ringCircumference || !countdownButton) return;

  const clamped = Math.max(0, Math.min(countdownSeconds, smoothRemainingFloat));
  const progress = clamped / countdownSeconds; // smooth 1 -> 0
  const hue = Math.round(120 * progress);
  const dash = ringCircumference * progress;

  ringForeground.style.strokeDasharray = `${dash} ${ringCircumference}`;
  countdownButton.style.setProperty("--shell-hue", hue.toString());
};

const getBoostedDisplayValue = (displayRemainingInt) => {
  if (displayRemainingInt <= 0) return 0;
  if (clickBoostEndsAt && performance.now() < clickBoostEndsAt) return displayRemainingInt;
  return displayRemainingInt;
};

const setCountdownText = (displayRemainingInt) => {
  if (!countdownValue) return;
  countdownValue.textContent = String(getBoostedDisplayValue(displayRemainingInt));
};

/* ---------- Animation loop ---------- */
const tickUI = () => {
  const smoothRemaining = getSmoothRemaining();
  const displayRemaining = Math.max(0, Math.ceil(smoothRemaining));

  setCountdownText(displayRemaining);
  updateShakeState(displayRemaining);
  updateShellStateSmooth(smoothRemaining);

  animationFrame = requestAnimationFrame(tickUI);
};

const startAnimation = () => {
  if (animationFrame) return;
  animationFrame = requestAnimationFrame(tickUI);
};

const stopAnimation = () => {
  if (!animationFrame) return;
  cancelAnimationFrame(animationFrame);
  animationFrame = null;
};

/* ---------- SSE countdown ---------- */
const startSSE = () => {
  if (sse) return;
  try {
    sse = new EventSource("/events");
    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data.remaining === "number") {
          applyServerRemaining(data.remaining);
        }
        if (typeof data.nextPayoutRemaining === "number") {
          setNextPayoutTimer(data.nextPayoutRemaining);
        }
      } catch {
        // ignore
      }
    };
    sse.onerror = () => {
      // Browser auto-retries; animation continues from endsAtMs.
    };
  } catch {
    sse = null;
  }
};

const stopSSE = () => {
  if (!sse) return;
  try {
    sse.close();
  } catch {
    // ignore
  }
  sse = null;
};

/* ---------- Click handler ---------- */
const postClick = async () => {
  if (!hasConsent) {
    showCookieModal();
    setCookieStatus("Please allow cookies to use the site.");
    return;
  }

  try {
    const response = await fetch("/api/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({})
    });

    if (response.status === 401) {
      hasConsent = false;
      showCookieModal();
      setCookieStatus("Cookie missing or blocked. Tap “Allow Cookies” again.");
      return;
    }

    if (!response.ok) return;

    const data = await response.json();
    if (typeof data.remaining === "number") {
      // Click resets server timer -> should jump up -> endsAtMs hard-resync
      applyServerRemaining(data.remaining);
      clickBoostEndsAt = performance.now() + clickBoostDuration;
    }
  } catch {
    // ignore
  }
};

if (countdownButton) {
  countdownButton.addEventListener("click", postClick);
}

/* ---------- Minimal in-page routing ---------- */
const showView = (name) => {
  for (const section of views) {
    const isMatch = section.getAttribute("data-view") === name;
    section.hidden = !isMatch;
  }
};

const routeFromPath = (pathname) => {
  const p = (pathname || "/").replace(/^\/+/, "").toLowerCase();
  if (p === "" || p === "home") return "home";
  if (p === "guide") return "guide";
  if (p === "more") return "more";
  return "home";
};

const navigate = (path) => {
  history.pushState({}, "", path);
  showView(routeFromPath(location.pathname));
};

for (const link of navLinks) {
  link.addEventListener("click", (e) => {
    const route = link.getAttribute("data-route");
    if (!route) return;
    e.preventDefault();
    if (route === "home") navigate("/");
    else navigate(`/${route}`);
  });
}

window.addEventListener("popstate", () => {
  showView(routeFromPath(location.pathname));
});

/* ---------- Boot ---------- */
window.addEventListener("DOMContentLoaded", () => {
  // Start a smooth local countdown immediately.
  endsAtMs = performance.now() + countdownSeconds * 1000;
  lastServerRemainingInt = countdownSeconds;

  showView(routeFromPath(location.pathname));
  startAnimation();
  checkConsent(); // starts SSE if consent exists
  refreshVisitsCount();
  if (!visitsInterval) {
    visitsInterval = setInterval(refreshVisitsCount, 60_000);
  }
});
