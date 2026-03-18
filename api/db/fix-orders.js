import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    const result = await pool.query(`
      UPDATE orders SET
        etd              = CASE WHEN raw->>'etd' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (raw->>'etd')::date ELSE NULL END,
        eta              = CASE WHEN raw->>'eta' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (raw->>'eta')::date ELSE NULL END,
        status           = NULLIF(TRIM(raw->>'productionStatus'), ''),
        production_status= NULLIF(TRIM(raw->>'productionStatus'), '')
      WHERE etd IS NULL AND (raw->>'etd' IS NOT NULL AND raw->>'etd' != '')
         OR eta IS NULL AND (raw->>'eta' IS NOT NULL AND raw->>'eta' != '')
      RETURNING _id, contract_no, etd, eta, status
    `);
    return res.status(200).json({ success: true, updated: result.rowCount, sample: result.rows.slice(0,5) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
