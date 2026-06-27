// /api/db/invoice-bind.js — 进项票 ↔ 报关单 绑定（退税用）
// GET  ?customs_no=X        → 该报关单的候选进项票(同工厂) + 已绑的
// POST {invoice_id, customs_no, unbind?}  → 绑定/解绑
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    if (req.method === "GET") {
      const customs_no = String(req.query.customs_no || "");
      if (!customs_no) return res.status(400).json({ success: false, error: "需 customs_no" });
      // 报关单 → 合同 → 订单工厂
      const fr = await pool.query(`
        SELECT fer.contract_no,
               (SELECT factory_company_id FROM orders o WHERE o.contract_no=fer.contract_no AND o.factory_company_id IS NOT NULL LIMIT 1) AS factory_id,
               (SELECT STRING_AGG(DISTINCT c.name_cn,'、') FROM orders o JOIN companies c ON c.id=o.factory_company_id WHERE o.contract_no=fer.contract_no) AS factory_name
        FROM finance_export_rebates fer WHERE fer.customs_no=$1 LIMIT 1`, [customs_no]);
      if (!fr.rows.length) return res.status(404).json({ success: false, error: "找不到该报关单退税记录" });
      const { contract_no, factory_id, factory_name } = fr.rows[0];
      // 候选进项票：同工厂(优先) + 合同号匹配；已绑此报关单的标记
      const cand = await pool.query(`
        SELECT fi.id, fi.invoice_no, to_char(fi.issue_date,'YYYY-MM-DD') AS issue_date,
               fi.seller_name, fi.amount_ex_tax::numeric ex, fi.total_tax::numeric tax,
               fi.amount_incl_tax::numeric incl, fi.tax_rate::numeric rate,
               fi.contract_nos, fi.customs_nos,
               ($1 = ANY(COALESCE(fi.customs_nos,'{}'))) AS bound_here,
               (fi.customs_nos IS NOT NULL AND NOT ($1 = ANY(COALESCE(fi.customs_nos,'{}')))) AS bound_other
        FROM finance_invoices_in fi
        WHERE fi.factory_id = $2
           OR $3 = ANY(COALESCE(fi.contract_nos,'{}'))
        ORDER BY ($1 = ANY(COALESCE(fi.customs_nos,'{}'))) DESC, fi.amount_incl_tax DESC`,
        [customs_no, factory_id, contract_no]);
      return res.status(200).json({ success: true, customs_no, contract_no, factory_id, factory_name,
        candidates: cand.rows });
    }
    if (req.method === "POST") {
      const { invoice_id, customs_no, unbind } = req.body || {};
      if (!invoice_id || !customs_no) return res.status(400).json({ success: false, error: "需 invoice_id + customs_no" });
      if (unbind) {
        await pool.query(`UPDATE finance_invoices_in SET customs_nos = array_remove(customs_nos,$2), updated_at=NOW() WHERE id=$1`, [invoice_id, customs_no]);
      } else {
        await pool.query(`UPDATE finance_invoices_in SET customs_nos = (
          SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(customs_nos,'{}') || ARRAY[$2::text]))
        ), updated_at=NOW() WHERE id=$1`, [invoice_id, customs_no]);
      }
      return res.status(200).json({ success: true, invoice_id, customs_no, unbind: !!unbind });
    }
    return res.status(405).json({ success: false, error: "GET/POST only" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
