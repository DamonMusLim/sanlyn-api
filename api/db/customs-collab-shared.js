// api/db/customs-collab-shared.js — shared toolkit (auth, rate-limit, factory resolvers)
// split out of customs-collab.js (2026-07-14, ≤500-line rule). No handlers here.
import crypto from "crypto";
import { requireAuth } from "../auth.js";
import { cleanString } from "./factory-portal-utils.js";
import { ensureCustomsStatus } from "./customs-collab-status.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 30;
const rateBuckets = new Map();

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function failClosed(res) {
  return json(res, 401, { error: "链接无效或已过期" });
}

function requireFinance(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!FINANCE_ROLES.has(req.user?.role)) {
    res.status(403).json({ error: "Forbidden", message: "仅财务/管理员可操作" });
    return false;
  }
  return true;
}

function parseMonth(v) {
  const s = cleanString(v);
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12 ? s : null;
}

function addMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function rangeFromQuery(q) {
  const now = new Date();
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = parseMonth(q.from) || cur;
  const to = parseMonth(q.to) || from;
  if (from > to) return null;
  return { from, to, start: `${from}-01`, end: addMonth(to) };
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return xf ? String(xf).split(",")[0].trim() : (req.socket?.remoteAddress || req.ip || "unknown");
}

function rateLimit(req, key) {
  const k = `${key || "-"}:${clientIp(req)}`;
  const now = Date.now();
  const hit = rateBuckets.get(k);
  if (!hit || now - hit.start > RATE_WINDOW_MS) {
    rateBuckets.set(k, { start: now, count: 1 });
    return true;
  }
  hit.count += 1;
  return hit.count <= RATE_MAX;
}

function normalizeSellerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）【】\[\]{}《》<>]/g, "")
    .replace(/[·.,，。;；:：'"“”‘’_-]/g, "")
    .replace(/有限责任公司|股份有限公司|有限公司|公司|工厂|厂/g, "");
}

function sellerNameMatches(expected, actual) {
  const a = normalizeSellerName(expected);
  const b = normalizeSellerName(actual);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

async function getFactoryInfo(pool, code) {
  const r = await pool.query(
    `SELECT code, name_cn, name_en, factory_name FROM companies WHERE code=$1 LIMIT 1`,
    [code]
  );
  const row = r.rows[0];
  if (!row?.code) return { code, name: code };
  return { code: row.code, name: row.name_cn || row.factory_name || row.name_en || row.code };
}

async function resolveFactoryScope(pool, code) {
  if (!code) return null;
  const r = await pool.query(
    `SELECT code, scope_value
       FROM invoice_links
      WHERE code=$1
        AND purpose='portal'
        AND scope_type='factory'
        AND expires_at > NOW()
      LIMIT 1`,
    [code]
  );
  const link = r.rows[0];
  if (!link?.scope_value) return null;
  return { link, factory: await getFactoryInfo(pool, link.scope_value) };
}

async function resolveFactoryByMt(pool, mt) {
  if (!mt) return null;
  const hash = crypto.createHash("sha256").update(String(mt)).digest("hex");
  const r = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash=$1
        AND recipient_role='factory_booking'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!r.rows.length) return null;
  let meta = r.rows[0].meta;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  const label = cleanString(meta?.factory_scope?.label);
  if (!label) return null;
  const c = await pool.query(
    `SELECT code, name_cn, factory_name, name_en
       FROM companies
      WHERE code=$1 OR name_cn ILIKE '%'||$1||'%' OR factory_name ILIKE '%'||$1||'%'
      ORDER BY CASE WHEN code=$1 THEN 0 WHEN name_cn=$1 THEN 1 WHEN factory_name=$1 THEN 2 ELSE 9 END, id ASC
      LIMIT 1`,
    [label]
  );
  const row = c.rows[0];
  if (!row?.code) return null;
  return { factory: { code: row.code, name: row.name_cn || row.factory_name || row.name_en || label } };
}

export async function resolveFactory(req, pool) {
  const mt = cleanString(req.query?.mt || req.body?.mt);
  if (mt) return resolveFactoryByMt(pool, mt);
  return resolveFactoryScope(pool, cleanString(req.query?.c || req.body?.c));
}

export async function assertFactoryCustoms(client, factoryCode, customsNo) {
  const st = await ensureCustomsStatus(client, customsNo, factoryCode);
  if (st.factory_code !== factoryCode) {
    const e = new Error("customs_no not in factory scope");
    e.status = 403;
    throw e;
  }
  return st;
}

function fileUrl(row) {
  const a = row.attachments;
  if (Array.isArray(a) && a[0]) return a[0].oss_url || a[0].url || null;
  if (a && typeof a === "object") return a.oss_url || a.url || null;
  return null;
}

export { json, failClosed, requireFinance, rangeFromQuery, rateLimit, sellerNameMatches, fileUrl };
