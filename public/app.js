let animationFrame = null;

const clickBoostDuration = 1000;
let clickBoostEndsAt = 0;
let isFinished = false;

/* ---------- Snake setup (guarded) ---------- */
let orbitLength = 0;
const segEls = [];
const SEGMENTS = 30;
const END_GAP = 10;
const SEG_OVERLAP = 10;
const SHELL_SIZE = 22;
const BODY_BASE = SHELL_SIZE * 0.78;
const TAIL_SCALE = 0.42;
const HEAD_SCALE = 1.0;

const initSnakeSegments = () => {
  if (!orbitMeasure || !snakeBody) return;
  orbitLength = orbitMeasure.getTotalLength();
  for (let i = 0; i < SEGMENTS; i += 1) {
    const segment = document.createElementNS("http://www.w3.org/2000/svg", "use");
    segment.setAttribute("href", "#orbit");
    segment.setAttribute("class", "body-seg");
    segment.style.opacity = "0";
    snakeBody.appendChild(segment);
    segEls.push(segment);
  }
};

initSnakeSegments();

/* ---------- Apply server time WITHOUT 1Hz snapping ---------- */
const applyServerRemaining = (remainingInt) => {
  if (isFinished) return;
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

/* ---------- Countdown UI updates (guarded) ---------- */
const RAINBOW = ["#FF0000", "#FF7A00", "#FFD400", "#00C853", "#00E5FF", "#2979FF", "#AA00FF"];

const hexToRgb = (hex) => {
  const cleaned = hex.replace("#", "");
  const value = Number.parseInt(cleaned, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
};

const lerpColor = (hexA, hexB, t) => {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const b2 = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${b2})`;
};

const rainbowAt = (progress01) => {
  const n = RAINBOW.length;
  if (progress01 <= 0) return RAINBOW[0];
  if (progress01 >= 1) return RAINBOW[n - 1];
  const scaled = progress01 * (n - 1);
  const i = Math.floor(scaled);
  const t = scaled - i;
  return lerpColor(RAINBOW[i], RAINBOW[i + 1], t);
};

const shakeLevel = (remainingSeconds) => {
  if (remainingSeconds <= 0) return 0;
  if (remainingSeconds <= 5) return 10;
  if (remainingSeconds <= 10) return 8;
  if (remainingSeconds <= 20) return 6;
  if (remainingSeconds <= 30) return 4;
  if (remainingSeconds <= 45) return 2;
  return 0;
};

const shakeTransform = (tsMs, level) => {
  if (level <= 0) return { x: 0, y: 0, r: 0 };
  const ampPx = level * 0.55;
  const ampDeg = level * 0.18;
  const t = tsMs / 1000;
  const x = (Math.sin(t * 37) + 0.6 * Math.sin(t * 53 + 1.3)) * ampPx * 0.55;
  const y = (Math.sin(t * 41 + 2.1) + 0.6 * Math.sin(t * 59 + 0.4)) * ampPx * 0.55;
  const r = Math.sin(t * 47 + 0.7) * ampDeg;
  return { x, y, r };
};

const applyShake = (remainingSeconds, nowMs) => {
  if (!countdownButton) return;
  if (isFinished) {
    countdownButton.style.transform = "translate(0px, 0px) rotate(0deg)";
    return;
  }
  const level = shakeLevel(remainingSeconds);
  const s = shakeTransform(nowMs, level);
  countdownButton.style.transform = `translate(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px) rotate(${s.r.toFixed(2)}deg)`;
};

const updateCoreDanger = (remainingSeconds) => {
  if (!countdownCore) return;
  countdownCore.classList.toggle("is-danger", remainingSeconds <= 10);
};

const setHeadAtLength = (length) => {
  if (!orbitMeasure || !snakeHead || !orbitLength) return;
  const pos = ((length % orbitLength) + orbitLength) % orbitLength;
  const p = orbitMeasure.getPointAtLength(pos);
  const p2 = orbitMeasure.getPointAtLength((pos + 1) % orbitLength);
  const angle = (Math.atan2(p2.y - p.y, p2.x - p.x) * 180) / Math.PI;
  snakeHead.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${angle})`);
};

const renderSnake = (progress01) => {
  if (!orbitLength || !snakeHeadShape) return;
  const headPos = progress01 * orbitLength;
  const targetBodyLen = Math.min(headPos, Math.max(0, orbitLength - END_GAP));
  const segLen = SEGMENTS ? targetBodyLen / SEGMENTS : 0;

  const snakeColor = rainbowAt(progress01);
  setHeadAtLength(headPos);

  const headBodyThickness = BODY_BASE * HEAD_SCALE;
  snakeHeadShape.setAttribute("rx", String(headBodyThickness * 0.95));
  snakeHeadShape.setAttribute("ry", String(headBodyThickness * 0.62));
  snakeHeadShape.setAttribute("fill", snakeColor);

  segEls.forEach((seg, index) => {
    const segStart = index * segLen;
    let len = Math.max(0, Math.min(segLen + SEG_OVERLAP, targetBodyLen - segStart));
    if (len <= 0.0001) {
      seg.style.opacity = "0";
      return;
    }
    const t = SEGMENTS === 1 ? 1 : index / (SEGMENTS - 1);
    const w = BODY_BASE * (TAIL_SCALE + t * (HEAD_SCALE - TAIL_SCALE));
    seg.style.strokeWidth = String(w);
    seg.style.stroke = snakeColor;
    seg.style.strokeDasharray = `${len} ${orbitLength}`;
    seg.style.strokeDashoffset = `${-segStart}`;
    seg.style.opacity = "1";
  });
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
  const nowMs = performance.now();
  const smoothRemaining = getSmoothRemaining();
  const displayRemaining = Math.max(0, Math.ceil(smoothRemaining));
  const clamped = Math.max(0, Math.min(countdownSeconds, smoothRemaining));
  const progress = isFinished ? 1 : 1 - clamped / countdownSeconds;

  setCountdownText(displayRemaining);
  updateCoreDanger(displayRemaining);
  applyShake(displayRemaining, nowMs);
  renderSnake(progress);
  if (!isFinished && displayRemaining <= 0) {
    isFinished = true;
    if (countdownButton) {
      countdownButton.classList.add("is-finished");
      countdownButton.style.transform = "translate(0px, 0px) rotate(0deg)";
    }
    if (countdownCore) {
      countdownCore.classList.add("is-danger");
    }
  }

  animationFrame = requestAnimationFrame(tickUI);
};

/* ---------- Click handler ---------- */
const postClick = async () => {
  if (isFinished) return;
  if (!hasConsent) {
    showCookieModal();
    setCookieStatus("Please allow cookies to use the site.");
    return;
  }
  // ...
};
