const countdownButton = document.getElementById("countdown-button");
const cookieModal = document.getElementById("cookie-modal");
const allowCookiesButton = document.getElementById("allow-cookies");
const cookieError = document.getElementById("cookie-error");
const cookieLimit = document.getElementById("cookie-limit");

let hasConsent = false;

const showCookieModal = () => {
  cookieModal.classList.add("is-visible");
  cookieModal.setAttribute("aria-hidden", "false");
};

const hideCookieModal = () => {
  cookieModal.classList.remove("is-visible");
  cookieModal.setAttribute("aria-hidden", "true");
  cookieError.hidden = true;
  cookieLimit.hidden = true;
};

const checkConsent = async () => {
  const response = await fetch("/api/me");
  const data = await response.json();
  if (!data.hasId) {
    showCookieModal();
    return false;
  }
  hasConsent = true;
  hideCookieModal();
  return true;
};

const requestConsent = async () => {
  cookieError.hidden = true;
  cookieLimit.hidden = true;
  const response = await fetch("/api/consent", { method: "POST" });
  if (response.status === 403) {
    cookieLimit.hidden = false;
    return;
  }
  if (!response.ok) {
    cookieError.hidden = false;
    return;
  }
  await checkConsent();
  if (!hasConsent) {
    cookieError.hidden = false;
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
