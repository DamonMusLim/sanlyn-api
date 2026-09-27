import crypto from "crypto";
import { readFileSync } from "fs";
import { getPool, setCors } from "../db.js";
import { buildNearexp } from "./petstore-nearexp.js";
import { buildRiskCenter } from "./petstore-risk-center.js";

const CACHE_TTL_MS = 30000;
const GATEWAY_AUTH = "gw-dataops-0903";
const CHAT_BASE = process.env.CHAT_DESK_BASE || "http://100.87.134.113:3798";
const STAFF_PORTAL_BASE = process.env.SANLYN_API_BASE || "http://127.0.0.1:9000";
const APPROVAL_FIELDS = [
  "nearexp_ready", "nearexp_unverified", "price", "restock",
  "writeoff", "boss_tasks", "tickets_fyi", "total",
];
const STORES = [
  { code: "63350001", name: "金枋店", company_code: "JINFANG" },
  { code: "63350002", name: "泉州店", company_code: null },
];

let cache = { at: 0, data: null };

function json(res, code, body) { return res.status(code).json(body); }
function shDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function yesterdayOf(dateText) {
  const d = new Date(`${dateText}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() - 1);
  return shDate(d);
}
function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function money(v) {
  const x = n(v);
  return x == null ? null : x;
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function part(errors, label, fallback, fn) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err?.message || err}`);
    return fallback;
  }
}

async function salesYesterday(pool, storeCode, bizDate) {
  const [offline, delivery] = await Promise.all([
    pool.query(
      `SELECT to_char(biz_date,'YYYY-MM-DD') AS biz_date,
              COALESCE(sale_amount,0)::numeric AS offline_amount,
              COALESCE(sale_num,0)::int AS offline_num
         FROM public.petstore_offline_sales_daily
        WHERE store_code=$1 AND biz_date=$2::date
        LIMIT 1`,
      [storeCode, bizDate],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS rows_n,
              COALESCE(SUM(turnover),0)::numeric AS delivery_amount,
              COALESCE(SUM(orders),0)::int AS delivery_orders
         FROM public.petstore_platform_daily
        WHERE store_code=$1 AND stat_date=$2::date
          AND COALESCE(data_state,'') <> 'empty'`,
      [storeCode, bizDate],
    ),
  ]);
  const off = offline.rows[0] || {};
  const del = delivery.rows[0] || {};
  const hasDelivery = Number(del.rows_n || 0) > 0;
  return {
    biz_date: off.biz_date || bizDate,
    offline_amount: money(off.offline_amount) || 0,
    offline_num: n(off.offline_num) || 0,
    delivery_amount: hasDelivery ? money(del.delivery_amount) : null,
    delivery_orders: hasDelivery ? n(del.delivery_orders) : null,
  };
}

export function mapNearexp(summary) {
  const tiers = (summary || []).map((r) => ({
    label: String(r.tier_label || "未分档").split(/[：:]/)[0].trim() || "未分档",
    count: n(r.product_count) || 0,
  }));
  const out = { le3: 0, le30: 0, total: 0 };
  for (const t of tiers) {
    out.total += t.count;
    const upper = Number((t.label.match(/≤\s*(\d+)/) || t.label.match(/-\s*(\d+)/) || [])[1]);
    if (!Number.isFinite(upper)) continue;
    if (upper <= 3) out.le3 += t.count;
    if (upper <= 30) out.le30 += t.count;
  }
  return { ...out, tiers };
}

export function signBossStaffToken(now = Math.floor(Date.now() / 1000)) {
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) throw new Error("JWT_SECRET 未配置");
  const employeeId = Number(process.env.BOSS_EMPLOYEE_ID || 35);
  if (!Number.isFinite(employeeId)) throw new Error("BOSS_EMPLOYEE_ID 非数字");
  const seg = [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ role: "staff", employee_id: employeeId, name: "Damon", iat: now, exp: now + 120 })),
  ];
  seg.push(b64url(crypto.createHmac("sha256", SECRET).update(seg.join(".")).digest()));
  return seg.join(".");
}

function pickApprovalSummary(summary) {
  const out = {};
  for (const key of APPROVAL_FIELDS) out[key] = n(summary?.[key]) || 0;
  return out;
}

async function staffApprovals() {
  const token = signBossStaffToken();
  const url = `${STAFF_PORTAL_BASE}/api/db/hr-staff-portal?token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const summary = data?.manager?.approvals?.summary;
  if (!summary) throw new Error("summary missing");
  return pickApprovalSummary(summary);
}

async function teamToday(pool, companyCode, today) {
  if (!companyCode) return null;
  const [staff, checkins] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS staff_total
         FROM public.hr_employees
        WHERE company_code=$1 AND employment_status='active'`,
      [companyCode],
    ),
    pool.query(
      `SELECT staff_name AS name,
              to_char(MIN(checkin_at::timestamptz) AT TIME ZONE 'Asia/Shanghai','HH24:MI') AS at
         FROM public.hr_staff_checkin
        WHERE company_code=$1 AND checkin_date=$2::date
        GROUP BY staff_name
        ORDER BY MIN(checkin_at::timestamptz) ASC NULLS LAST, staff_name ASC`,
      [companyCode, today],
    ),
  ]);
  return {
    staff_total: n(staff.rows[0]?.staff_total) || 0,
    checked_in: checkins.rows.map((r) => ({ name: r.name, at: r.at })),
  };
}

function chatToken() {
  const direct = String(process.env.CHAT_DESK_TOKEN || "").trim();
  if (direct) return direct;
  const file = process.env.CHAT_DESK_TOKEN_FILE || "/opt/sanlyn-petstore-api/.chat-desk-token";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

async function chatQueue(errors) {
  const token = chatToken();
  if (!token) {
    errors.push("chat: CHAT_DESK_TOKEN 未配置");
    return null;
  }
  const url = `${CHAT_BASE}/desk/api/queue?k=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return {
    open_total: n(data.open_total) || 0,
    owed_reply: n(data.rule_counts?.owed_reply) || 0,
    link: `https://chat.sanlyn.cn/desk?k=${encodeURIComponent(token)}`,
  };
}

async function buildBossDesk() {
  const pool = getPool();
  const errors = [];
  const dateToday = shDate();
  const bizDate = yesterdayOf(dateToday);
  const baseStores = STORES.map((s) => ({ code: s.code, name: s.name }));

  const [nearexpData, riskData, chat, approvals] = await Promise.all([
    part(errors, "nearexp", null, () => buildNearexp(pool)),
    part(errors, "risk_center", null, () => buildRiskCenter(pool)),
    part(errors, "chat", null, () => chatQueue(errors)),
    part(errors, "approvals", null, () => staffApprovals()),
  ]);

  const stores = await Promise.all(baseStores.map(async (store) => {
    const meta = STORES.find((s) => s.code === store.code);
    const [sales, team] = await Promise.all([
      part(errors, `sales_${store.code}`, null, () => salesYesterday(pool, store.code, bizDate)),
      part(errors, `team_${store.code}`, null, () => teamToday(pool, meta.company_code, dateToday)),
    ]);
    return {
      ...store,
      sales_yesterday: sales,
      nearexp: store.code === "63350001" && nearexpData ? mapNearexp(nearexpData.summary) : null,
      oos: store.code === "63350001" && riskData ? n(riskData.cards?.onsale_no_stock_n) : null,
      team,
    };
  }));

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    date_today: dateToday,
    stores,
    tickets_open: riskData ? n(riskData.cards?.open_tasks_n) : null,
    approvals,
    chat,
    errors,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== GATEWAY_AUTH) {
    return json(res, 403, { ok: false, error: "gateway_auth_required" });
  }
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) {
    return json(res, 200, { ...cache.data, cached: true, generated_at: new Date(cache.at).toISOString() });
  }
  const data = await buildBossDesk();
  cache = { at: Date.now(), data };
  return json(res, 200, { ...data, cached: false, generated_at: new Date(cache.at).toISOString() });
}
