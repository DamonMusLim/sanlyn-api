import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth } from "../lib/viewmodel-adapter.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!isInternalRole(roleFromAuth(req))) return res.status(403).json({ ok: false, error: "forbidden" });
  const pool = getPool();
  const limit = Math.min(parseInt(req.query?.limit, 10) || 200, 500);
  const onlyOpen = req.query?.all !== "1";
  const params = [limit];
  const where = onlyOpen ? "WHERE booking_sent_at IS NULL OR NULLIF(bl_no,'') IS NULL" : "";
  try {
    const r = await pool.query(
      `SELECT id, _id, shipment_no, contract_no, order_contract_nos, bl_no, so_no,
              forwarder_booking_no, forwarder_company_id, forwarder_cn,
              booking_sent_at, updated_at, created_at,
              (booking_sent_at IS NULL) AS missing_booking_submit,
              (NULLIF(bl_no,'') IS NULL) AS missing_bl
         FROM shipping_plans
        ${where}
        ORDER BY created_at DESC NULLS LAST
        LIMIT $1`,
      params
    );
    const rows = r.rows.map(row => {
      const gaps = [];
      if (row.missing_booking_submit) gaps.push("forwarder_booking_not_submitted");
      if (row.missing_bl) gaps.push("bl_not_returned");
      return { ...row, gaps };
    });
    return res.status(200).json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
