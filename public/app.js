// public/app.js

const countdownButton = document.getElementById("countdown-button");
const countdownValue = document.getElementById("countdown-value");
const coreEl = document.getElementById("countdown-core");
const payoutTimer = document.getElementById("payout-timer");
const visitsTodayEl = document.getElementById("visits-today");

const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieStatus = document.getElementById("cookie-status");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");

let hasConsent = false;

const countdownSeconds = 60;
const clickBoostDuration = 1000;
let clickBoostEndsAt = 0;

let animationFrame = null;
let lastEndsAt = 0;

const formatHms = (totalSeconds) => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const updatePayoutTimer = (remainingSeconds, isReady) => {
  if (!payoutTimer) return;
  if (!isReady) {
    payoutTimer.textContent = "LOADING";
    return;
  }
  payoutTimer.textContent = formatHms(remainingSeconds);
};

// ===== consent =====

const setCookieStatus = (message, { show = true } = {}) => {
  cookieStatus.textContent = message;
  cookieStatus.hidden = !show;
};

const setConsentState = (granted) => {
  document.body.classList.toggle("has-consent", granted);
};

const showCookieModal = () => {
  setConsentState(false);
  cookieModal.classList.add("is-visible");
  cookieModal.setAttribute("aria-hidden", "false");
};

const hideCookieModal = () => {
  setConsentState(true);
  cookieModal.classList.remove("is-visible");
  cookieModal.setAttribute("aria-hidden", "true");
  cookieError.hidden = true;
  cookieLimit.hidden = true;
  cookieStatus.hidden = true;
};

const checkConsent = async () => {
  try {
    const response = await fetch("/api/me");
    if (!response.ok) throw new Error("status");
    const data = await response.json();

    if (!data.hasId) {
      showCookieModal();
      setCookieStatus("No cookie ID detected yet. Tap “Allow Cookies” to create one.");
      return false;
    }

    hasConsent = true;
    hideCookieModal();

    if (visitsTodayEl && typeof data.visitsToday === "number") {
      visitsTodayEl.textContent = String(data.visitsToday);
    }

    return true;
  } catch {
    showCookieModal();
    setCookieStatus("Unable to reach the server. Please try again.");
    return false;
  }
};

const requestConsent = async () => {
  cookieError.hidden = true;
  cookieLimit.hidden = true;
  setCookieStatus("Requesting cookie consent…");

  try {
    const response = await fetch("/api/consent", { method: "POST" });

    if (response.status === 403) {
      cookieLimit.hidden = false;
      setCookieStatus("The 1,000,000 user limit has been reached.");
      return;
    }

    if (!response.ok) {
      cookieError.hidden = false;
      setCookieStatus("Cookie request failed. Please try again.");
      return;
    }

    await checkConsent();
    if (!hasConsent) cookieError.hidden = false;
  } catch {
    cookieError.hidden = false;
    setCookieStatus("Network error. Please try again.");
  }
};

allowCookiesButton.addEventListener("click", requestConsent);

// ===== ouroboros renderer (server-driven) =====

const orbit = document.getElementById("orbitMeasure");
const bodyG = document.getElementById("body");
const headG = document.getElementById("snakeHead");
const headShape = document.getElementById("headShape");

const L = orbit.getTotalLength();

const SEGMENTS = 30;
const END_GAP = 10;
const SEG_OVERLAP = 10;

const SHELL_SIZE = 22;
const BODY_BASE = SHELL_SIZE * 0.78;
const TAIL_SCALE = 0.42;
const HEAD_SCALE = 1.0;

const RAINBOW = ["#FF0000", "#FF7A00", "#FFD400", "#00C853", "#00E5FF", "#2979FF", "#AA00FF"];

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const b2 = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${b2})`;
}

function rainbowAt(progress01) {
  const n = RAINBOW.length;
  if (progress01 <= 0) return RAINBOW[0];
  if (progress01 >= 1) return RAINBOW[n - 1];

  const scaled = progress01 * (n - 1);
  const i = Math.floor(scaled);
  const t = scaled - i;
  return lerpColor(RAINBOW[i], RAINBOW[i + 1], t);
}

// 60-46: 0, 45-31: 2, 30-21: 4, 20-11: 6, 10-6: 8, 5-1: 10, 0: 0
function shakeLevel(remainingSeconds) {
  if (remainingSeconds <= 0) return 0;
  if (remainingSeconds <= 5) return 10;
  if (remainingSeconds <= 10) return 8;
  if (remainingSeconds <= 20) return 6;
  if (remainingSeconds <= 30) return 4;
  if (remainingSeconds <= 45) return 2;
  return 0;
}

function shakeTransform(tsMs, level) {
  if (level <= 0) return { x: 0, y: 0, r: 0 };

  const ampPx = level * 0.55; // 10 -> 5.5px
  const ampDeg = level * 0.18; // 10 -> 1.8deg

  const t = tsMs / 1000;
  const x = (Math.sin(t * 37) + 0.6 * Math.sin(t * 53 + 1.3)) * ampPx * 0.55;
  const y = (Math.sin(t * 41 + 2.1) + 0.6 * Math.sin(t * 59 + 0.4)) * ampPx * 0.55;
  const r = Math.sin(t * 47 + 0.7) * ampDeg;

  return { x, y, r };
}

const segEls = [];
for (let i = 0; i < SEGMENTS; i++) {
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#orbit");
  u.setAttribute("class", "body-seg");
  u.style.opacity = "0";
  bodyG.appendChild(u);
  segEls.push(u);
}

function setHeadAtLength(len) {
  const pos = ((len % L) + L) % L;
  const p = orbit.getPointAtLength(pos);
  const p2 = orbit.getPointAtLength((pos +
