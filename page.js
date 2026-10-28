// 여로 사진 올리기 페이지 (정적, 키 없음). 차의 도착 카드 QR → upload 함수 302 → 이 페이지(?t=토큰).
// 사진마다 EXIF 촬영 시각(없으면 파일 시각)을 읽고, 2048px·720px 두 장으로 줄여 한 장씩 보낸다.
import { exifDateTimeOriginal, exifToIso, fitWithin } from "./exif.js";

const API = "https://dghpdvpkgvamsaidndqa.supabase.co/functions/v1/upload";
const FULL_MAX = 2048;
const THUMB_MAX = 720;

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("t") || "";
let info = null;
let files = [];
let busy = false;

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
  info = await res.json();
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
  if (file.lastModified > 0) return { taken_at: localIso(file.lastModified), taken_at_source: "file" };
  return { taken_at: "", taken_at_source: "none" };
}

function toJpeg(bitmap, max, quality) {
  const size = fitWithin(bitmap.width, bitmap.height, max);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, size.w, size.h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve({ blob: b, ...size }) : reject(new Error("toBlob"))), "image/jpeg", quality)
  );
}

/** 사진 한 장 → {photo, thumb, w, h} 또는 null(열 수 없음) */
async function prepare(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const full = await toJpeg(bitmap, FULL_MAX, 0.85);
    const thumb = await toJpeg(bitmap, THUMB_MAX, 0.8);
    return { photo: full.blob, thumb: thumb.blob, w: full.w, h: full.h };
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 한 장 보내기. 결과: "ok" | "bad" | "failed" | 멈춤 코드(expired, unknown_token, photo_limit) */
async function send(file) {
  const ready = await prepare(file);
  if (!ready) return "bad";
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

function renderGrid() {
  const grid = $("grid");
  grid.replaceChildren(...files.map((f) => {
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.alt = "";
    img.src = f.preview;
    li.append(img);
    f.el = li;
    return li;
  }));
}

function mark(f, state) {
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
  for (const f of files) URL.revokeObjectURL(f.preview);
  files = [...e.target.files].map((file) => ({ file, preview: URL.createObjectURL(file) }));
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
    const result = await send(files[k].file);
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
  if (stop) return showError(stop);
  $("done").textContent = sent === total
    ? `${total}장 모두 보냈어요. 차가 앨범의 제자리에 넣을게요.`
    : `${total}장 중 ${sent}장을 보냈어요. 차가 앨범의 제자리에 넣을게요.`;
  $("done").hidden = false;
  $("pick").hidden = false;
  $("send").textContent = "여로 앨범에 올리기";
  files = [];
});

loadInfo();
