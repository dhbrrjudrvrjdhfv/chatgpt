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

const updateVisitsToday = (visitsToday, nistReady) => {
  if (!visitsTodayEl) return;
  if (!nistReady || visitsToday === null || visitsToday === undefined) {
    visitsTodayEl.textContent = "LOADING";
    return;
  }
  visitsTodayEl.textContent = String(visitsToday);
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
      updateVisitsToday(null, false);
      return false;
    }

    hasConsent = true;
    hideCookieModal();

    updateVisitsToday(data.visitsToday, data.visitsToday !== null);

    return true;
  } catch {
    showCookieModal();
    setCookieStatus("Unable to reach the server. Please try again.");
    updateVisitsToday(null, false);
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

// ===== ouroboros renderer =====

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

  const ampPx = level * 0.55;
  const ampDeg = level * 0.18;

  const t = tsMs / 1000;
  const x = (Math.sin(t * 37) + 0.6 * Math.sin(t * 53 + 1.3)) * ampPx * 0.55;
  const y = (Math.sin(t * 41 + 2.1) + 0.6 * Math.sin(t * 59 + 0.4)) * ampPx * 0.55;
  const r = Math.sin(t * 47 + 0.7) * ampDeg;

  return { x, y, r };
}

// ===== BODY SEGMENTS (CHANGED) =====
const segEls = [];
const glossEls = [];

for (let i = 0; i < SEGMENTS; i++) {
  const base = document.createElementNS("http://www.w3.org/2000/svg", "use");
  base.setAttribute("href", "#orbit");
  base.setAttribute("class", "body-seg");
  base.style.opacity = "0";

  const gloss = document.createElementNS("http://www.w3.org/2000/svg", "use");
  gloss.setAttribute("href", "#orbit");
  gloss.setAttribute("class", "body-seg");
  gloss.style.opacity = "0";

  bodyG.appendChild(base);
  bodyG.appendChild(gloss);

  segEls.push(base);
  glossEls.push(gloss);
}

function setHeadAtLength(len) {
  const pos = ((len % L) + L) % L;
  const p = orbit.getPointAtLength(pos);
  const p2 = orbit.getPointAtLength((pos + 1) % L);
  const angle = (Math.atan2(p2.y - p.y, p2.x - p.x) * 180) / Math.PI;
  headG.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${angle})`);
}

function updateCoreDanger(remainingSeconds) {
  if (remainingSeconds <= 10) coreEl.classList.add("is-danger");
  else coreEl.classList.remove("is-danger");
}

function setFinishedState(isFinished) {
  countdownButton.classList.toggle("is-finished", isFinished);
  if (!isFinished) countdownButton.style.transform = "translate(0px, 0px) rotate(0deg)";
}

function render(progress01, tsMs, remainingDisplayInt) {
  const headPos = progress01 * L;
  const targetBodyLen = Math.min(headPos, Math.max(0, L - END_GAP));
  const segLen = targetBodyLen / SEGMENTS;

  countdownValue.textContent = String(remainingDisplayInt);
  updateCoreDanger(remainingDisplayInt);

  const lvl = shakeLevel(remainingDisplayInt);
  const s = shakeTransform(tsMs, lvl);
  countdownButton.style.transform =
    `translate(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px) rotate(${s.r.toFixed(2)}deg)`;

  const snakeColor = rainbowAt(progress01);

  setHeadAtLength(headPos);

  const headBodyThickness = BODY_BASE * HEAD_SCALE;
  headShape.setAttribute("rx", String(headBodyThickness * 0.95));
  headShape.setAttribute("ry", String(headBodyThickness * 0.62));
  headShape.setAttribute("fill", snakeColor);

  for (let i = 0; i < SEGMENTS; i++) {
    const seg = segEls[i];
    const gloss = glossEls[i];
    const segStart = i * segLen;

    let len = Math.max(0, Math.min(segLen + SEG_OVERLAP, targetBodyLen - segStart));
    if (len <= 0.0001) {
      seg.style.opacity = "0";
      gloss.style.opacity = "0";
      continue;
    }

    const t = SEGMENTS === 1 ? 1 : i / (SEGMENTS - 1);
    const w = BODY_BASE * (TAIL_SCALE + t * (HEAD_SCALE - TAIL_SCALE));

    seg.style.strokeWidth = String(w);
    seg.style.stroke = snakeColor;
    seg.style.strokeDasharray = `${len} ${L}`;
    seg.style.strokeDashoffset = `${-segStart}`;
    seg.style.opacity = "1";

    // ===== GLOSS SWEEP (CHANGED) =====
    const shineOffset = (tsMs * 0.04) % L;
    gloss.style.stroke = "url(#snakeGloss)";
    gloss.style.strokeWidth = String(w * 0.55);
    gloss.style.strokeDasharray = `${len * 0.35} ${L}`;
    gloss.style.strokeDashoffset = `${-segStart - shineOffset}`;
    gloss.style.opacity = "0.85";
  }
}

function getRemainingSecondsFloat() {
  if (!lastEndsAt) return countdownSeconds;
  return Math.max(0, (lastEndsAt - Date.now()) / 1000);
}

function renderFrame(ts) {
  const remaining = getRemainingSecondsFloat();

  const boosted = clickBoostEndsAt && performance.now() < clickBoostEndsAt;
  const remainingVisual = boosted ? countdownSeconds : remaining;

  const remainingDisplayInt = boosted ? countdownSeconds : Math.max(0, Math.ceil(remaining));

  const clamped = Math.max(0, Math.min(countdownSeconds, remainingVisual));
  const progress01 = 1 - clamped / countdownSeconds;

  setFinishedState(remaining <= 0);
  render(progress01, ts, remainingDisplayInt);

  animationFrame = requestAnimationFrame(renderFrame);
}

// ===== SSE + click =====

const connectEvents = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);

    lastEndsAt = data.endsAt || 0;
    updatePayoutTimer(data.payoutRemaining, data.nistReady);
    updateVisitsToday(data.visitsToday, data.nistReady);

    if (data.remaining > 0) {
      setFinishedState(false);
      for (const seg of segEls) seg.style.opacity = "0";
      coreEl.classList.remove("is-danger");
    }

    if (!animationFrame) {
      animationFrame = requestAnimationFrame(renderFrame);
    }
  };
};

countdownButton.addEventListener("click", async () => {
  if (!hasConsent) {
    showCookieModal();
    return;
  }
  if (countdownButton.classList.contains("is-finished")) return;

  clickBoostEndsAt = performance.now() + clickBoostDuration;
  await fetch("/api/click", { method: "POST" });
});

// ===== Router =====

const setView = (name) => {
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
};

const routeFromPath = (pathname) => {
  if (pathname === "/guide") return "guide";
  if (pathname === "/more") return "more";
  return "home";
};

const navigate = (path) => {
  history.pushState({}, "", path);
  setView(routeFromPath(location.pathname));
};

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-route]");
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href") || "/");
});

window.addEventListener("popstate", () => {
  setView(routeFromPath(location.pathname));
});

setView(routeFromPath(location.pathname));
checkConsent().then(connectEvents);
