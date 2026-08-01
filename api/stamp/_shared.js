import { extractUser } from "../auth.js";

export const OSS_BASE = "https://files.sanlynos.com";
export const SEAL_DIAMETER_PT = 40 / 25.4 * 72;

export function normalizePdfFetchUrl(pdfUrl) {
  let url = pdfUrl;
  if (url.startsWith("/")) {
    const port = process.env.PORT || 9000;
    url = "http://127.0.0.1:" + port + url;
  }
  if (/\/api\/db\/documents/.test(url) && !url.includes("format=")) {
    url += (url.includes("?") ? "&" : "?") + "format=pdf";
  }
  if (/\/api\/db\/shipping-plan-pdf/.test(url) && !url.includes("format=")) {
    url += (url.includes("?") ? "&" : "?") + "format=pdf";
  }
  return url;
}

export async function fetchPdfBytes(pdfUrl, authHeader) {
  const url = normalizePdfFetchUrl(pdfUrl);
  const headers = authHeader ? { Authorization: authHeader } : {};
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error("Failed to fetch PDF: " + resp.status);
  return Buffer.from(await resp.arrayBuffer());
}

export async function resolveStampUrl(pool, companyCode) {
  const cc = String(companyCode || "").trim();
  if (!cc) return null;
  const r = await pool.query(
    `SELECT url
       FROM customer_stamps
      WHERE upper(company_code)=upper($1)
        AND is_default=true
        AND is_active=true
      LIMIT 1`,
    [cc]
  );
  const url = r.rows[0] && r.rows[0].url;
  if (url && /^https:\/\/(files\.sanlynos\.com|sanlyn-files\.[a-z0-9.-]*aliyuncs\.com)\//i.test(url)) return url;
  return null;
}

export async function fetchStampBytes(pool, companyCode) {
  const sealUrl = await resolveStampUrl(pool, companyCode);
  if (!sealUrl) {
    const err = new Error("公章未录入 DAS");
    err.status = 400;
    err.detail = `${companyCode || "company"} 的默认公章未在 DAS 上传或未启用`;
    throw err;
  }
  const resp = await fetch(sealUrl);
  if (!resp.ok) throw new Error("Failed to fetch stamp: " + resp.status);
  return { sealUrl, stampBuffer: Buffer.from(await resp.arrayBuffer()) };
}

export async function embedStampImage(pdfDoc, stampBuffer) {
  const sig = stampBuffer.subarray(0, 4).toString("hex");
  if (sig === "89504e47") return pdfDoc.embedPng(stampBuffer);
  if (stampBuffer[0] === 0xff && stampBuffer[1] === 0xd8) return pdfDoc.embedJpg(stampBuffer);
  return pdfDoc.embedPng(stampBuffer);
}

export async function uploadToOSS(ossPath, buffer, contentType = "application/pdf") {
  const OSS = (await import("ali-oss")).default;
  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
  await client.put(ossPath, Buffer.from(buffer), { mime: contentType });
  return `${OSS_BASE}/${ossPath}`;
}

export function calcCustomPosition(cx, cy, pageW, pageH, sW, sH) {
  const x = Math.min(Math.max(cx * pageW - sW / 2, 0), pageW - sW);
  const y = Math.min(Math.max((1 - cy) * pageH - sH / 2, 0), pageH - sH);
  return { x, y };
}

export async function checkStraddlePermission(pool, req, operator, stampKey) {
  let role = "";
  try {
    extractUser(req);
    role = req.user && typeof req.user.role === "string" ? req.user.role : "";
  } catch (_) {}
  if (["admin", "superadmin", "super_admin"].includes(role.toLowerCase())) return true;

  const perm = await pool.query(
    `SELECT id, max_per_day
       FROM stamp_permissions
      WHERE granted_to=$1
        AND stamp_key=$2
        AND is_active=true
        AND (valid_until IS NULL OR valid_until > NOW())
      LIMIT 1`,
    [operator, stampKey]
  );
  const row = perm.rows[0];
  if (!row) return false;
  const maxPerDay = Number(row.max_per_day || 0);
  if (!maxPerDay) return true;
  const usage = await pool.query(
    `SELECT COUNT(*) AS cnt
       FROM stamp_log
      WHERE operator=$1
        AND stamp_key=$2
        AND stamped_at >= CURRENT_DATE`,
    [operator, stampKey]
  );
  return Number(usage.rows[0]?.cnt || 0) < maxPerDay;
}
