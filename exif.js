// JPEG EXIF 촬영 시각 읽기와 축소 크기 계산.
// 순수 JS: 브라우저(업로드 페이지)·Deno(upload 함수)·Node(테스트) 공용, 외부 의존 없음.

const SCAN_LIMIT = 64 * 1024;
const LOCAL_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

/** @param {ArrayBuffer | ArrayBufferView} buf */
function toView(buf) {
  if (ArrayBuffer.isView(buf)) {
    return new DataView(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, SCAN_LIMIT));
  }
  return new DataView(buf, 0, Math.min(buf.byteLength, SCAN_LIMIT));
}

/**
 * JPEG의 EXIF DateTimeOriginal(0x9003)과 OffsetTimeOriginal(0x9011)을 읽는다. 첫 64KB만 본다.
 * 없거나 깨졌으면 null (예외를 던지지 않는다).
 * @param {ArrayBuffer | ArrayBufferView} buf
 * @returns {{ local: string, offset: string | null } | null}
 */
export function exifDateTimeOriginal(buf) {
  try {
    return readJpeg(toView(buf));
  } catch {
    return null;
  }
}

/** @param {DataView} v */
function readJpeg(v) {
  if (v.byteLength < 4 || v.getUint8(0) !== 0xff || v.getUint8(1) !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= v.byteLength) {
    if (v.getUint8(i) !== 0xff) return null;
    const marker = v.getUint8(i + 1);
    if (marker === 0xff) { // 채움 바이트
      i += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // 이미지 데이터 시작: EXIF 없음
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // 길이 없는 마커
      i += 2;
      continue;
    }
    const len = v.getUint16(i + 2);
    if (len < 2) return null;
    const start = i + 4;
    const end = Math.min(i + 2 + len, v.byteLength);
    if (marker === 0xe1 && end - start >= 14 && isExifHeader(v, start)) {
      const found = readTiff(new DataView(v.buffer, v.byteOffset + start + 6, end - start - 6));
      if (found) return found;
    }
    i += 2 + len;
  }
  return null;
}

/** "Exif\0\0" */
function isExifHeader(v, at) {
  return v.getUint8(at) === 0x45 && v.getUint8(at + 1) === 0x78 && v.getUint8(at + 2) === 0x69 &&
    v.getUint8(at + 3) === 0x66 && v.getUint8(at + 4) === 0 && v.getUint8(at + 5) === 0;
}

/** @param {DataView} t TIFF 헤더부터 시작하는 보기 */
function readTiff(t) {
  const order = t.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  if (t.getUint16(2, le) !== 42) return null;
  const ifd0 = t.getUint32(4, le);
  const exifPtr = findEntry(t, ifd0, 0x8769, le);
  if (exifPtr === null) return null;
  const exifIfd = t.getUint32(exifPtr + 8, le);
  const dtoAt = findEntry(t, exifIfd, 0x9003, le);
  if (dtoAt === null) return null;
  const local = readAscii(t, dtoAt, le);
  if (local === null || !LOCAL_RE.test(local)) return null;
  const ofsAt = findEntry(t, exifIfd, 0x9011, le);
  const ofs = ofsAt === null ? null : readAscii(t, ofsAt, le);
  return { local, offset: ofs !== null && OFFSET_RE.test(ofs) ? ofs : null };
}

/** IFD에서 tag 항목의 위치(항목 시작 offset)를 찾는다. */
function findEntry(t, ifd, tag, le) {
  const count = t.getUint16(ifd, le);
  if (count > 1000) return null;
  for (let k = 0; k < count; k++) {
    const at = ifd + 2 + k * 12;
    if (t.getUint16(at, le) === tag) return at;
  }
  return null;
}

/** ASCII(type 2) 값을 NUL 앞까지 읽는다. 4바이트 이하는 항목 안에, 아니면 offset 위치에 있다. */
function readAscii(t, at, le) {
  if (t.getUint16(at + 2, le) !== 2) return null;
  const count = t.getUint32(at + 4, le);
  if (count === 0 || count > 64) return null;
  const from = count <= 4 ? at + 8 : t.getUint32(at + 8, le);
  let s = "";
  for (let k = 0; k < count; k++) {
    const c = t.getUint8(from + k);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * "2026:10:31 13:30:00" → "2026-10-31T13:30:00+09:00". EXIF에 오프셋이 있으면 그것을 쓴다.
 * @param {{ local: string, offset: string | null } | null | undefined} e
 * @param {string} [defaultOffset]
 * @returns {string | null}
 */
export function exifToIso(e, defaultOffset = "+09:00") {
  if (!e || typeof e.local !== "string") return null;
  const m = LOCAL_RE.exec(e.local);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (+y < 1900 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return null;
  const offset = e.offset && OFFSET_RE.test(e.offset) ? e.offset : defaultOffset;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
}

/**
 * 긴 변을 max 이하로 줄인 크기(비율 유지, 정수). 이미 작으면 그대로.
 * @param {number} w @param {number} h @param {number} max
 * @returns {{ w: number, h: number }}
 */
export function fitWithin(w, h, max) {
  const long = Math.max(w, h);
  if (long <= max) return { w, h };
  const scale = max / long;
  return w >= h
    ? { w: max, h: Math.max(1, Math.round(h * scale)) }
    : { w: Math.max(1, Math.round(w * scale)), h: max };
}
