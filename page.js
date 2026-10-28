// 여로 사진 올리기 페이지 (정적, 키 없음). 차의 도착 카드 QR → upload 함수 302 → 이 페이지(?t=토큰).
// 고르면 바로 보낸다: 사진을 한 장씩 풀어(메모리) 2048px·720px JPEG과 칸에 보일 작은 그림을 만들고,
// 세 장씩 동시에 올린다. 서버 제한(토큰당 1분에 30장)은 미리 맞춰 쉬고, 그래도 걸리면 기다렸다가 다시 보낸다.
// 다시 고르면 지금 고른 사진 뒤에 붙는다(바꾸지 않는다).
// 보낸 사진은 칸의 ✕로 다시 뺄 수 있다: 서버가 201로 준 지우기 열쇠(delete_key)를 메모리와 localStorage에 둔다.
import { exifDateTimeOriginal, exifToIso, fitWithin } from "./exif.js";

const API = "https://dghpdvpkgvamsaidndqa.supabase.co/functions/v1/upload";
const FULL_MAX = 2048;
const THUMB_MAX = 720;
const TILE_MAX = 300; // 칸에 보이는 그림(작게 따로 만들어 원본·720px을 오래 들고 있지 않는다)
const PARALLEL = 3;
const RATE_LIMIT = 30; // 서버: 토큰당 최근 60초에 30장
const RATE_WINDOW_MS = 60_000;
const RATE_MARGIN_MS = 1_500;
const SERVER_HOLD_MS = 20_000; // 그래도 rate_limited(다른 가족이 같이 올리는 중)면 이만큼 쉬고 다시
const MAX_RATE_HITS = 12;
const RETRIES = 2; // 일시 오류(연결 끊김·5xx)는 두 번 더 해 본다
const RETRY_DELAYS = [2_000, 6_000];
const BUFFER_BYTES = 40 * 1024 * 1024; // 만들어 두고 아직 못 보낸 JPEG의 합 상한(휴대폰 메모리)
const XHR_TIMEOUT_MS = 120_000;
const DEL_PREFIX = "yeoro.del."; // localStorage: yeoro.del.<token>.<photo id> → {"k": 지우기 열쇠, "at": ms}
const DEL_KEEP_MS = 40 * 24 * 3_600_000; // 링크는 30일 열려 있다. 그보다 오래된 열쇠는 버린다
const FRESH_MS = 60_000; // lastModified가 이보다 최근이면 "방금 만든 파일"로 보고 촬영 시각으로 쓰지 않는다

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("t") || "";
const uploadUrl = `${API}?t=${encodeURIComponent(token)}`;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

let info = null;
/** @type {Array<{n:number,file:File,key:string,state:string,ready:any,bytes:number,progress:number,tries:number,rateHits:number,el:HTMLElement,xhr:XMLHttpRequest|null,photoId?:string,deleteKey?:string,deleting?:boolean}>} */
const items = [];
let seq = 0;
let active = 0; // 올리는 중인 XHR 수
let sentAt = []; // 201을 받은 시각들(1분 창 계산)
let holdUntil = 0; // 서버가 rate_limited를 준 뒤 쉬는 끝 시각
let pumpTimer = 0;
let tickTimer = 0;
let preparing = false;
let stopped = null; // 멈춤 코드(expired·unknown_token)
let finishedShown = false;

// ---------- 시작: 여행 정보 ----------

const ERRORS = {
  expired: ["이 QR은 기간(30일)이 지났어요", "여행 사진은 차의 앨범에 그대로 남아 있어요."],
  unknown_token: ["이 QR은 여로에 등록되지 않았어요", "차의 카드에 있는 QR을 다시 찍어 주세요."],
  network: ["인터넷에 연결되지 않았어요", "잠시 뒤에 다시 열어 주세요."],
  full: ["이 여행 앨범이 가득 찼어요", "이 여행에는 사진을 200장까지 올릴 수 있어요."],
};

function showError(code) {
  const [title, body] = ERRORS[code] || ERRORS.network;
  $("errorTitle").textContent = title;
  $("errorBody").textContent = body;
  $("reload").hidden = code !== "network";
  $("error").hidden = false;
  $("app").hidden = true;
  $("dock").hidden = true;
  if (!info) $("trip").hidden = true;
  releaseWakeLock();
}

function koreanDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return "";
  const day = "일월화수목금토"[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${+m[1]}년 ${+m[2]}월 ${+m[3]}일 ${day}요일`;
}

function renderTrip() {
  $("trip").classList.remove("skeleton");
  $("dest").textContent = info.dest_name || "우리 가족 여행";
  $("date").textContent = koreanDate(info.started_on) || "여행";
  renderCount(false);
  const exp = new Date(info.expires_at || "");
  if (!isNaN(exp)) $("expiry").textContent = `이 링크는 ${exp.getMonth() + 1}월 ${exp.getDate()}일까지 열려 있어요.`;
  document.title = `${info.dest_name || "여행"} 사진 올리기 · 여로`;
}

function renderCount(bump) {
  $("count").hidden = false;
  $("countText").textContent = `지금까지 ${info.count}장`;
  if (bump && !reduceMotion) {
    const c = $("count");
    c.classList.remove("bump");
    void c.offsetWidth;
    c.classList.add("bump");
  }
}

async function loadInfo() {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return showError("unknown_token");
  let res;
  try {
    res = await fetch(`${uploadUrl}&info=1`, { cache: "no-store" });
  } catch {
    return showError("network");
  }
  if (res.status === 404) return showError("unknown_token");
  if (res.status === 410) return showError("expired");
  if (!res.ok) return showError("network");
  try {
    info = await res.json();
  } catch {
    return showError("network");
  }
  if (!info || typeof info !== "object") return showError("network");
  info.count = Number(info.count) || 0;
  info.max = Number(info.max) || 200;
  renderTrip();
  if (info.count >= info.max) return showError("full");
  $("app").hidden = false;
  $("dock").hidden = false;
}

// ---------- 사진 준비 (한 장씩) ----------

/** 휴대폰 지역 시각을 오프셋이 붙은 ISO로: 2026-10-31T13:30:00+09:00 */
function localIso(ms) {
  const d = new Date(ms);
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

async function takenAt(file) {
  try {
    const iso = exifToIso(exifDateTimeOriginal(await file.slice(0, 65536).arrayBuffer()), localIso(Date.now()).slice(-6));
    if (iso) return { taken_at: iso, taken_at_source: "exif" };
  } catch {
    // 아래로
  }
  // 방금 만들어진 파일(사진 앱이 고를 때 새로 내보낸 사본 등)의 시각은 촬영 시각이 아니다.
  const lm = file.lastModified;
  if (lm > 0 && Math.abs(Date.now() - lm) > FRESH_MS) return { taken_at: localIso(lm), taken_at_source: "file" };
  return { taken_at: "", taken_at_source: "none" };
}

/** iOS/Safari(WebKit) 버전을 1604(=16.4) 꼴로. WebKit이 아니면 null. */
function webkitVersion() {
  const ua = navigator.userAgent;
  let m = /(?:iPhone|CPU) OS (\d+)_(\d+)/.exec(ua); // iOS는 모든 브라우저가 WebKit
  if (m) return +m[1] * 100 + +m[2];
  if (/Chrome\/|Chromium|Firefox\//.test(ua)) return null;
  m = /Version\/(\d+)\.(\d+).*Safari/.exec(ua);
  return m ? +m[1] * 100 + +m[2] : null;
}
// 옛 WebKit(16.4 이전)의 createImageBitmap은 EXIF 방향을 무시하거나 Blob을 못 받는다 → <img>로 푼다.
const OLD_WEBKIT = (() => {
  const v = webkitVersion();
  return v !== null && v < 1604;
})();

/** <img>로 풀기: 브라우저가 EXIF 방향을 적용한다(image-orientation 기본값 from-image). */
async function decodeWithImg(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    if (img.decode) await img.decode();
    else await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  if (!img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new Error("decode");
  }
  return {
    source: img,
    width: img.naturalWidth, // 방향이 적용된 크기
    height: img.naturalHeight,
    close: () => { img.src = ""; URL.revokeObjectURL(url); },
  };
}

/** 사진 풀기 → {source, width, height, close}. 방향은 EXIF대로 적용된 상태. */
async function decode(file) {
  if (!OLD_WEBKIT && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {
      // 아래 <img> 경로로
    }
  }
  return decodeWithImg(file);
}

function toJpeg(img, max, quality) {
  const size = fitWithin(img.width, img.height, max);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img.source, 0, 0, size.w, size.h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => {
      canvas.width = canvas.height = 0; // iOS 캔버스 메모리를 바로 돌려준다
      if (b) resolve({ blob: b, ...size });
      else reject(new Error("toBlob"));
    }, "image/jpeg", quality)
  );
}

/** 사진 한 장 → {photo, thumb, tile, w, h, time} 또는 null(열 수 없음). w·h는 방향이 적용된 2048px 결과의 크기. */
async function prepare(file) {
  let img;
  try {
    img = await decode(file);
  } catch {
    return null;
  }
  try {
    const full = await toJpeg(img, FULL_MAX, 0.85);
    const thumb = await toJpeg(img, THUMB_MAX, 0.8);
    const tile = await toJpeg(img, TILE_MAX, 0.72);
    return { photo: full.blob, thumb: thumb.blob, tile: tile.blob, w: full.w, h: full.h, time: await takenAt(file) };
  } catch {
    return null;
  } finally {
    img.close();
  }
}

const buffered = () => items.reduce((s, it) => s + (it.ready ? it.bytes : 0), 0);

async function prepLoop() {
  if (preparing) return;
  preparing = true;
  try {
    while (!stopped && buffered() < BUFFER_BYTES) {
      const it = items.find((i) => i.state === "queued");
      if (!it) break;
      setState(it, "preparing");
      updateStatus();
      const ready = await prepare(it.file);
      if (stopped) break;
      if (!ready) {
        setState(it, "bad");
        continue;
      }
      showTile(it, ready.tile);
      ready.tile = null;
      it.ready = ready;
      it.bytes = ready.photo.size + ready.thumb.size;
      if (it.state === "preparing") setState(it, "ready");
      pump();
      await new Promise((r) => setTimeout(r, 0)); // 화면이 그릴 틈
    }
  } finally {
    preparing = false;
  }
  updateStatus();
}

// ---------- 보내기 (세 장씩, 1분 30장 맞추기) ----------

/** 지금 하나 더 보내도 되면 0, 아니면 기다릴 ms */
function rateWait() {
  const now = Date.now();
  if (holdUntil > now) return holdUntil - now;
  sentAt = sentAt.filter((t) => now - t < RATE_WINDOW_MS + RATE_MARGIN_MS);
  const used = sentAt.length + active;
  if (used < RATE_LIMIT) return 0;
  const k = used - RATE_LIMIT; // 이 번째로 오래된 기록이 창을 벗어나야 한 자리가 난다
  if (k >= sentAt.length) return 1_000;
  return Math.max(250, sentAt[k] + RATE_WINDOW_MS + RATE_MARGIN_MS - now);
}

function pump() {
  clearTimeout(pumpTimer);
  pumpTimer = 0;
  if (stopped) return;
  while (active < PARALLEL) {
    const it = items.find((i) => i.state === "ready");
    if (!it) break;
    const wait = rateWait();
    if (wait > 0) {
      pumpTimer = setTimeout(pump, wait);
      break;
    }
    send(it);
  }
  updateStatus();
}

function post(it, form) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    it.xhr = x;
    x.open("POST", uploadUrl);
    x.timeout = XHR_TIMEOUT_MS;
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) setProgress(it, e.loaded / e.total);
    };
    x.onload = () => {
      let body = null;
      try {
        body = JSON.parse(x.responseText);
      } catch {
        // 본문 없음
      }
      resolve({ status: x.status, body });
    };
    x.onerror = x.ontimeout = x.onabort = () => resolve({ status: 0, body: null });
    x.send(form);
  });
}

async function send(it) {
  active++;
  setState(it, "uploading");
  setProgress(it, 0);
  const r = it.ready;
  const form = new FormData();
  form.append("photo", r.photo, "photo.jpg");
  form.append("thumb", r.thumb, "thumb.jpg");
  form.append("w", String(r.w));
  form.append("h", String(r.h));
  if (r.time.taken_at) form.append("taken_at", r.time.taken_at);
  form.append("taken_at_source", r.time.taken_at_source);
  const { status, body } = await post(it, form);
  it.xhr = null;
  active--;
  if (stopped) return;
  const err = body && body.error;

  if (status === 201) {
    sentAt.push(Date.now());
    it.ready = null;
    it.bytes = 0;
    setState(it, "done");
    info.count = body && typeof body.count === "number" ? body.count : info.count + 1;
    renderCount(true);
    if (body && typeof body.id === "string" && typeof body.delete_key === "string") {
      it.photoId = body.id;
      it.deleteKey = body.delete_key;
      rememberKey(it.photoId, it.deleteKey);
      it.el.parentNode.classList.add("can-del");
      $("undo").hidden = false;
    }
  } else if (status === 404 || status === 410) {
    return stop(status === 404 ? "unknown_token" : "expired");
  } else if (status === 415 || status === 413) {
    it.ready = null;
    setState(it, "bad");
  } else if (status === 429 && err === "photo_limit") {
    setState(it, "ready");
    albumFull();
  } else if (status === 429 && err === "rate_limited" && ++it.rateHits <= MAX_RATE_HITS) {
    // 다른 가족도 같은 링크로 올리는 중일 수 있다: 모두 잠깐 쉬고 같은 사진을 다시 보낸다
    holdUntil = Math.max(holdUntil, Date.now() + SERVER_HOLD_MS);
    setState(it, "ready");
  } else if (it.tries < RETRIES) {
    // 연결 끊김·시간 초과·서버 오류: 잠깐 뒤에 다시
    const delay = RETRY_DELAYS[it.tries++];
    setState(it, "waiting");
    setTimeout(() => {
      if (it.state === "waiting") {
        setState(it, "ready");
        pump();
      }
    }, delay);
  } else {
    setState(it, "failed");
  }
  pump();
  prepLoop();
}

function retry(it) {
  if (it.state !== "failed" || stopped) return;
  it.tries = 0;
  it.rateHits = 0;
  finishedShown = false;
  setState(it, it.ready ? "ready" : "queued");
  acquireWakeLock();
  pump();
  prepLoop();
}

/** 여행당 200장이 찼다: 아직 못 보낸 사진은 자리가 없다고 표시하고 멈춘다 */
function albumFull() {
  for (const it of items) {
    if (["queued", "preparing", "ready", "waiting", "failed"].includes(it.state)) {
      it.ready = null;
      setState(it, "noroom");
    }
  }
}

function stop(code) {
  stopped = code;
  for (const it of items) it.xhr?.abort();
  clearTimeout(pumpTimer);
  showError(code);
}

// ---------- 고르기 ----------

function roomLeft() {
  const pending = items.filter((i) => !["done", "bad", "noroom"].includes(i.state)).length;
  return info.max - info.count - pending;
}

function addFiles(files) {
  if (!files.length || stopped) return;
  const known = new Set(items.map((i) => i.key));
  let dup = 0;
  const fresh = [];
  for (const file of files) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (known.has(key)) {
      dup++;
      continue;
    }
    known.add(key);
    fresh.push({ file, key });
  }
  const room = Math.max(0, roomLeft());
  const over = Math.max(0, fresh.length - room);
  const take = fresh.slice(0, room);

  const frag = document.createDocumentFragment();
  for (const { file, key } of take) {
    const it = { n: ++seq, file, key, state: "queued", ready: null, bytes: 0, progress: 0, tries: 0, rateHits: 0, el: null, xhr: null };
    it.el = makeTile(it);
    items.push(it);
    frag.append(it.el.parentNode);
  }
  $("grid").append(frag);
  $("empty").hidden = true;
  $("lead").hidden = true;
  finishedShown = false;
  $("finish").hidden = true;

  const notes = [];
  if (over) notes.push(`이 여행에는 사진을 ${info.max}장까지 올릴 수 있어서 ${over}장은 뺐어요.`);
  if (dup) notes.push(`이미 고른 사진 ${dup}장은 한 번만 보내요.`);
  if (notes.length) toast(notes.join(" "), 4200);
  if (take.length) {
    acquireWakeLock();
    prepLoop();
  }
  updateStatus();
}

function openPicker() {
  if (stopped) return;
  const input = $("file");
  input.value = ""; // 같은 사진을 다시 골라도 change가 일어나게
  input.click();
}

$("pick").addEventListener("click", openPicker);
$("empty").addEventListener("click", openPicker);
$("empty").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openPicker();
  }
});
$("file").addEventListener("change", (e) => {
  const picked = Array.from(e.target.files || []); // 값을 비우기 전에 먼저 복사한다
  e.target.value = "";
  addFiles(picked);
});

// ---------- 칸 ----------

const RING_C = 113.1; // 2πr, r = 18

function makeTile(it) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tile queued";
  b.setAttribute("aria-label", `사진 ${it.n}, 기다리는 중`);
  b.innerHTML =
    '<img alt="" decoding="async"><span class="veil"></span>' +
    '<svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="track" cx="22" cy="22" r="18"/><circle class="arc" cx="22" cy="22" r="18"/></svg>' +
    '<span class="check" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
    '<span class="badge" aria-hidden="true"></span>';
  if (!reduceMotion) b.style.animationDelay = `${Math.min(items.length % 12, 11) * 25}ms`;
  b.addEventListener("click", () => retry(it));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.setAttribute("aria-label", `사진 ${it.n} 빼기`);
  del.innerHTML = '<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg></span>';
  del.addEventListener("click", () => askDelete(it));
  li.append(b, del);
  return b;
}

function showTile(it, blob) {
  const img = it.el.querySelector("img");
  img.onload = () => it.el.classList.add("has-img");
  img.src = URL.createObjectURL(blob); // 작은 그림(≈20KB)이라 페이지가 열려 있는 동안 둔다
}

const LABEL = {
  queued: "기다리는 중", preparing: "준비하는 중", ready: "곧 보내요", uploading: "보내는 중", waiting: "잠깐 쉬는 중",
  done: "보냈어요", failed: "보내지 못했어요. 누르면 다시 보내요", bad: "열 수 없는 사진", noroom: "자리가 없어요",
};

function setState(it, state) {
  it.state = state;
  const el = it.el;
  const keep = el.classList.contains("has-img");
  el.className = `tile ${state === "ready" ? "queued" : state}${keep ? " has-img" : ""}`;
  el.setAttribute("aria-label", `사진 ${it.n}, ${LABEL[state]}`);
  el.disabled = state !== "failed";
  const badge = el.querySelector(".badge");
  if (state === "failed") {
    badge.innerHTML =
      '<span class="icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>다시 보내기';
  } else if (state === "bad") {
    badge.textContent = "열 수 없는 사진";
  } else if (state === "noroom") {
    badge.textContent = "자리가 없어요";
  } else if (badge.firstChild) {
    badge.textContent = "";
  }
  if (state === "done") setRing(it, 1);
}

function setProgress(it, f) {
  it.progress = f;
  setRing(it, f * 0.92); // 다 올라가도 서버 답을 받을 때까지는 조금 남겨 둔다
  scheduleStatus();
}

function setRing(it, f) {
  const arc = it.el.querySelector(".arc");
  arc.style.strokeDashoffset = String(RING_C * (1 - Math.max(0, Math.min(1, f))));
}

// ---------- 보낸 사진 빼기 ----------

function rememberKey(id, key) {
  try {
    localStorage.setItem(`${DEL_PREFIX}${token}.${id}`, JSON.stringify({ k: key, at: Date.now() }));
  } catch {
    // 저장소가 없거나 막혀 있어도 이 화면이 열려 있는 동안은 뺄 수 있다
  }
}

function forgetKey(id) {
  try {
    localStorage.removeItem(`${DEL_PREFIX}${token}.${id}`);
  } catch {
    // 무시
  }
}

function storedKey(id) {
  try {
    const v = JSON.parse(localStorage.getItem(`${DEL_PREFIX}${token}.${id}`) || "null");
    return v && typeof v.k === "string" ? v.k : "";
  } catch {
    return "";
  }
}

/** 링크 기간이 지나 쓸 일이 없는 열쇠를 지운다 */
function pruneKeys() {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DEL_PREFIX)) continue;
      let at = 0;
      try {
        at = Number(JSON.parse(localStorage.getItem(k) || "{}").at) || 0;
      } catch {
        at = 0;
      }
      if (!(now - at < DEL_KEEP_MS)) localStorage.removeItem(k);
    }
  } catch {
    // 무시
  }
}

let asking = null; // 지금 "뺄까요?"를 묻고 있는 사진

function closeAsk() {
  if (!asking) return;
  const li = asking.el.parentNode;
  li.classList.remove("asking");
  li.querySelector(".confirm")?.remove();
  asking = null;
}

function askDelete(it) {
  if (it.deleting || it.state !== "done") return;
  closeAsk();
  asking = it;
  const li = it.el.parentNode;
  li.classList.add("asking");
  const box = document.createElement("div");
  box.className = "confirm";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", "이 사진을 뺄까요?");
  box.innerHTML = '<p>이 사진을<br>뺄까요?</p><div class="row"><button type="button" class="yes">빼기</button><button type="button" class="no">취소</button></div>';
  box.querySelector(".yes").addEventListener("click", () => removePhoto(it, box));
  box.querySelector(".no").addEventListener("click", () => {
    closeAsk();
    li.querySelector(".del")?.focus();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAsk();
  });
  li.append(box);
  box.querySelector(".no").focus({ preventScroll: true });
}

async function removePhoto(it, box) {
  if (it.deleting) return;
  const key = it.deleteKey || storedKey(it.photoId);
  it.deleting = true;
  box.querySelectorAll("button").forEach((b) => (b.disabled = true));
  box.querySelector("p").textContent = "빼는 중…";
  let status = 0;
  try {
    const res = await fetch(`${uploadUrl}&id=${encodeURIComponent(it.photoId)}`, {
      method: "DELETE",
      headers: { "x-yeoro-delete": key },
      cache: "no-store",
    });
    status = res.status;
  } catch {
    status = 0;
  }
  it.deleting = false;
  if (status === 204 || status === 404) { // 404: 차에서 이미 뺐다
    closeAsk();
    forgetKey(it.photoId);
    if (info.count > 0) info.count--;
    renderCount(true);
    dropTile(it);
    toast("사진을 뺐어요.");
    return;
  }
  closeAsk();
  if (status === 410) toast("이 링크는 기간이 지나서 여기서는 뺄 수 없어요. 차에서 빼 주세요.", 4200);
  else if (status === 403) toast("이 사진은 여기서 뺄 수 없어요. 차에서 빼 주세요.", 4200);
  else toast("빼지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.", 4200);
}

/** 칸을 작게 줄이며 없애고, 뒤 칸들은 제자리로 미끄러지게 한다(FLIP). */
function dropTile(it) {
  const li = it.el.parentNode;
  const after = [];
  for (let n = li.nextElementSibling; n; n = n.nextElementSibling) after.push(n);
  const finish = () => {
    const before = after.map((n) => n.getBoundingClientRect());
    li.remove();
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
    if (!reduceMotion) {
      after.forEach((n, k) => {
        const r = n.getBoundingClientRect();
        const dx = before[k].left - r.left;
        const dy = before[k].top - r.top;
        if (!dx && !dy) return;
        n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2, .8, .2, 1)" });
      });
    }
    afterRemoval();
  };
  if (reduceMotion) return finish();
  li.classList.add("leaving");
  const onEnd = (e) => {
    if (e.target !== li) return; // 안쪽 칸의 움직임이 끝난 것은 건너뛴다
    li.removeEventListener("animationend", onEnd);
    finish();
  };
  li.addEventListener("animationend", onEnd);
}

function afterRemoval() {
  $("undo").hidden = !items.some((i) => i.deleteKey);
  if (!items.length) {
    // 다 뺐다: 처음 화면으로
    $("status").hidden = true;
    $("finish").hidden = true;
    finishedShown = false;
    $("empty").hidden = false;
    $("lead").hidden = false;
    $("pickLabel").textContent = "사진 고르기";
    return;
  }
  if (!isBusy() && !$("finish").hidden) {
    showFinish({ done: count("done"), bad: count("bad"), noroom: count("noroom"), failed: count("failed") }, true);
  }
}

// ---------- 위 진행 상황 · 끝 ----------

let statusQueued = false;
function scheduleStatus() {
  if (statusQueued) return;
  statusQueued = true;
  requestAnimationFrame(() => {
    statusQueued = false;
    updateStatus();
  });
}

const count = (state) => items.reduce((s, i) => s + (i.state === state ? 1 : 0), 0);
const BUSY = ["queued", "preparing", "ready", "uploading", "waiting"];

function updateStatus() {
  if (!items.length || stopped) return;
  const done = count("done");
  const bad = count("bad");
  const noroom = count("noroom");
  const failed = count("failed");
  const total = items.length - bad - noroom;
  const busy = items.some((i) => BUSY.includes(i.state));
  const inflight = items.reduce((s, i) => s + (i.state === "uploading" ? i.progress * 0.92 : 0), 0);

  $("status").hidden = !busy; // 끝나면 아래 끝 카드가 대신 말한다
  $("pickLabel").textContent = "더 고르기";
  const pct = total ? Math.min(100, Math.round(((done + inflight) / total) * 100)) : 100;
  $("barFill").style.width = `${pct}%`;
  $("statusPct").textContent = `${pct}%`;
  $("statusTitle").innerHTML = total
    ? `${total}장 중 <em>${done}장</em> 보냈어요`
    : "보낼 수 있는 사진이 없어요";

  let hint = "";
  let wait = false;
  if (busy) {
    const w = active === 0 && items.some((i) => i.state === "ready") ? rateWait() : 0;
    if (w > 1500) {
      wait = true;
      hint = `사진이 많아서 잠깐 숨을 고르는 중이에요. ${Math.ceil(w / 1000)}초 뒤에 이어서 보내요.`;
    } else if (!navigator.onLine) {
      wait = true;
      hint = "인터넷 연결을 기다리고 있어요.";
    } else {
      hint = "보내는 동안 이 화면을 켜 두세요. 더 골라도 뒤에 이어서 보내요.";
    }
  } else if (failed) {
    hint = `${failed}장은 보내지 못했어요. 사진을 누르면 다시 보내요.`;
  }
  $("statusHint").textContent = hint;
  $("statusHint").hidden = !hint;
  $("statusHint").classList.toggle("wait", wait);

  // 쉬는 동안 남은 초를 세어 준다
  if (busy && !tickTimer) tickTimer = setInterval(updateStatus, 1_000);
  if (!busy && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  if (busy) {
    $("finish").hidden = true;
    finishedShown = false;
  } else if (!finishedShown) {
    finishedShown = true;
    showFinish({ done, bad, noroom, failed });
    releaseWakeLock();
  }
}

const CHECK_SVG = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ALERT_SVG = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function showFinish({ done, bad, noroom, failed }, quiet = false) {
  const box = $("finish");
  const extra = [];
  if (bad) extra.push(`열 수 없는 사진 ${bad}장은 빼고 보냈어요.`);
  if (noroom) extra.push(`이 여행에는 사진을 ${info.max}장까지 올릴 수 있어서 ${noroom}장은 못 보냈어요.`);
  box.classList.toggle("partial", failed > 0);
  if (failed) {
    $("finishIcon").innerHTML = ALERT_SVG;
    $("finishTitle").textContent = done ? `${done}장을 보냈어요` : "아직 보내지 못했어요";
    $("finishBody").textContent = [`${failed}장은 보내지 못했어요. 인터넷이 잘 되는 곳에서 다시 보내 주세요.`, ...extra].join(" ");
  } else {
    $("finishIcon").innerHTML = CHECK_SVG;
    $("finishTitle").textContent = done ? "다 보냈어요!" : "보낸 사진이 없어요";
    $("finishBody").textContent = done
      ? [`${done}장이 여행 앨범으로 갔어요. 차가 앨범의 제자리에 넣을게요.`, ...extra].join(" ")
      : extra.join(" ") || "다른 사진을 골라 주세요.";
  }
  $("retryAll").hidden = failed === 0;
  if (quiet) return; // 사진을 뺀 뒤 글만 고친다(다시 튀어나오지 않게)
  box.querySelectorAll(".spark").forEach((s) => s.remove());
  if (!failed && done && !reduceMotion) sparkle(box);
  box.hidden = false;
  // 다시 그리면 들어오는 움직임이 다시 돈다
  box.style.animation = "none";
  void box.offsetWidth;
  box.style.animation = "";
  const top = box.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight - 200) box.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

function sparkle(box) {
  const colors = ["#FFB46A", "#FFCF9A", "#F4F1EA", "#FF9F4A"];
  for (let k = 0; k < 14; k++) {
    const s = document.createElement("i");
    s.className = "spark";
    const a = (k / 14) * Math.PI * 2;
    const r = 70 + (k % 3) * 22;
    s.style.left = "50%";
    s.style.top = "58px";
    s.style.background = colors[k % colors.length];
    s.style.setProperty("--dx", `${Math.round(Math.cos(a) * r)}px`);
    s.style.setProperty("--dy", `${Math.round(Math.sin(a) * r * 0.7)}px`);
    s.style.animationDelay = `${150 + (k % 4) * 40}ms`;
    box.append(s);
  }
}

$("retryAll").addEventListener("click", () => {
  for (const it of items) if (it.state === "failed") retry(it);
});

// ---------- 가족에게 링크 보내기 ----------

function shareLink() {
  return `${location.origin}${location.pathname}?t=${encodeURIComponent(token)}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-1000px;top:0;opacity:0";
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

$("share").addEventListener("click", async () => {
  const url = shareLink();
  const dest = (info && info.dest_name) || "우리 가족";
  const data = {
    title: `${dest} 여행 사진 올리기`,
    text: `${dest} 여행에서 찍은 사진을 여기에 올려 주세요. 차가 여행 앨범에 넣어 줘요.`,
    url,
  };
  if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // 사용자가 닫았다
    }
  }
  if (await copyText(url)) toast("링크를 복사했어요. 카카오톡 대화창에 붙여 넣어 주세요.");
  else toast(url, 6000);
});

let toastTimer = 0;
function toast(text, ms = 2800) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), ms);
}

// ---------- 화면 켜 두기 · 떠나기 경고 ----------

let wakeLock = null;
async function acquireWakeLock() {
  try {
    if (!wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch {
    // 무시
  }
  wakeLock = null;
}
const isBusy = () => items.some((i) => BUSY.includes(i.state));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isBusy()) {
    acquireWakeLock();
    pump();
  }
});
addEventListener("online", () => pump());
addEventListener("beforeunload", (e) => {
  if (isBusy() && !stopped) {
    e.preventDefault();
    e.returnValue = "";
  }
});

$("reload").addEventListener("click", () => location.reload());

pruneKeys();
loadInfo();
