// public/app.js

const countdownButton = document.getElementById("countdown-button");
const countdownValue = document.getElementById("countdown-value");
const ringForeground = document.querySelector(".countdown-ring-fg");

const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieStatus = document.getElementById("cookie-status");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");

let hasConsent = false;

const countdownSeconds = 60;
let lastServerRemaining = countdownSeconds;
let lastServerTime = 0;
let lastServerEndsAt = 0;

let animationFrame = null;
let ringCircumference = 0;

const clickBoostDuration = 1000;
let clickBoostEndsAt = 0;

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
    return true;
  } catch {
    showCookieModal();
    setCookieStatus("Unable to reach the server. Please try again.");
    return false;
  }
};

const requestConsent = async () => {
  if (cookieError) cookieError.hidden = true;
  if (cookieLimit) cookieLimit.hidden = true;

  setCookieStatus("Requesting cookie consent…");

  try {
    const response = await fetch("/api/consent", { method: "POST" });

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

/* ---------- Countdown UI updates (guarded) ---------- */
const updateShakeState = (remaining) => {
  if (!countdownButton) return;

  countdownButton.classList.remove("shake-subtle", "shake-medium", "shake-heavy");

  if (remaining <= 0 || remaining >= 31) return;

  if (remaining <= 5) countdownButton.classList.add("shake-heavy");
  else if (remaining <= 15) countdownButton.classList.add("shake-medium");
  else countdownButton.classList.add("shake-subtle");
};

const updateShellState = (remaining) => {
  if (!ringForeground || !ringCircumference || !countdownButton) return;

  const clamped = Math.max(0, Math.min(countdownSeconds, remaining));
  const progress = Math.min(1, clamped / countdownSeconds);
  const hue = Math.round(120 * progress);
  const dash = ringCircumference * progress;

  ringForeground.style.strokeDasharray = `${dash} ${ringCircumference}`;
  countdownButton.style.setProperty("--shell-hue", hue.toString());
};

const getBoostedDisplayValue = (remaining) => {
  if (remaining <= 0) return 0;
  if (clickBoostEndsAt && performance.now() < clickBoostEndsAt) return remaining; // or Option B
  return remaining;
};
