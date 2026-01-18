const countdownButton = document.getElementById("countdown-button");
const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieStatus = document.getElementById("cookie-status");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");

let hasConsent = false;

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

const connectEvents = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    countdownButton.textContent = data.remaining;
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
