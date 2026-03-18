import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    const result = await pool.query(`
      UPDATE shipping_plans SET
        bl_no        = NULLIF(TRIM(raw->>'blNo'), ''),
        vessel       = NULLIF(TRIM(raw->>'vessel'), ''),
        voyage       = NULLIF(TRIM(raw->>'voyageNo'), ''),
        etd          = CASE WHEN raw->>'etd' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (raw->>'etd')::date ELSE NULL END,
        eta          = CASE WHEN raw->>'eta' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (raw->>'eta')::date ELSE NULL END,
        container_no = NULLIF(TRIM(raw->>'containerNo'), ''),
        customs_cn   = NULLIF(TRIM(raw->>'customsCN'), ''),
        trucking_cn  = NULLIF(TRIM(raw->>'truckingCN'), ''),
        customer     = NULLIF(TRIM(COALESCE(raw->>'customerCompanyEN', raw->>'customerCompany')), ''),
        status       = CASE
          WHEN raw->>'flowStatus' IN ('流程结束（归档关闭）','客户确认收货（签收/异常）','流转完成') THEN 'completed'
          ELSE 'in_progress'
        END
      WHERE bl_no IS NULL OR customer IS NULL OR status IS NULL
      RETURNING _id, bl_no, customer, status
    `);
    return res.status(200).json({ success: true, updated: result.rowCount, sample: result.rows.slice(0,5) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
