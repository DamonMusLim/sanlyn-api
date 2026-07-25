import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { writeRfqNotification } from "../db/lib/rfq-pricing.js";
import { resolvePort } from "../db/port-resolver.js";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}
// 短码铁律：对外链接一律 kp?c=CODE（10位字母数字，kp.js 只认 ^[A-Za-z0-9]{10}$）
function genRaw() {
  const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += ALPH[b % ALPH.length];
  return out;
}
function dateKey(v) {
  return v ? String(v).slice(0, 10) : null;
}
function priceFor(r) {
  const obj = typeof r.client_rates_json === "string" ? JSON.parse(r.client_rates_json || "{}") : (r.client_rates_json || {});
  return obj[r.ctnr_type] || obj[String(r.ctnr_type || "").toUpperCase().replace("HC", "HQ")] || r.client_rate_usd || null;
}
function publicRow(r) {
  const etd = dateKey(r.etd);
  const cutoff = etd ? new Date(`${etd}T00:00:00Z`) : null;
  if (cutoff) cutoff.setUTCDate(cutoff.getUTCDate() + 3);
  return {
    rfq_id: r.id,
    route: `${r.pol || ""}→${r.pod || ""}`,
    pol: r.pol,
    pod: r.pod,
    ctnr_type: r.ctnr_type,
    etd,
    sell_until: cutoff ? cutoff.toISOString().slice(0, 10) : null,
    price_usd: priceFor(r),
    // needs_review 是内部定价状态，客户侧一律显示 open（页面文案=报价中）
    status: r.status === "needs_review" ? "open" : r.status,
  };
}
async function resolveCustomer(pool, token) {
  if (!token || token.length < 10) return null;
  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash=$1 AND recipient_role='customer_quote'
        AND expires_at > NOW() AND revoked_at IS NULL
      LIMIT 1`,
    [rawToHash(token)]
  );
  if (!rows.length) return null;
  const meta = typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta || "{}") : (rows[0].meta || {});
  const id = parseInt(meta.customer_company_id, 10);
  return id ? { customer_company_id: id } : null;
}
async function issue(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const id = parseInt((req.body || {}).customer_company_id, 10);
  if (!id) return res.status(400).json({ ok: false, error: "customer_company_id required" });
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role='customer_quote'
        AND (meta->>'customer_company_id')::int = $1
        AND revoked_at IS NULL`,
    [id]
  );
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1,'customer_quote',$2,NOW() + INTERVAL '14 days','[]'::jsonb,NOW())`,
    [rawToHash(raw), JSON.stringify({ customer_company_id: id })]
  );
  return res.json({ ok: true, url: `${APP_BASE}/kp?c=${raw}` });
}
// 登录客户的 company_id：accounts JWT 里的 company_id，缺=fail-closed
function userCompanyId(req) {
  const id = parseInt(req.user?.company_id ?? req.user?.companyId, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// GET /api/db/my-quotes —— 登录客户版报价页数据（跟短码版同一套裁剪）
async function myQuotes(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const cid = userCompanyId(req);
  if (!cid) return res.status(403).json({ ok: false, error: "no_company_binding", message: "账号未绑定公司，请联系 Sanlyn" });
  return listFor(res, pool, cid);
}

// POST /api/db/quote-request —— 客户需求报价：航线+柜型+期望船期+心里价位
// 心里价位 client_target_usd 只进内部（Lens：货代侧端点全是点名列，绝不带它）
async function quoteRequest(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const cid = userCompanyId(req);
  if (!cid) return res.status(403).json({ ok: false, error: "no_company_binding" });
  const b = req.body || {};
  if (!b.pol || !b.pod) return res.status(400).json({ ok: false, error: "pol_pod_required" });
  const [pol, pod] = await Promise.all([resolvePort(pool, b.pol), resolvePort(pool, b.pod)]);
  if (pol.status !== "resolved") return res.status(400).json({ ok: false, error: "pol_" + pol.status, side: "pol", candidates: pol.candidates || [] });
  if (pod.status !== "resolved") return res.status(400).json({ ok: false, error: "pod_" + pod.status, side: "pod", candidates: pod.candidates || [] });
  const ct = String(b.ctnr_type || "40HQ").toUpperCase().replace("HC", "HQ");
  const target = Number(b.target_usd);
  const meta = { source: "customer_portal", qty: b.qty || null, notes: String(b.notes || "").slice(0, 500) };
  const { rows } = await pool.query(
    `INSERT INTO freight_rfqs
       (pol, pod, pol_port_id, pod_port_id, ctnr_type, etd, status, route,
        customer_company_id, created_by, service_type, client_target_usd, request_meta, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,'ocean',$10,$11::jsonb,NOW())
     RETURNING id`,
    [pol.canonical_name, pod.canonical_name, pol.port_id, pod.port_id, ct,
     b.etd || null, `${pol.canonical_name}→${pod.canonical_name}`, cid,
     req.user?.username || "customer_portal",
     Number.isFinite(target) && target > 0 ? target : null,
     JSON.stringify(meta)]
  );
  await writeRfqNotification(pool, rows[0].id, "客户需求报价",
    `${pol.canonical_name}→${pod.canonical_name} ${ct} 客户#${cid} 提交询价${Number.isFinite(target) && target > 0 ? "（含心里价位）" : ""}，待定向派发`,
    { customer_company_id: cid, status: "requested" });
  return res.json({ ok: true, rfq_id: rows[0].id, status: "requested", message: "询价已受理，报价出来会出现在【我的报价】" });
}

async function list(req, res, pool) {
  const token = (req.query || {}).token;
  const cust = await resolveCustomer(pool, token);
  if (!cust) return res.status(401).json({ ok: false, error: "invalid_token" });
  return listFor(res, pool, cust.customer_company_id);
}

async function listFor(res, pool, customerCompanyId) {
  const { rows } = await pool.query(
    `SELECT id, pol, pod, ctnr_type, etd, status, client_rate_usd, client_rates_json
       FROM freight_rfqs
      WHERE customer_company_id = $1
        AND status IN ('open','needs_review','priced','accepted')
      ORDER BY etd NULLS LAST, created_at DESC`,
    [customerCompanyId]
  );
  const pending = [], active = [], history = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const r of rows) {
    if (r.status === "open" || r.status === "needs_review") pending.push(publicRow(r));
    if (r.status === "priced" || r.status === "accepted") {
      const row = publicRow(r);
      const until = row.sell_until ? new Date(`${row.sell_until}T00:00:00Z`) : null;
      (until && until < today ? history : active).push(row);
    }
  }
  return res.json({ ok: true, pending, active, history });
}
async function accept(req, res, pool) {
  const token = (req.body || {}).token;
  const rfqId = (req.body || {}).rfq_id;
  const cust = await resolveCustomer(pool, token);
  if (!cust) return res.status(401).json({ ok: false, error: "invalid_token" });
  const { rows } = await pool.query(
    `UPDATE freight_rfqs
        SET status='accepted', updated_at=NOW()
      WHERE id=$1 AND customer_company_id=$2 AND status='priced'
      RETURNING id, pol, pod, ctnr_type, client_rate_usd`,
    [rfqId, cust.customer_company_id]
  );
  if (!rows.length) return res.status(404).json({ ok: false, error: "quote_not_available" });
  await writeRfqNotification(pool, rfqId, "客户接受运价", `${rows[0].pol}→${rows[0].pod} ${rows[0].ctnr_type}`, {
    customer_company_id: cust.customer_company_id,
  });
  return res.json({ ok: true });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const path = req.path || req.url || "";
  if (path.startsWith("/api/db/customer-quote-link")) return issue(req, res, pool);
  if (path.startsWith("/api/db/my-quotes")) return myQuotes(req, res, pool);
  if (path.startsWith("/api/db/quote-request")) return quoteRequest(req, res, pool);
  if (req.method === "GET") return list(req, res, pool);
  if (req.method === "POST") return accept(req, res, pool);
  return res.status(405).json({ ok: false, error: "method_not_allowed" });
}
