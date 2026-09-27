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

const CACHE_TTL_MS = 60000;
const PREWARM_MS = 5 * 60000;
// 0927 Damon「加载太慢了」:行的重计算要 12 秒 → 先给上一份(不管多旧),过期后台重算;工单每次现查,点完建单马上看得到。
let baseCache = { at: 0, data: null, inflight: null };
// 整类已派的工单(store-board 那边按类建的 storehealth:*),映射到风险问题
const PROBLEM_TASK_MAP = {
  "storehealth:negative_stock": "negative_stock",
  "storehealth:barcode_missing": "data_gap",
  "storehealth:pic_missing": "data_gap",
  "storehealth:cost_missing": "data_gap",
};

function json(res, code, body) { return res.status(code).json(body); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function groupOf(data, key) { return (data.groups || []).find((g) => g.key === key) || { rows: [], count: 0, amount_by_price: null }; }

export function invalidateRiskCenterCache() {
  baseCache.at = 0; // 只标过期,旧数据照给,后台重算
}

function withCacheMeta(data, cached, at) {
  return { ...data, cached, generated_at: new Date(at).toISOString() };
}

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

async function buildRiskBase(pool) {
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

  const list = Array.from(rows.values()).map((r) => {
    r.problems.sort((a, b) => PROBLEMS.findIndex((p) => p.key === a.key) - PROBLEMS.findIndex((p) => p.key === b.key));
    delete r._amount;
    return r;
  }).sort((a, b) => a.top_priority - b.top_priority || (n(b.amount_by_price) || 0) - (n(a.amount_by_price) || 0));

  for (const r of list) r.open_tasks = [];
  const counts = Object.fromEntries(PROBLEMS.map((p) => [p.key, 0]));
  for (const r of list) for (const p of r.problems) counts[p.key] = (counts[p.key] || 0) + 1;
  const exp = groupOf(expiry, "tier_5_expired");

  return {
    ok: true,
    rows: list,
    problems: PROBLEMS,
    problem_counts: counts,
    cards: {
      expired_onsale_n: counts.expired_onsale || 0,
      expired_amount: exp.amount_by_price,
      onsale_no_stock_n: counts.onsale_no_stock || 0,
      no_date_n: counts.no_date || 0,
    },
    captured: expiry.summary && expiry.summary.captured,
    stale_days: expiry.summary && expiry.summary.stale_days,
    caveats: [].concat(expiry.caveats || [], goods.caveats || []),
  };
}

async function loadTasks(pool) {
  const r = await pool.query(
    `SELECT id, title, status, next_holder, created_at, due_at, dedupe_key
       FROM public.tasks
      -- 0916:tasks 触发器会把 domain petstore 归一成 petshop,⛔别按 domain 过滤,risk: 去重键已唯一
      -- 0927:加 pa:<动作>:<商品>(产品分析建的单)和 storehealth:*(经营台按类建的单),都算「已转任务」
      WHERE (dedupe_key LIKE 'risk:%' OR dedupe_key LIKE 'pa:%' OR dedupe_key LIKE 'storehealth:%')
        AND status NOT IN ('done','cancelled')
      ORDER BY created_at DESC NULLS LAST, id`);
  const rowTasks = [], problemTasks = {};
  for (const t of r.rows) {
    const key = String(t.dedupe_key || "");
    const base = { id: t.id, title: t.title, status: t.status, next_holder: t.next_holder, created_at: t.created_at, due_at: t.due_at };
    if (PROBLEM_TASK_MAP[key]) {
      const pk = PROBLEM_TASK_MAP[key];
      (problemTasks[pk] || (problemTasks[pk] = [])).push(base);
      continue;
    }
    let m = key.match(/^risk:([^:]+):(.+)$/);
    if (m) { rowTasks.push({ ...base, problem_key: m[1], product_code: m[2], dedupe_key: key }); continue; }
    m = key.match(/^pa:.*:([^:]+)$/);
    if (m) rowTasks.push({ ...base, problem_key: "pa", product_code: m[1], dedupe_key: key });
  }
  return { rowTasks, problemTasks };
}

// 行数据 + 现查的工单合并;⛔不改缓存里的对象(每次浅拷贝),防请求之间串数据
function attachTasks(base, tasks) {
  const byCode = new Map();
  for (const t of tasks.rowTasks) {
    if (!byCode.has(t.product_code)) byCode.set(t.product_code, []);
    byCode.get(t.product_code).push({ id: t.id, status: t.status, next_holder: t.next_holder, created_at: t.created_at, problem_key: t.problem_key });
  }
  const rows = (base.rows || []).map((r) => ({ ...r, open_tasks: byCode.get(r.product_code) || [] }));
  const converted = rows.filter((r) => r.open_tasks.length).length;
  const todo = rows.length - converted;
  return {
    ...base,
    verdict: rows.length ? `🔴 ${rows.length} 个商品有风险 · 已转任务 ${converted} · 还没人管 ${todo}` : "✅ 暂无风险商品",
    rows,
    problem_tasks: tasks.problemTasks,
    cards: {
      ...base.cards,
      converted_n: converted,
      todo_n: todo,
      open_tasks_n: tasks.rowTasks.length,
      pending_writeoff_n: tasks.rowTasks.filter((t) => t.problem_key === "writeoff").length,
    },
    open_tasks: tasks.rowTasks,
  };
}

// risk-act 建单前要现算一份核对「还在不在」,保持原来的完整口径
export async function buildRiskCenter(pool) {
  const [base, tasks] = await Promise.all([buildRiskBase(pool), loadTasks(pool)]);
  return attachTasks(base, tasks);
}

function refreshBase() {
  if (baseCache.inflight) return baseCache.inflight;
  baseCache.inflight = buildRiskBase(getPool())
    .then((data) => { baseCache.data = data; baseCache.at = Date.now(); })
    .catch((err) => { console.error("[petstore-risk-center] refresh", err); if (!baseCache.data) throw err; })
    .finally(() => { baseCache.inflight = null; });
  return baseCache.inflight;
}

async function getBase() {
  if (baseCache.data) {
    if (Date.now() - baseCache.at >= CACHE_TTL_MS) refreshBase().catch(() => {});
    return { data: baseCache.data, at: baseCache.at, cached: true };
  }
  await refreshBase();
  return { data: baseCache.data, at: baseCache.at, cached: false };
}

refreshBase().catch(() => {});
setInterval(() => { refreshBase().catch(() => {}); }, PREWARM_MS).unref();

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const [base, tasks] = await Promise.all([getBase(), loadTasks(getPool())]);
    return json(res, 200, withCacheMeta(attachTasks(base.data, tasks), base.cached, base.at));
  } catch (err) {
    console.error("[petstore-risk-center]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
