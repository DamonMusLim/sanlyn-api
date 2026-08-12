// 报关主表 · 数据管理密网格(只读)
// ⚖️ Damon 0812:「海运主表 报关主表也要补充下,也是同一个位置」
// 主行 = 一张报关单;子行 = 报关单逐项(customs_declaration_items)
// ⛔ 铁律沿用退税主表:逐项 HS/品名/数量/净重/金额 一律取自海关报关单,禁用 OLI。
//    空就是空,不补 0。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function loadCustomsMasterGrid(pool, q = {}) {
  const from = String(q.from || "2026-01-01").trim();
  const sql = `
SELECT c.id, c.declaration_no, c.declaration_status,
  c.trade_country, c.arrive_country, c.transaction_term, c.transport_mode,
  c.total_declaration_amount, c.total_declaration_currency,
  -- 🩸0812审计:表头金额与逐项打架时,**逐项分毫不差等于退税台账**(实测2例)。
  --   ⚖️ 铁律「逐项才是真源」→ 两个数都给前端,让他看得见差在哪,⛔ 不许我替他选一个。
  (SELECT sum(i.declaration_amount) FROM customs_declaration_items i
     WHERE i.declaration_id = c.id AND i.deleted_at IS NULL) AS items_amount,
  array_to_string(c.container_nos, ' / ') AS containers,
  to_char(c.declared_at,'YYYY-MM-DD') AS declared,
  to_char(c.released_at,'YYYY-MM-DD') AS released,
  to_char(c.created_at,'YYYY-MM-DD') AS created,
  c.rebate_period, c.rebate_batch,
  (SELECT co.name_cn FROM companies co WHERE co.id = c.broker_company_id) AS broker,
  s.bl_no, s.vessel, s.voyage, to_char(s.etd,'YYYY-MM-DD') AS etd,
  -- 子行:报关单逐项
  COALESCE((
    SELECT json_agg(json_build_object(
      'hs', i.hs_code, 'name', COALESCE(NULLIF(i.declaration_name_cn,''), i.declaration_name_en),
      'qty', i.qty, 'unit', i.unit, 'nw', i.net_weight_kg, 'gw', i.gross_weight_kg,
      'amount', i.declaration_amount, 'currency', i.declaration_currency,
      'price', i.unit_price, 'origin', i.country_of_origin,
      'order_no', (SELECT o.order_no FROM orders o WHERE o.id = i.order_id)
    ) ORDER BY i.sort_order, i.id)
    FROM customs_declaration_items i WHERE i.declaration_id = c.id AND i.deleted_at IS NULL
  ), '[]'::json) AS items
FROM customs_declarations c
LEFT JOIN shipping_plans s ON s._id = c.shipping_plan_id
WHERE c.deleted_at IS NULL AND COALESCE(c.declared_at, s.etd, c.created_at) >= $1  -- 业务日期=申报日/开船日
ORDER BY c.declared_at DESC NULLS LAST, c.created_at DESC`;
  const r = await pool.query(sql, [from]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadCustomsMasterGrid(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
