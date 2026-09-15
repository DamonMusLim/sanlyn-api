import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { buildExpiryRisk } from "./petstore-expiry-risk.js";
import { buildProblemGoods } from "./petstore-problem-goods.js";

const PROBLEMS = [
  { key: "expired_onsale", label: "已过期仍在售", tier: "red", action: "下架+核日期", assignee: "PET-12" },
  { key: "expired", label: "已过期", tier: "red", action: "核日期+报损待批", assignee: "PET-12" },
  { key: "price_zero", label: "售价≈0有货", tier: "red", action: "修价", assignee: "PET-12" },
  { key: "negative_stock", label: "负库存", tier: "red", action: "盘点", assignee: "PET-22" },
  { key: "onsale_no_stock", label: "在售没货", tier: "red", action: "补货或下架", assignee: "PET-22" },
  { key: "d30", label: "<=30天", tier: "red", action: "临期处理(降价需Damon批)", assignee: "PET-12" },
  { key: "no_date", label: "会坏有货没日期", tier: "yellow", action: "店员补日期", assignee: "PET-01" },
  { key: "d60", label: "31-60天", tier: "orange", action: "临期观察", assignee: "PET-12" },
  { key: "no_shelf", label: "有货没货位", tier: "yellow", action: "补货位", assignee: "PET-01" },
  { key: "stock_mismatch", label: "库存对不上", tier: "yellow", action: "对账", assignee: "PET-22" },
  { key: "status_unknown", label: "无上下架状态", tier: "yellow", action: "补状态", assignee: "PET-12" },
  { key: "data_gap", label: "档案缺口", tier: "yellow", action: "补档案", assignee: "PET-12" },
  { key: "d90", label: "61-90天", tier: "yellow", action: "观察", assignee: "" },
];

function json(res, code, body) { return res.status(code).json(body); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function groupOf(data, key) { return (data.groups || []).find((g) => g.key === key) || { rows: [], count: 0, amount_by_price: null }; }

function addRow(map, row, problem, why) {
  const code = row.product_code;
  if (!code) return;
  if (!map.has(code)) {
    map.set(code, {
      product_code: code,
      product_name: row.product_name,
      spec_text: row.spec_text,
      barcode: row.barcode,
      shelf_code: row.shelf_code,
      product_status: row.product_status,
      category: row.category_l1 || row.category || row.category_l2 || null,
      stk: row.stk,
      month_sale: row.month_sale,
      produce_date: row.produce_date || null,
      expiration_date: row.expiration_date || null,
      days_to_expire: row.days_to_expire == null ? null : row.days_to_expire,
      amount_by_price: row.amount_by_price == null ? null : row.amount_by_price,
      problems: [],
      top_priority: 999,
      open_tasks: [],
      _amount: n(row.amount_by_price),
    });
  }
  const item = map.get(code);
  ["product_name", "spec_text", "barcode", "shelf_code", "product_status", "stk", "month_sale", "produce_date", "expiration_date", "days_to_expire"].forEach((k) => {
    if (item[k] == null && row[k] != null) item[k] = row[k];
  });
  if (!item.category) item.category = row.category_l1 || row.category || row.category_l2 || null;
  const amt = n(row.amount_by_price);
  if (amt != null && (item._amount == null || amt > item._amount)) {
    item._amount = amt;
    item.amount_by_price = row.amount_by_price;
  }
  if (!item.problems.some((p) => p.key === problem.key)) {
    item.problems.push({ key: problem.key, label: problem.label, tier: problem.tier, action: problem.action, assignee: problem.assignee, why });
    item.top_priority = Math.min(item.top_priority, PROBLEMS.findIndex((p) => p.key === problem.key));
  }
}

export async function buildRiskCenter(pool) {
  const [expiry, goods] = await Promise.all([buildExpiryRisk(pool), buildProblemGoods(pool)]);
  const byKey = Object.fromEntries(PROBLEMS.map((p) => [p.key, p]));
  const rows = new Map();

  for (const r of groupOf(expiry, "tier_5_expired").rows || []) {
    addRow(rows, r, r.product_status === "UP" ? byKey.expired_onsale : byKey.expired, groupOf(expiry, "tier_5_expired").why);
  }
  for (const r of groupOf(expiry, "tier_4_d30").rows || []) addRow(rows, r, byKey.d30, groupOf(expiry, "tier_4_d30").why);
  for (const r of groupOf(expiry, "tier_3_d60").rows || []) addRow(rows, r, byKey.d60, groupOf(expiry, "tier_3_d60").why);
  for (const r of groupOf(expiry, "tier_2_d90").rows || []) addRow(rows, r, byKey.d90, groupOf(expiry, "tier_2_d90").why);
  for (const r of groupOf(expiry, "no_real_date").rows || []) addRow(rows, r, byKey.no_date, groupOf(expiry, "no_real_date").why);

  const mapGoods = { price_zero: "price_zero", negative_stock: "negative_stock", onsale_no_stock: "onsale_no_stock",
    instock_no_shelf: "no_shelf", perishable_no_date: "no_date", stock_mismatch: "stock_mismatch",
    status_unknown: "status_unknown", data_gap: "data_gap" };
  for (const g of goods.groups || []) {
    const pk = mapGoods[g.key];
    if (!pk) continue;
    for (const r of g.rows || []) addRow(rows, r, byKey[pk], g.why);
  }

  const taskRes = await pool.query(
    `SELECT id, status, next_holder, created_at, dedupe_key
       FROM public.tasks
      WHERE domain = 'petstore'
        AND dedupe_key LIKE 'risk:%'
        AND status NOT IN ('done','cancelled')
      ORDER BY created_at DESC NULLS LAST, id`);
  const allOpenTasks = taskRes.rows.map((t) => {
    const m = String(t.dedupe_key || "").match(/^risk:([^:]+):(.+)$/);
    return { id: t.id, status: t.status, next_holder: t.next_holder, created_at: t.created_at,
      problem_key: m ? m[1] : null, product_code: m ? m[2] : null, dedupe_key: t.dedupe_key };
  });
  const taskByCode = new Map();
  for (const t of allOpenTasks) {
    if (!t.product_code) continue;
    if (!taskByCode.has(t.product_code)) taskByCode.set(t.product_code, []);
    taskByCode.get(t.product_code).push({ id: t.id, status: t.status, next_holder: t.next_holder, created_at: t.created_at, problem_key: t.problem_key });
  }
  for (const item of rows.values()) item.open_tasks = taskByCode.get(item.product_code) || [];

  const list = Array.from(rows.values()).map((r) => {
    r.problems.sort((a, b) => PROBLEMS.findIndex((p) => p.key === a.key) - PROBLEMS.findIndex((p) => p.key === b.key));
    delete r._amount;
    return r;
  }).sort((a, b) => a.top_priority - b.top_priority || (n(b.amount_by_price) || 0) - (n(a.amount_by_price) || 0));

  const counts = Object.fromEntries(PROBLEMS.map((p) => [p.key, 0]));
  for (const r of list) for (const p of r.problems) counts[p.key] = (counts[p.key] || 0) + 1;
  const exp = groupOf(expiry, "tier_5_expired");

  return {
    ok: true,
    verdict: list.length ? `🔴 ${list.length} 个商品有风险待处理` : "✅ 暂无风险商品",
    rows: list,
    problems: PROBLEMS,
    problem_counts: counts,
    cards: {
      expired_onsale_n: counts.expired_onsale || 0,
      expired_amount: exp.amount_by_price,
      onsale_no_stock_n: counts.onsale_no_stock || 0,
      no_date_n: counts.no_date || 0,
      open_tasks_n: allOpenTasks.length,
      pending_writeoff_n: allOpenTasks.filter((t) => t.problem_key === "writeoff").length,
    },
    open_tasks: allOpenTasks,
    captured: expiry.summary && expiry.summary.captured,
    stale_days: expiry.summary && expiry.summary.stale_days,
    caveats: [].concat(expiry.caveats || [], goods.caveats || []),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await buildRiskCenter(getPool()));
  } catch (err) {
    console.error("[petstore-risk-center]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
