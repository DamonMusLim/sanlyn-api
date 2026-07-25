// /api/db/email-template-sample — 邮件模版预览取真数据（只读）
// GET /api/db/email-template-sample                  → 自动挑一票"字段最全"的真实订单
// GET /api/db/email-template-sample?order_no=CY00374  → 指定一票
// 返回 { sample: { "orders.xxx": 值, "shipping_plans.yyy": 值, ... }, meta: {order_no, contract_no, customer} }
// 目的：预览所见=真发所发，杜绝硬编码假样例（如 "PETSOME Trading Co., Ltd" 这种库里不存在的公司名）。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  try {
    // 1) 选一票真实订单：优先指定 order_no，否则挑"关键字段最全"的一票（有客户名+合同号+船名+BL+ETD）
    const wantOrderNo = (req.query.order_no || "").trim();
    let orderRow;
    if (wantOrderNo) {
      const r = await pool.query(
        `SELECT id, order_no, contract_no, COALESCE(company_name_en, company_name_cn, customer) AS customer
           FROM orders WHERE order_no = $1 LIMIT 1`, [wantOrderNo]);
      orderRow = r.rows[0];
    } else {
      const r = await pool.query(`
        SELECT o.id, o.order_no, o.contract_no,
               COALESCE(o.company_name_en, o.company_name_cn, o.customer) AS customer
          FROM orders o
          JOIN shipping_plans sp ON o.order_no = ANY(sp.order_nos)
         WHERE COALESCE(o.company_name_en, o.company_name_cn, o.customer) IS NOT NULL
           AND o.contract_no IS NOT NULL
           AND sp.vessel IS NOT NULL AND sp.bl_no IS NOT NULL
           AND sp.pol_port_id IS NOT NULL AND sp.pod_port_id IS NOT NULL
         ORDER BY sp.etd DESC NULLS LAST
         LIMIT 1`);
      orderRow = r.rows[0];
    }
    if (!orderRow) return res.status(404).json({ error: "找不到可用于预览的真实订单" });

    // 2) 拉订单全字段
    const o = (await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderRow.id])).rows[0] || {};
    // 3) 拉这一票的海运主表（含港口规范英文名——绝不用自由文本）
    const sp = (await pool.query(`
      SELECT sp.*, po.name_en AS pol_name_en, pd.name_en AS pod_name_en
        FROM shipping_plans sp
        LEFT JOIN ports po ON po.id = sp.pol_port_id
        LEFT JOIN ports pd ON pd.id = sp.pod_port_id
       WHERE $1 = ANY(sp.order_nos)
       ORDER BY sp.etd DESC NULLS LAST
       LIMIT 1`, [orderRow.order_no])).rows[0] || {};

    // 4) 组装 canonical_key → 真值
    const sample = {};
    const put = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== "") sample[k] = v; };
    for (const [col, val] of Object.entries(o)) put(`orders.${col}`, val);
    for (const [col, val] of Object.entries(sp)) {
      if (col === "pol_name_en" || col === "pod_name_en") continue;
      put(`shipping_plans.${col}`, val);
    }
    // 港口：铁律——对外一律用 ports.name_en 规范名，覆盖自由文本
    if (sp.pol_name_en) sample["shipping_plans.pol"] = sp.pol_name_en;
    if (sp.pod_name_en) sample["shipping_plans.pod"] = sp.pod_name_en;
    if (sp.pol_name_en) sample["orders.pol"] = sp.pol_name_en;

    return res.json({
      success: true,
      sample,
      meta: { order_no: orderRow.order_no, contract_no: orderRow.contract_no, customer: orderRow.customer },
    });
  } catch (e) {
    console.error("[email-template-sample]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
