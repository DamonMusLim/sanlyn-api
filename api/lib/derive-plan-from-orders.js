// api/lib/derive-plan-from-orders.js — 海运计划「读时派生」纯函数（task 1817, 2026-06-24）
//
// 治本: 订单数据明明有, 到海运/报关却显示「缺」, 根因是两表没派生 + 关联用错钥匙。
//
// 铁律(前人踩坑):
//   1. 订单↔海运的真实关联键是 shipping_plans.order_nos[] → orders.order_no，
//      不是标量 contract_no(脏值常为 "FS.../FS..." 或 NULL, 匹配 0 单)。
//   2. 量类(重量/箱数)锚 OLI(order_line_items) 真值, 不从订单聚合视图取。
//   3. 一票多柜多工厂 → factory_company_ids 是去重数组, 绝不塌缩成单值。
//   4. 只读、参数化、绝不造数: 派生不出来就返回 null/空数组。
//
// 入参:
//   plan  — 一行 shipping_plans (至少含 order_nos[]; 脏标量 contract_no 仅兜底)
//   pool  — pg pool (只读)
// 返回 Promise<{
//   order_nos: string[],            // 实际用于关联的订单号(去重)
//   linked_order_count: number,     // 命中的订单数
//   factory_company_ids: number[],  // 多工厂去重数组(不塌缩)
//   customer_company_id: number|null,
//   etd: string|null,               // 取关联订单 min(etd)
//   total_cartons: number|null,     // 锚 OLI sum(qty_ctn)
//   gross_weight_kg: number|null,   // 锚 OLI sum(gw_ctn*qty_ctn)
//   pol: string|null,
//   issuing_company: string|null,
//   container_type: string|null,
// }>

const EMPTY_RESULT = () => ({
  order_nos: [], linked_order_count: 0, factory_company_ids: [],
  customer_company_id: null, etd: null, total_cartons: null,
  gross_weight_kg: null, pol: null, issuing_company: null, container_type: null,
});

// 从 plan 取关联订单号: 优先 order_nos[]; 仅当其为空时, 才把脏标量 contract_no 当兜底候选。
// contract_no 兜底只在它「像订单号」(无空格/斜杠/逗号的单值)时才用, 否则忽略(FS.../FS... 这类不是订单号)。
function planOrderNos(plan) {
  const arr = Array.isArray(plan && plan.order_nos)
    ? plan.order_nos.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (arr.length) return [...new Set(arr)];
  // 兜底: 脏标量 contract_no — 只接受看起来是单个订单号的值
  const raw = String((plan && plan.contract_no) || "").replace(/[{}\[\]"]/g, "").trim();
  if (raw && !/[\s,/|]/.test(raw)) return [raw];
  return [];
}

// 注意: Number(null)===0 / Number('')===0 — 必须先挡空值, 否则 NULL 工厂会被「造」成 0(违反绝不造数)。
const fin = (v) => {
  if (v == null || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const firstNonEmpty = (rows, k) => {
  for (const r of rows) {
    const v = r[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
};

export async function derivePlanFromOrders(plan, pool) {
  const out = EMPTY_RESULT();
  const ons = planOrderNos(plan);
  out.order_nos = ons;
  if (!ons.length || !pool) return out;

  // 1) 关联订单 — 按 order_no 精确匹配(真实关联键)
  let orders;
  try {
    orders = (await pool.query(
      `SELECT id, order_no, factory_company_id, customer_company_id,
              etd, pol, issuing_company, container_type
         FROM orders WHERE order_no = ANY($1::text[])`,
      [ons]
    )).rows;
  } catch (e) {
    return out; // 查询失败 → 派生不出来就返回空(绝不造数)
  }
  if (!orders.length) return out;
  out.linked_order_count = orders.length;
  const orderIds = orders.map((o) => o.id);

  // 2) 工厂多值不塌缩 — 去重数组
  const facSet = new Set();
  for (const o of orders) {
    const f = fin(o.factory_company_id);
    if (f != null) facSet.add(f);
  }
  out.factory_company_ids = [...facSet];

  // 3) 客户 — 取首个非空(同票一般同客户)
  out.customer_company_id = fin(firstNonEmpty(orders, "customer_company_id"));

  // 4) etd — 取关联订单 min(etd)(最早开船)
  {
    let min = null;
    for (const o of orders) {
      if (!o.etd) continue;
      const t = new Date(o.etd).getTime();
      if (!Number.isFinite(t)) continue;
      if (min == null || t < min.t) min = { t, raw: o.etd };
    }
    out.etd = min ? min.raw : null;
  }

  // 5) pol / issuing_company / container_type — 取首个非空
  out.pol = firstNonEmpty(orders, "pol");
  out.issuing_company = firstNonEmpty(orders, "issuing_company");
  out.container_type = firstNonEmpty(orders, "container_type");

  // 6) 量类锚 OLI 真值 — sum(qty_ctn) / sum(gw_ctn*qty_ctn)
  try {
    const agg = (await pool.query(
      `SELECT SUM(qty_ctn)            AS total_cartons,
              SUM(gw_ctn * qty_ctn)   AS gross_weight_kg
         FROM order_line_items WHERE order_id = ANY($1::int[])`,
      [orderIds]
    )).rows[0] || {};
    out.total_cartons = agg.total_cartons != null ? Math.round(Number(agg.total_cartons)) : null;
    out.gross_weight_kg = agg.gross_weight_kg != null ? Number(agg.gross_weight_kg) : null;
  } catch (e) { /* OLI 聚合失败不影响其余派生 */ }

  return out;
}

export default derivePlanFromOrders;
