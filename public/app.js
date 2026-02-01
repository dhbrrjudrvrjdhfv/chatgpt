/* ================== DOM REFERENCES (FIX) ================== */
const orbitMeasure = document.getElementById("orbit-measure");
const snakeBody = document.getElementById("snake-body");
const snakeHead = document.getElementById("snake-head");
const snakeHeadShape = document.getElementById("snake-head-shape");
const countdownButton = document.getElementById("countdown-button");
const countdownValue = document.getElementById("countdown-value");
const countdownCore = document.querySelector(".countdown-core");

/* ================== STATE ================== */
let animationFrame = null;
let isFinished = false;

const countdownSeconds = 60;
let endsAtMs = performance.now() + countdownSeconds * 1000;
let lastServerRemainingInt = null;

/* ================== SNAKE CONFIG ================== */
let orbitLength = 0;
const segEls = [];
const SEGMENTS = 30;
const END_GAP = 10;
const SEG_OVERLAP = 10;
const SHELL_SIZE = 22;
const BODY_BASE = SHELL_SIZE * 0.78;
const TAIL_SCALE = 0.42;
const HEAD_SCALE = 1.0;

/* ================== INIT SNAKE ================== */
const initSnakeSegments = () => {
  if (!orbitMeasure || !snakeBody) return;

  orbitLength = orbitMeasure.getTotalLength();

  for (let i = 0; i < SEGMENTS; i++) {
    const seg = document.createElementNS("http://www.w3.org/2000/svg", "use");
    seg.setAttribute("href", "#orbit");
    seg.setAttribute("class", "body-seg");
    seg.style.opacity = "0";
    snakeBody.appendChild(seg);
    segEls.push(seg);
  }
};

initSnakeSegments();

/* ================== HELPERS ================== */
const getSmoothRemaining = () => {
  return Math.max(0, (endsAtMs - performance.now()) / 1000);
};

const setCountdownText = (value) => {
  if (!countdownValue) return;
  countdownValue.textContent = String(value);
};

/* ================== HEAD POSITION ================== */
const setHeadAtLength = (length) => {
  if (!orbitMeasure || !snakeHead || !orbitLength) return;

  const pos = ((length % orbitLength) + orbitLength) % orbitLength;
  const p = orbitMeasure.getPointAtLength(pos);
  const p2 = orbitMeasure.getPointAtLength((pos + 1) % orbitLength);
  const angle = Math.atan2(p2.y - p.y, p2.x - p.x) * 180 / Math.PI;

  snakeHead.setAttribute(
    "transform",
    `translate(${p.x} ${p.y}) rotate(${angle})`
  );
};

/* ================== RENDER SNAKE ================== */
const renderSnake = (progress01) => {
  if (!orbitLength || !snakeHeadShape) return;

  const headPos = progress01 * orbitLength;
  const targetBodyLen = Math.min(headPos, orbitLength - END_GAP);
  const segLen = targetBodyLen / SEGMENTS;

  setHeadAtLength(headPos);

  segEls.forEach((seg, i) => {
    const segStart = i * segLen;
    let len = Math.max(0, Math.min(segLen + SEG_OVERLAP, targetBodyLen - segStart));

    if (len <= 0) {
      seg.style.opacity = "0";
      return;
    }

    const t = i / (SEGMENTS - 1);
    const w = BODY_BASE * (TAIL_SCALE + t * (HEAD_SCALE - TAIL_SCALE));

    seg.style.strokeWidth = String(w);
    seg.style.strokeDasharray = `${len} ${orbitLength}`;
    seg.style.strokeDashoffset = `${-segStart}`;
    seg.style.opacity = "1";
  });
};

/* ================== ANIMATION LOOP ================== */
const tickUI = () => {
  const smoothRemaining = getSmoothRemaining();
  const displayRemaining = Math.ceil(smoothRemaining);
  const progress = 1 - smoothRemaining / countdownSeconds;

  setCountdownText(displayRemaining);
  renderSnake(progress);

  if (!isFinished && displayRemaining <= 0) {
    isFinished = true;
    countdownButton?.classList.add("is-finished");
  }

  animationFrame = requestAnimationFrame(tickUI);
};

tickUI();
