import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var results = [];

    var cols = [
      ["brands",        "JSONB DEFAULT '[]'::jsonb"],
      ["addresses",     "JSONB DEFAULT '[]'::jsonb"],
      ["contact_name",  "VARCHAR(128) DEFAULT ''"],
      ["contact_phone", "VARCHAR(64) DEFAULT ''"],
      ["contact_email", "VARCHAR(128) DEFAULT ''"],
      ["country",       "VARCHAR(64) DEFAULT ''"],
      ["currency",      "VARCHAR(8) DEFAULT 'USD'"],
      ["payment_term",  "VARCHAR(128) DEFAULT ''"],
      ["portal_role",   "VARCHAR(32) DEFAULT 'customer'"],
      ["group_id",      "VARCHAR(64) DEFAULT ''"],
      ["invoice",       "JSONB DEFAULT '{}'::jsonb"],
      ["is_active",     "BOOLEAN DEFAULT true"],
      ["name_en",       "VARCHAR(256) DEFAULT ''"],
      ["name_cn",       "VARCHAR(256) DEFAULT ''"],
    ];

    for (var c of cols) {
      try {
        await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS " + c[0] + " " + c[1]);
        results.push(c[0] + ": added");
      } catch (e) {
        results.push(c[0] + ": " + e.message);
      }
    }

    // Also ensure unique constraint on company_code
    try {
      await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_cust_code_uniq ON customers(company_code)");
      results.push("unique index: ok");
    } catch (e) {
      results.push("unique index: " + e.message);
    }

    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
