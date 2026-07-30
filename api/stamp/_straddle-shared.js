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
