import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    const result = await pool.query(`
      UPDATE orders SET
        raw = raw || jsonb_build_object('companyCode',
          CASE
            WHEN customer ILIKE '%PETSOME (EU)%' OR customer ILIKE '%PETSOME EU%' THEN 'PETSOME_EU'
            WHEN customer ILIKE '%PETSOME%'           THEN 'PETSOME'
            WHEN customer ILIKE '%DIBAQ%'             THEN 'DIBAQ'
            WHEN customer ILIKE '%HARMONIOUS%'        THEN 'HARMONIOUS'
            WHEN customer ILIKE '%ENRICH%'            THEN 'ENRICH'
            WHEN customer ILIKE '%JJ PET%'            THEN 'JJ_PET'
            WHEN customer ILIKE '%FORTUNESANLYN%'     THEN 'FORTUNESANLYN'
            WHEN customer ILIKE '%EVERSPARKLES%'      THEN 'EVERSPARKLES'
            WHEN customer ILIKE '%MAGROS%'            THEN 'MAGROS'
            ELSE raw->>'companyCode'
          END
        )
      WHERE (raw->>'companyCode' IS NULL OR raw->>'companyCode' = '')
        AND customer IS NOT NULL
      RETURNING _id, customer, raw->>'companyCode' as new_code
    `);
    return res.status(200).json({ success: true, updated: result.rowCount, rows: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
