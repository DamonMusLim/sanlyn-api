// api/db/reconcile.js — 集装箱对账只读端点（Cockpit Agent v2 的确定性查询工具）
// GET /api/db/reconcile?containers=FTAU2159922,GLDU5425740,...
// 按柜号一次返回 N 行：shipping_plan + order + 货款应收/已收(合同级) + 海运费应收/应付/已付。
// 铁律：只读、参数化、绝不造数 —— 查不到的柜 found=false；多 plan/多 order 显式标 ambiguous，不蒙混成事实。
import { getPool, setCors } from "../db.js";

// 注：orders.total_amount / finance_payments.amount / our_freight_cost_lines.amount / shipping_plans.freight_*
// 经 information_schema 实测全部为 numeric 类型，直接 SUM 安全（无脏 text，不会 ::numeric 炸库）。

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  try {
    const raw = String(req.query.containers || "").trim();
    if (!raw) return res.status(400).json({ success: false, error: "containers required (comma-separated)" });
    // 只接受合法柜号格式（4字母+7数字），去重，最多 50 个
    const containers = [...new Set(
      raw.toUpperCase().split(/[\s,]+/).filter(c => /^[A-Z]{4}\d{7}$/.test(c))
    )].slice(0, 50);
    if (!containers.length) return res.status(400).json({ success: false, error: "no valid container numbers (expect 4 letters + 7 digits)" });

    const pool = getPool();
    const q = `
      WITH cn AS (SELECT unnest($1::text[]) AS container_no)
      SELECT
        cn.container_no,
        sp.id            AS plan_id,
        sp.contract_no,
        sp.bl_no,
        sp.vessel,
        sp.etd,
        sp.eta,
        sp.current_status_cn,
        sp.shipping_status,
        sp.freight_sale_usd,
        sp.freight_sale_cny,
        sp.freight_cost,
        (SELECT COUNT(*) FROM shipping_plans WHERE container_no = cn.container_no)::int AS plan_count,
        o.order_no,
        o.customer,
        o.currency,
        -- 货款应收(合同级,可能跨多柜): 同合同所有订单金额合计 + 订单张数
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE contract_no = sp.contract_no)                  AS contract_order_total,
        (SELECT COUNT(*) FROM orders WHERE contract_no = sp.contract_no)::int                                   AS order_count,
        -- 货款已收(合同级): finance_payments direction=in
        (SELECT COALESCE(SUM(fp.amount), 0) FROM finance_payments fp
           WHERE fp.contract_no = sp.contract_no AND fp.direction = 'in')                                       AS goods_received_contract,
        -- 海运费已付(plan级): direction=out
        (SELECT COALESCE(SUM(fp.amount), 0) FROM finance_payments fp
           WHERE (fp.plan_id = sp.id::text OR fp.plan_id = sp._id) AND fp.direction = 'out')                    AS freight_paid,
        -- 海运费应付(供应商账单): 按 plan 或按柜号匹配
        (SELECT COALESCE(SUM(fb.amount), 0) FROM our_freight_cost_lines fb
           WHERE fb.link_plan_id = sp.id::text OR fb.link_plan_id = sp._id OR fb.container_no = cn.container_no) AS freight_billed
      FROM cn
      LEFT JOIN LATERAL (
        SELECT * FROM shipping_plans WHERE container_no = cn.container_no
        ORDER BY created_at DESC NULLS LAST LIMIT 1
      ) sp ON true
      LEFT JOIN LATERAL (
        SELECT order_no, customer, currency FROM orders
        WHERE contract_no = sp.contract_no
        ORDER BY updated_at DESC NULLS LAST LIMIT 1
      ) o ON true
      ORDER BY cn.container_no`;
    const result = await pool.query(q, [containers]);

    // 标注每柜：found=系统有 shipping_plan；ambiguous=同柜多 plan/同合同多订单(需人工核,不当确定事实)。
    const rows = result.rows.map(r => ({
      ...r,
      found: r.plan_id != null,
      order_found: r.order_no != null,
      ambiguous_plan: (r.plan_count || 0) > 1,
      ambiguous_order: (r.order_count || 0) > 1,
    }));
    const missing = rows.filter(r => !r.found).map(r => r.container_no);
    const ambiguous = rows.filter(r => r.ambiguous_plan || r.ambiguous_order).map(r => r.container_no);
    return res.status(200).json({ success: true, data: rows, count: rows.length, missing, ambiguous });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
