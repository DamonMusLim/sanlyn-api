// migrate-sample-delivery-sign-fields.js
// POST /api/db/migrate-sample-delivery-sign-fields
// Add customer sign status/type fields to sample delivery sheets.
import { getPool, setCors } from "../db.js";

const SQL = `
ALTER TABLE sample_delivery_sheets
  ADD COLUMN IF NOT EXISTS customer_signed_status TEXT,
  ADD COLUMN IF NOT EXISTS customer_signed_type   TEXT;
`;

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pool = getPool();
  try {
    await pool.query(SQL);
    return res.status(200).json({
      ok: true,
      message: "sample_delivery_sheets customer sign fields added",
      columns: ["customer_signed_status", "customer_signed_type"],
    });
  } catch (err) {
    console.error("[migrate-sample-delivery-sign-fields] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
