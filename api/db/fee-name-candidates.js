import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { cleanText } from "./lib/portcharge-close-loop.js";

async function standardFor(pool, name) {
  const r = await pool.query(
    `SELECT standard_item_code, standard_item_name, unit_basis,
            include_in_baseline, conditional_charge
       FROM carrier_tariff_charge_items
      WHERE standard_item_name = $1
      ORDER BY confidence DESC NULLS LAST
      LIMIT 1`,
    [name]
  );
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin" && req.user?.role !== "finance") {
    return res.status(403).json({ success: false, error: "admin or finance role required" });
  }
  const pool = getPool();
  try {
    if (req.method === "GET") {
      const status = cleanText(req.query.status || "pending");
      const r = await pool.query(
        `SELECT * FROM fee_name_candidates
          WHERE ($1 = 'all' OR status = $1)
          ORDER BY occurrences DESC, last_seen_at DESC
          LIMIT 300`,
        [status]
      );
      return res.status(200).json({ success: true, data: r.rows });
    }
    if (req.method !== "PATCH") return res.status(405).json({ success: false, error: "Method not allowed" });
    const body = req.body || {};
    const rawName = cleanText(body.raw_name);
    const status = cleanText(body.status);
    if (!rawName || !["adopted", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ success: false, error: "raw_name and valid status required" });
    }
    let suggested = cleanText(body.suggested_standard);
    if (status === "adopted") {
      if (!suggested) return res.status(400).json({ success: false, error: "suggested_standard required" });
      const std = await standardFor(pool, suggested);
      if (!std) return res.status(404).json({ success: false, error: "standard item not found" });
      await pool.query(
        `INSERT INTO carrier_tariff_charge_items
          (raw_carrier, raw_item_name, normalized_carrier, standard_item_code,
           standard_item_name, unit_basis, include_in_baseline, conditional_charge,
           confidence, notes)
         VALUES ('*', $1, '*', $2, $3, $4, $5, $6, 0.900, 'adopted from fee_name_candidates')
         ON CONFLICT (normalized_carrier, raw_item_name) DO UPDATE SET
           standard_item_code = EXCLUDED.standard_item_code,
           standard_item_name = EXCLUDED.standard_item_name,
           unit_basis = EXCLUDED.unit_basis,
           include_in_baseline = EXCLUDED.include_in_baseline,
           conditional_charge = EXCLUDED.conditional_charge,
           confidence = EXCLUDED.confidence,
           notes = EXCLUDED.notes`,
        [rawName, std.standard_item_code, std.standard_item_name, std.unit_basis, std.include_in_baseline, std.conditional_charge]
      );
      suggested = std.standard_item_name;
    }
    const r = await pool.query(
      `UPDATE fee_name_candidates
          SET status = $2, suggested_standard = NULLIF($3,''),
              last_seen_at = now()
        WHERE raw_name = $1
        RETURNING *`,
      [rawName, status, suggested]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, error: "candidate not found" });
    return res.status(200).json({ success: true, data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
