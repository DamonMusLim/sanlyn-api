// Shared helpers for straddle seal preview/confirm APIs.
// Kept local to api/stamp so the live tree can copy these files without touching existing stamp APIs.

import { extractUser } from '../auth.js';

export const OSS_BASE = 'https://files.sanlynos.com';
export const SEAL_DIAMETER_PT = 40 * 72 / 25.4;
export const DEFAULT_OPACITY = 0.85;

export function normalizeMode(mode) {
  return ['straddle', 'signature', 'both'].includes(mode) ? mode : 'both';
}

export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function dataUrlJpeg(buf) {
  return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64');
}

export function stampKeyForCompany(companyCode) {
  return 'straddle:' + String(companyCode || '').trim().toUpperCase();
}

export function resolvePageIndex(page, totalPages) {
  if (page === -1 || page == null) return totalPages - 1;
  const n = Number(page);
  if (!Number.isInteger(n)) return totalPages - 1;
  if (n >= 1 && n <= totalPages) return n - 1;
  if (n >= 0 && n < totalPages) return n;
  return totalPages - 1;
}

export function calcCustomPosition(cx, cy, pageW, pageH, sW, sH) {
  const x = Math.min(Math.max(clamp01(Number(cx)) * pageW - sW / 2, 0), pageW - sW);
  const y = Math.min(Math.max((1 - clamp01(Number(cy))) * pageH - sH / 2, 0), pageH - sH);
  return { x, y };
}

export async function resolveStampUrl(pool, stampKey, companyCode) {
  try {
    const cc = String(companyCode || stampKey || '').trim().toUpperCase();
    if (!cc) return null;
    const r = await pool.query(
      `SELECT url
         FROM customer_stamps
        WHERE upper(company_code)=upper($1)
          AND is_default=true
          AND is_active=true
        ORDER BY uploaded_at DESC
        LIMIT 1`,
      [cc]
    );
    const u = r.rows[0] && r.rows[0].url;
    if (u && /^https:\/\/(files\.sanlynos\.com|sanlyn-files\.[a-z0-9.-]*aliyuncs\.com)\//i.test(u)) return u;
  } catch (_) {}
  return null;
}

export async function checkPermission(pool, operator, stampKey) {
  const sql = `
    SELECT id, permission_type, doc_types, max_per_day
    FROM stamp_permissions
    WHERE granted_to = $1
      AND stamp_key = $2
      AND is_active = true
      AND (valid_until IS NULL OR valid_until > NOW())
    LIMIT 1
  `;
  const res = await pool.query(sql, [operator, stampKey]);
  return res.rows[0] || null;
}

export async function getTodayUsage(pool, operator, stampKey) {
  const sql = `
    SELECT COUNT(*) AS cnt
    FROM stamp_log
    WHERE operator = $1
      AND stamp_key = $2
      AND stamped_at >= CURRENT_DATE
  `;
  const res = await pool.query(sql, [operator, stampKey]);
  return parseInt(res.rows[0]?.cnt || '0', 10);
}

export function isAdminRequest(req) {
  let role = '';
  try {
    extractUser(req);
    role = (req.user && typeof req.user.role === 'string') ? req.user.role : '';
  } catch (_) {}
  return ['admin', 'superadmin', 'super_admin'].includes(role.toLowerCase());
}

export async function enforceStampPermission(req, pool, operator, stampKey) {
  if (isAdminRequest(req)) return null;
  const perm = await checkPermission(pool, operator, stampKey);
  if (!perm) {
    const err = new Error(`用户 ${operator} 未被授权使用 ${stampKey} 印章`);
    err.status = 403;
    err.code = 'NO_STAMP_PERMISSION';
    throw err;
  }
  const todayUsage = await getTodayUsage(pool, operator, stampKey);
  if (todayUsage >= perm.max_per_day) {
    const err = new Error(`已使用 ${todayUsage}/${perm.max_per_day} 次`);
    err.status = 429;
    err.code = 'STAMP_DAILY_LIMIT';
    throw err;
  }
  return perm;
}

export function buildPdfFetchUrl(pdfUrl) {
  let url = pdfUrl;
  if (url.startsWith('/')) {
    const port = process.env.PORT || 9000;
    url = 'http://127.0.0.1:' + port + url;
  }
  if (/\/api\/db\/shipping-plan-pdf/.test(url) && !url.includes('format=')) {
    url += (url.includes('?') ? '&' : '?') + 'format=pdf';
  }
  return url;
}

export async function fetchPdfBytes(pdfUrl, authHeader) {
  const url = buildPdfFetchUrl(pdfUrl);
  const headers = authHeader ? { Authorization: authHeader } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Failed to fetch PDF: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function fetchStampBytes(sealUrl) {
  const r = await fetch(sealUrl);
  if (!r.ok) throw new Error(`Failed to fetch stamp: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function uploadToOSS(ossPath, buffer, contentType = 'application/pdf') {
  const OSS = (await import('ali-oss')).default;
  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
  await client.put(ossPath, Buffer.from(buffer), { mime: contentType });
  return `${OSS_BASE}/${ossPath}`;
}

export function safeOriginalName(pdfUrl, documentId) {
  const raw = String(pdfUrl || '').split('?')[0].split('/').pop()?.replace(/\.pdf$/i, '') || documentId || 'doc';
  return String(raw).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'doc';
}

// Many customer_stamps source images are exported with extra blank canvas below/around the
// actual circular seal (e.g. BABI's is 378x532 — a ~378x392 circle plus ~140px of dead space).
// Forcing a non-square source into a square draw box (sW=sH) squashes the circle into an oval.
// This crops to the seal's real ink bounding box (ignoring small isolated specks/dust as noise
// via a gap-run heuristic, not just the naive alpha bbox) and pads it to a square canvas so the
// circle renders round regardless of the source image's own aspect ratio.
export async function squareCropStamp(buffer) {
  try {
    const sharp = (await import('sharp')).default;
    const img = sharp(buffer).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (!width || !height) return buffer;

    const ALPHA_THRESH = 40;
    const rowCount = new Array(height).fill(0);
    const colCount = new Array(width).fill(0);
    for (let y = 0; y < height; y++) {
      const rowBase = y * width * channels;
      for (let x = 0; x < width; x++) {
        if (data[rowBase + x * channels + 3] > ALPHA_THRESH) { rowCount[y]++; colCount[x]++; }
      }
    }

    let top = 0;
    while (top < height && rowCount[top] === 0) top++;
    if (top >= height) return buffer; // fully transparent image, nothing to crop

    // Walk down from the first content row; a long run of near-empty rows marks the end of the
    // real seal ink — anything after that (isolated specks/dust) is discarded as noise.
    const GAP_LEN = 15, NOISE_MAX = 1;
    let bottom = height - 1, run = 0;
    for (let y = top; y < height; y++) {
      if (rowCount[y] <= NOISE_MAX) {
        run++;
        if (run >= GAP_LEN) { bottom = y - run; break; }
      } else run = 0;
    }

    let left = 0;
    while (left < width && colCount[left] === 0) left++;
    let right = width - 1;
    while (right > left && colCount[right] === 0) right--;

    const cropW = right - left + 1;
    const cropH = bottom - top + 1;
    if (cropW <= 0 || cropH <= 0) return buffer;

    const cropped = await sharp(buffer).ensureAlpha().extract({ left, top, width: cropW, height: cropH }).toBuffer();
    const side = Math.max(cropW, cropH);
    const padX = Math.floor((side - cropW) / 2);
    const padY = Math.floor((side - cropH) / 2);

    return await sharp({
      create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: cropped, left: padX, top: padY }]).png().toBuffer();
  } catch (e) {
    console.warn('squareCropStamp failed, using original stamp image:', e.message);
    return buffer; // fail open — never block stamping over a cosmetic crop failure
  }
}

// Real ink stamps are never perfectly level — a small random tilt each time reads as authentic,
// a perfectly axis-aligned stamp every single time reads as an obviously-generated overlay.
export const SEAL_ROTATION_RANGE_DEG = 10;

export function randomSealRotationDeg() {
  return (Math.random() * 2 - 1) * SEAL_ROTATION_RANGE_DEG;
}

// pdf-lib's drawImage `rotate` option spins the image around the (x,y) anchor you pass — which is
// the box's bottom-left corner BEFORE rotation, not the image's own center. Left unadjusted, a
// rotated stamp visibly drifts away from the Y-coordinate we carefully computed (the empty-gap
// midpoint / signature block). This computes the anchor so the visual CENTER stays pinned at
// (cx, cy) in page point-space no matter the angle.
export function rotatedDrawParams(cx, cy, w, h, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const offX = (w / 2) * cos - (h / 2) * sin;
  const offY = (w / 2) * sin + (h / 2) * cos;
  return { x: cx - offX, y: cy - offY };
}

// ── Auto-generated "Damon 林" signature ──────────────────────────────────────
// Rendered from installed handwriting fonts (Reenie Beanie for the Latin name, Liu Jian Mao Cao
// for the Chinese character — both Google Fonts OFL, installed to
// /usr/share/fonts/truetype/custom/ on this host, see project_straddle_seal_blueprint memory).
// Not sourced from customer_stamps — this is a generated personal signature, not a company seal.
const SIGNATURE_LATIN_FONT = 'Reenie Beanie';
const SIGNATURE_CN_FONT = 'Liu Jian Mao Cao';
const SIGNATURE_COLOR = '#152a63';
export const SIGNATURE_ASPECT = 160 / 380; // height/width of the generated canvas below

export async function generateSignaturePng() {
  const sharp = (await import('sharp')).default;
  // Small per-render jitter so repeat signatures aren't pixel-identical, on top of the inherently
  // messy cursive fonts already doing most of the "潦草" work.
  const j1 = -5 + (Math.random() * 4 - 2);
  const j2 = 7 + (Math.random() * 4 - 2);
  const svg = `
  <svg width="380" height="160" xmlns="http://www.w3.org/2000/svg">
    <text x="10" y="95" font-family="${SIGNATURE_LATIN_FONT}" font-size="82" fill="${SIGNATURE_COLOR}"
      transform="rotate(${j1.toFixed(1)} 10 95)">Damon</text>
    <text x="230" y="105" font-family="${SIGNATURE_CN_FONT}" font-size="92" fill="${SIGNATURE_COLOR}"
      transform="rotate(${j2.toFixed(1)} 230 105)">林</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
