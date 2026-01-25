// public/app.js
// Smooth, timer-tied SVG ring movement (client-side interpolation between 1Hz server ticks)

const countdownButton = document.getElementById("countdown-button");
const countdownValue = document.getElementById("countdown-value");
const ringForeground = document.querySelector(".countdown-ring-fg");

const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieStatus = document.getElementById("cookie-status");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");

const navLinks = Array.from(document.querySelectorAll("[data-route]"));
const views = Array.from(document.querySelectorAll(".view[data-view]"));

let hasConsent = false;

const countdownSeconds = 60;

// Server-provided countdown state (arrives ~1Hz via SSE or on click response)
let lastServerRemaining = countdownSeconds; // integer seconds from server
let lastServerTime = 0; // performance.now() when lastServerRemaining was received

let animationFrame = null;
let ringCircumference = 0;

const clickBoostDuration = 1000;
let clickBoostEndsAt = 0;

let sse = null;

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
      startAnimation(); // keep UI animating (optional). Gate is CSS anyway.
      return false;
    }

    hasConsent = true;
    hideCookieModal();
    startSSE();
    startAnimation();
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

/* ---------- Smooth time model (core change) ---------- */
// Returns a smooth, continuously decreasing remaining time in seconds (float).
const getSmoothRemaining = () => {
  // If we haven't received a server tick yet, show full time
  if (!lastServerTime) return lastServerRemaining;

  const elapsedSec = (performance.now() - lastServerTime) / 1000;
  const smooth = lastServerRemaining - elapsedSec;
  return Math.max(0, Math.min(countdownSeconds, smooth));
};

// For display/shake logic we usually want integers.
const getDisplayRemaining = () => {
  const smooth = getSmoothRemaining();
  return Math.max(0, Math.ceil(smooth));
};

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
  const progress = clamped / countdownSeconds; // 1 -> 0 smoothly
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
const applyServerRemaining = (remaining) => {
  // remaining is expected to be integer seconds (server sends ceil)
  lastServerRemaining = typeof remaining === "number" ? remaining : lastServerRemaining;
  lastServerTime = performance.now();
};

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
      } catch {
        // ignore
      }
    };
    sse.onerror = () => {
      // Browser auto-retries. We keep animating based on last received tick.
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
  // Initialize client timer baseline so ring animates smoothly immediately.
  lastServerRemaining = countdownSeconds;
  lastServerTime = performance.now();

  showView(routeFromPath(location.pathname));
  startAnimation(); // keep smooth ring running even before consent is granted
  checkConsent();   // will start SSE if consent exists
});
