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

if (ringForeground) {
const radius = ringForeground.r.baseVal.value;
ringCircumference = 2 * Math.PI * radius;
ringForeground.style.strokeDasharray = `${ringCircumference} ${ringCircumference}`;
ringForeground.style.strokeDashoffset = "0";
}

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
if (!ringForeground || !ringCircumference) {
return;
}
const clamped = Math.max(0, Math.min(countdownSeconds, remaining));
const progress = Math.min(1, clamped / countdownSeconds);
const hue = Math.round(120 * progress);
const dash = ringCircumference * progress;
ringForeground.style.strokeDasharray = `${dash} ${ringCircumference}`;
countdownButton.style.setProperty("--shell-hue", hue.toString());
};

const getBoostedDisplayValue = (remaining) => {
if (remaining <= 0) {
return 0;
}
if (clickBoostEndsAt && performance.now() < clickBoostEndsAt) {
return countdownSeconds;
}
return Math.ceil(remaining);
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

const boostedRemaining =
clickBoostEndsAt && performance.now() < clickBoostEndsAt
? countdownSeconds
: remaining;

const displayValue = getBoostedDisplayValue(remaining);
countdownValue.textContent = displayValue;
countdownButton.disabled = remaining <= 0;
updateShellState(boostedRemaining);
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
if (countdownButton.disabled) {
return;
}
clickBoostEndsAt = performance.now() + clickBoostDuration;
await fetch("/api/click", { method: "POST" });
});

/* Router: URL changes, no reload */
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
