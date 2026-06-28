// migrate-sample-requests.js
// POST /api/db/migrate-sample-requests  (admin only)
// Idempotent: adds price_visible to company_products + creates sample_requests table
// + adds assigned_to to tasks + expands tasks constraints to allow 'supply' level

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
    try {
      await pool.query(sql);
      results.push("✅ " + label);
    } catch (e) {
      results.push("⚠️ " + label + ": " + e.message);
    }
  };

  // 1. price_visible on company_products
  await run(
    "company_products.price_visible",
    `ALTER TABLE company_products ADD COLUMN IF NOT EXISTS price_visible BOOLEAN NOT NULL DEFAULT true`
  );

  // 2. assigned_to on tasks
  await run(
    "tasks.assigned_to",
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to TEXT`
  );

  // 3. Expand tasks level constraint to allow 'supply'
  await run(
    "drop tasks_level_check",
    `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_level_check`
  );
  await run(
    "add tasks_level_check (with supply)",
    `ALTER TABLE tasks ADD CONSTRAINT tasks_level_check
     CHECK (level IN ('order','factory','doc','logi','approve','supply') OR level IS NULL)`
  );

  // 4. Expand tasks owner_object_type constraint to allow 'supply_chain'
  await run(
    "drop tasks_owner_type_check",
    `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_owner_type_check`
  );
  await run(
    "add tasks_owner_type_check (with supply_chain)",
    `ALTER TABLE tasks ADD CONSTRAINT tasks_owner_type_check
     CHECK (owner_object_type IN ('order','factory','document','logistics','supply_chain') OR owner_object_type IS NULL)`
  );

  // 5. sample_requests table
  await run(
    "create sample_requests",
    `CREATE TABLE IF NOT EXISTS sample_requests (
      id            VARCHAR(48) PRIMARY KEY,
      task_id       VARCHAR(48),
      company_code  TEXT,
      product_name  TEXT NOT NULL,
      spec          TEXT,
      qty           TEXT,
      budget        TEXT,
      notes         TEXT,
      image_names   JSONB DEFAULT '[]'::jsonb,
      requested_by  TEXT,
      assigned_to   TEXT DEFAULT 'xiamen-babi',
      status        TEXT NOT NULL DEFAULT 'open',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`
  );

  await run(
    "idx_sample_requests_company",
    `CREATE INDEX IF NOT EXISTS idx_sample_requests_company ON sample_requests(company_code)`
  );
  await run(
    "idx_sample_requests_status",
    `CREATE INDEX IF NOT EXISTS idx_sample_requests_status ON sample_requests(status)`
  );

  return res.status(200).json({ success: true, results });
}
