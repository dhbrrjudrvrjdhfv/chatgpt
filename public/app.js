const countdownButton = document.getElementById("countdown-button");
const countdownValue = document.getElementById("countdown-value");
const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieStatus = document.getElementById("cookie-status");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");

let hasConsent = false;
let lastServerRemaining = 60;
let lastServerTime = 0;
let lastServerEndsAt = 0;
let animationFrame = null;

const setCookieStatus = (message, { show = true } = {}) => {
  cookieStatus.textContent = message;
  cookieStatus.hidden = !show;
};

const showCookieModal = () => {
  cookieModal.classList.add("is-visible");
  cookieModal.setAttribute("aria-hidden", "false");
};

const hideCookieModal = () => {
  cookieModal.classList.remove("is-visible");
  cookieModal.setAttribute("aria-hidden", "true");
  cookieError.hidden = true;
  cookieLimit.hidden = true;
  cookieStatus.hidden = true;
};

const checkConsent = async () => {
  try {
    const response = await fetch("/api/me");
    if (!response.ok) {
      throw new Error("status");
    }
    const data = await response.json();
    if (!data.hasId) {
      showCookieModal();
      setCookieStatus("No cookie ID detected yet. Tap “Allow Cookies” to create one.");
      return false;
    }
    hasConsent = true;
    hideCookieModal();
    return true;
  } catch (error) {
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
    if (!hasConsent) {
      cookieError.hidden = false;
    }
  } catch (error) {
    cookieError.hidden = false;
    setCookieStatus("Network error. Please try again.");
  }
};

allowCookiesButton.addEventListener("click", requestConsent);

const updateShakeState = (remaining) => {
  countdownButton.classList.remove("shake-subtle", "shake-medium", "shake-heavy");
  if (remaining <= 0 || remaining >= 31) {
    return;
  }
  if (remaining <= 5) {
    countdownButton.classList.add("shake-heavy");
  } else if (remaining <= 15) {
    countdownButton.classList.add("shake-medium");
  } else if (remaining <= 30) {
    countdownButton.classList.add("shake-subtle");
  }
};

const updateShellState = (remaining) => {
  const clamped = Math.max(0, Math.min(60, remaining));
  const progress = clamped / 60;
  const black = 1 - progress;
  const hue = Math.round(120 * progress);
  countdownButton.style.setProperty("--shell-black", black.toString());
  countdownButton.style.setProperty("--shell-hue", hue.toString());
};

const renderFrame = () => {
  if (!lastServerTime) {
    animationFrame = requestAnimationFrame(renderFrame);
    return;
  }
  const now = Date.now();
  const remaining = lastServerEndsAt
    ? Math.max(0, (lastServerEndsAt - now) / 1000)
    : Math.max(0, lastServerRemaining - (performance.now() - lastServerTime) / 1000);
  const displayValue = Math.ceil(remaining);
  countdownValue.textContent = displayValue;
  updateShellState(remaining);
  updateShakeState(displayValue);
  animationFrame = requestAnimationFrame(renderFrame);
};

const connectEvents = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    lastServerRemaining = data.remaining;
    lastServerEndsAt = data.endsAt ?? 0;
    lastServerTime = performance.now();
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
  await fetch("/api/click", { method: "POST" });
});

checkConsent().then(connectEvents);
