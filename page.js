// 여로 사진 올리기 페이지 (정적, 키 없음). 차의 도착 카드 QR → upload 함수 302 → 이 페이지(?t=토큰).
// 사진마다 EXIF 촬영 시각(없으면 파일 시각)을 읽고, 2048px·720px 두 장으로 줄여 한 장씩 보낸다.
import { exifDateTimeOriginal, exifToIso, fitWithin } from "./exif.js";

const API = "https://dghpdvpkgvamsaidndqa.supabase.co/functions/v1/upload";
const FULL_MAX = 2048;
const THUMB_MAX = 720;
const MAX_TILES = 48; // 미리보기 칸은 이만큼만 그린다(나머지는 "+N장" 한 칸)
const FRESH_MS = 60_000; // lastModified가 이보다 최근이면 "방금 만든 파일"로 보고 촬영 시각으로 쓰지 않는다

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("t") || "";
let info = null;
let files = [];
let busy = false;
let thumbUrls = []; // 그리드에 보이는 썸네일 object URL (새로 고를 때 revoke)

const MESSAGES = {
  expired: "이 QR은 기간(30일)이 지났어요",
  unknown_token: "이 QR은 여로에 등록되지 않았어요. 차의 카드에 있는 QR을 다시 찍어 주세요.",
  photo_limit: "이 여행에는 사진을 200장까지 올릴 수 있어요. 더는 올릴 수 없어요.",
  network: "인터넷에 연결되지 않았어요. 잠시 뒤에 다시 열어 주세요.",
};

function showError(code) {
  $("sub").hidden = true;
  $("form").hidden = true;
  $("error").textContent = MESSAGES[code] || MESSAGES.network;
  $("error").hidden = false;
}

function koreanDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  return m ? `${+m[1]}년 ${+m[2]}월 ${+m[3]}일 여행` : "여행";
}

function renderHeader() {
  $("title").textContent = `${info.dest_name || "여행"} 사진 올리기`;
  $("sub").textContent = `${koreanDate(info.started_on)} · 지금까지 ${info.count}장`;
}

async function loadInfo() {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return showError("unknown_token");
  let res;
  try {
    res = await fetch(`${API}?t=${encodeURIComponent(token)}&info=1`, { cache: "no-store" });
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
  renderHeader();
  $("form").hidden = false;
}

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

/** 사진 한 장 → {photo, thumb, w, h} 또는 null(열 수 없음). w·h는 방향이 적용된 2048px 결과의 크기. */
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
    return { photo: full.blob, thumb: thumb.blob, w: full.w, h: full.h };
  } catch {
    return null;
  } finally {
    img.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 한 장 보내기. 결과: "ok" | "bad" | "failed" | 멈춤 코드(expired, unknown_token, photo_limit) */
async function send(entry) {
  const file = entry.file;
  const ready = await prepare(file);
  if (!ready) return "bad";
  showThumb(entry, ready.thumb);
  const time = await takenAt(file);
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    form.append("photo", ready.photo, "photo.jpg");
    form.append("thumb", ready.thumb, "thumb.jpg");
    form.append("w", String(ready.w));
    form.append("h", String(ready.h));
    if (time.taken_at) form.append("taken_at", time.taken_at);
    form.append("taken_at_source", time.taken_at_source);
    let res;
    try {
      res = await fetch(`${API}?t=${encodeURIComponent(token)}`, { method: "POST", body: form });
    } catch {
      await sleep(2000);
      continue;
    }
    if (res.status === 201) {
      const body = await res.json().catch(() => null);
      if (body && typeof body.count === "number") info.count = body.count;
      else info.count += 1;
      return "ok";
    }
    if (res.status === 404) return "unknown_token";
    if (res.status === 410) return "expired";
    if (res.status === 415) return "bad";
    const body = await res.json().catch(() => ({}));
    if (body.error === "photo_limit") return "photo_limit";
    if (body.error === "rate_limited") {
      await sleep(30000); // 1분에 30장 제한: 잠시 쉬고 다시
      continue;
    }
    return "failed";
  }
  return "failed";
}

// 미리보기: 원본을 풀지 않는다. 처음에는 번호만 있는 빈 칸, 올리면서 만든 720px 썸네일로 바꾼다.
function renderGrid() {
  const shown = files.length > MAX_TILES ? MAX_TILES - 1 : files.length;
  const tiles = files.slice(0, shown).map((f, k) => {
    const li = document.createElement("li");
    li.className = "wait";
    const n = document.createElement("b");
    n.textContent = String(k + 1);
    li.append(n);
    f.el = li;
    return li;
  });
  if (shown < files.length) {
    const more = document.createElement("li");
    more.className = "more";
    more.textContent = `+${files.length - shown}장`;
    tiles.push(more);
  }
  $("grid").replaceChildren(...tiles);
}

function showThumb(f, blob) {
  if (!f.el) return;
  const url = URL.createObjectURL(blob);
  thumbUrls.push(url);
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  f.el.className = "";
  f.el.replaceChildren(img);
}

function clearFiles() {
  for (const url of thumbUrls) URL.revokeObjectURL(url);
  thumbUrls = [];
  files = [];
}

function mark(f, state) {
  if (!f.el) return;
  f.el.className = state;
  if (state === "bad" || state === "failed") {
    const span = document.createElement("span");
    span.textContent = state === "bad" ? "이 사진은 열 수 없어요" : "보내지 못했어요";
    f.el.append(span);
    f.el.className = "bad";
  }
}

function progress(done, total) {
  $("progress").hidden = false;
  $("barFill").style.width = `${Math.round((done / total) * 100)}%`;
  $("progressText").textContent = `${total}장 중 ${done}장`;
}

$("file").addEventListener("change", (e) => {
  if (busy) return;
  clearFiles();
  files = [...e.target.files].map((file) => ({ file, el: null }));
  $("done").hidden = true;
  $("progress").hidden = true;
  renderGrid();
  $("send").disabled = files.length === 0;
  $("send").textContent = files.length ? `${files.length}장 여로 앨범에 올리기` : "여로 앨범에 올리기";
});

$("send").addEventListener("click", async () => {
  if (busy || files.length === 0) return;
  busy = true;
  $("send").disabled = true;
  $("pick").hidden = true;
  const total = files.length;
  let sent = 0;
  let stop = null;
  progress(0, total);
  for (let k = 0; k < total; k++) {
    const result = await send(files[k]);
    if (result === "ok") sent++;
    if (result === "ok" || result === "bad" || result === "failed") {
      mark(files[k], result === "ok" ? "done" : result);
      renderHeader();
      progress(k + 1, total);
      continue;
    }
    stop = result;
    break;
  }
  busy = false;
  $("file").value = ""; // 같은 사진을 다시 골라도 change가 일어나게
  if (stop) return showError(stop);
  $("done").textContent = sent === total
    ? `${total}장 모두 보냈어요. 차가 앨범의 제자리에 넣을게요.`
    : `${total}장 중 ${sent}장을 보냈어요. 차가 앨범의 제자리에 넣을게요.`;
  $("done").hidden = false;
  $("pick").hidden = false;
  $("send").textContent = "여로 앨범에 올리기";
  files = []; // 썸네일은 그리드에 남겨 두고, URL은 다음에 고를 때 revoke한다

});

loadInfo();
