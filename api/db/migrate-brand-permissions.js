// migrate-brand-permissions.js — company_brand_permissions table
// POST /api/db/migrate-brand-permissions
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const pool = getPool();
  const results = [];
  const run = async (label, sql) => {
    try { await pool.query(sql); results.push("✅ " + label); }
    catch (e) { results.push("⚠️ " + label + ": " + e.message); }
  };

  await run("create company_brand_permissions", `
    CREATE TABLE IF NOT EXISTS company_brand_permissions (
      id              SERIAL PRIMARY KEY,
      tenant_code     TEXT NOT NULL DEFAULT 'SANLYN',
      company_code    TEXT NOT NULL,
      brand           TEXT NOT NULL,
      visibility      TEXT NOT NULL DEFAULT 'hidden'
                      CHECK (visibility IN ('full', 'rfq', 'hidden')),
      source          TEXT DEFAULT 'manual'
                      CHECK (source IN (
                        'manual',
                        'migrated_from_customers_brands',
                        'contract',
                        'system',
                        'import'
                      )),
      note            TEXT,
      created_by      TEXT,
      updated_by      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tenant_code, company_code, brand)
    )
  `);

  await run("idx_cbp_tenant_company", `
    CREATE INDEX IF NOT EXISTS idx_cbp_tenant_company
    ON company_brand_permissions(tenant_code, company_code)
  `);

  await run("idx_cbp_brand", `
    CREATE INDEX IF NOT EXISTS idx_cbp_brand
    ON company_brand_permissions(brand)
  `);

  await run("migrate customers.brands → company_brand_permissions (44 rows expected)", `
    INSERT INTO company_brand_permissions
      (tenant_code, company_code, brand, visibility, source, created_by)
    SELECT
      'SANLYN',
      c.company_code,
      b.brand,
      'full',
      'migrated_from_customers_brands',
      'system:brand-migration-2026-05'
    FROM customers c
    CROSS JOIN LATERAL jsonb_array_elements_text(c.brands) AS b(brand)
    WHERE c.brands IS NOT NULL
      AND c.brands != 'null'::jsonb
      AND jsonb_array_length(c.brands) > 0
    ON CONFLICT (tenant_code, company_code, brand) DO NOTHING
  `);

  // Count verification
  let rowCount = 0;
  try {
    const countR = await pool.query("SELECT COUNT(*) as total FROM company_brand_permissions");
    rowCount = Number(countR.rows[0].total);
    results.push("✅ count verification: " + rowCount + " rows in company_brand_permissions");
  } catch (e) {
    results.push("⚠️ count verification: " + e.message);
  }

  return res.status(200).json({ success: true, results, rowCount });
}
