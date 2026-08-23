// 海运主表 · 数据管理密网格(只读)
// ⚖️ Damon 0812:「海运主表 报关主表也要补充下,也是同一个位置」
// 主行 = 一票海运(shipping_plans);子行 = 这票带的订单(order_nos/contract_nos 展开)
// ⛔ 空就是空,不补 0;缺 BL/ETD/柜号红标;真源 postgres 只读。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function loadShippingMasterGrid(pool, q = {}) {
  const from = String(q.from || "2026-01-01").trim();
  const sql = `
SELECT s._id AS id, s.shipment_no, s.bl_no, s.mbl_no, s.hbl_no, s.so_no,
  s.vessel, s.voyage, s.pol, s.pod,
  to_char(s.etd,'YYYY-MM-DD') AS etd, to_char(s.eta,'YYYY-MM-DD') AS eta,
  to_char(s.cutoff_date,'YYYY-MM-DD') AS cutoff,
  s.container_no, s.container_qty, s.container_type,
  s.forwarder_cn, s.customs_cn, s.customer, s.issuing_company,
  COALESCE(s.current_status_cn, s.current_status, s.flow_status, s.status) AS status,
  s.freight_cost, s.freight_sale_usd,
  to_char(s.created_at,'YYYY-MM-DD') AS created,
  -- 子行:这票带了哪些订单。⚖️ order_nos / contract_nos 是数组,一票多单是常态(BL才是钥匙)
  COALESCE((
    SELECT json_agg(json_build_object(
      'order_no', o.order_no, 'order_id', o.id, 'contract_no', o.contract_no,
      'customer', COALESCE(NULLIF(o.company_name_en,''), NULLIF(o.customer,'')),
      'factory', o.factory, 'status', o.status,
      'amount', o.total_amount, 'currency', o.currency
    ) ORDER BY o.order_no)
    FROM orders o
    WHERE (s.order_nos IS NOT NULL AND o.order_no = ANY(s.order_nos))
       OR (s.contract_nos IS NOT NULL AND o.contract_no = ANY(s.contract_nos))
       OR (COALESCE(s.contract_no,'') <> '' AND o.contract_no = s.contract_no)
  ), '[]'::json) AS items,
  -- ⚖️ Damon 铁律:「出口履约=自己的货;货代服务=卖给别人的运力。本来就不是一起的。」
  --   0812 实测:今年 23 票"缺关联"里,5 票的客户压根不在订单表 —— 那是货代业务,
  --   它本来就没有我们的订单,标红是冤枉它。→ 分开标 kind,前端各说各话。
  CASE
    WHEN EXISTS (SELECT 1 FROM orders o2
       WHERE (s.order_nos IS NOT NULL AND o2.order_no = ANY(s.order_nos))
          OR (s.contract_nos IS NOT NULL AND o2.contract_no = ANY(s.contract_nos))
          OR (COALESCE(s.contract_no,'') <> '' AND o2.contract_no = s.contract_no)
    ) THEN 'linked'
    -- 🩸0812审计:客户为空时上面那个 NOT EXISTS 恒真 → 空数据被静默标成"货代正常"(绿)。
    --   ⚖️「空就是空」——先把没客户的挑出来当缺数据,别渲染成正常。
    WHEN COALESCE(btrim(s.customer),'') = '' THEN 'nocustomer'
    WHEN s.customer LIKE '\_\_TEST%' OR s.customer LIKE 'UNKNOWN%' THEN 'nocustomer'
    WHEN NOT EXISTS (SELECT 1 FROM orders o3
       WHERE upper(btrim(COALESCE(NULLIF(o3.company_name_en,''), o3.customer)))
           = upper(btrim(COALESCE(s.customer,'')))
    ) THEN 'freight'      -- 客户在订单表里根本没有 → 货代服务,正常
    ELSE 'missing'        -- 是自家客户却没挂上单 → 真缺,要补
  END AS kind
FROM shipping_plans s
WHERE s.deleted_at IS NULL   -- 🩸0812审计:漏了这句,7张已软删的重复/作废票混进了"今年88票"(含测试数据 __TEST_CXLDEL__)
  AND COALESCE(s.etd, s.created_at) >= $1   -- 业务日期=开船日,不是进库日
ORDER BY s.etd DESC NULLS LAST, s.created_at DESC`;
  const r = await pool.query(sql, [from]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadShippingMasterGrid(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
