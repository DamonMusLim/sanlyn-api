#!/usr/bin/env node
import pkg from '/opt/sanlyn-api-test/node_modules/pg/lib/index.js';
const { Pool } = pkg;

const commit = process.argv.includes("--commit");
const pool = new Pool({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || "sanlyn_db",
  user: process.env.PG_USER || "sanlyn_admin",
  password: process.env.PG_PASSWORD,
});

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const candidates = await q(`
  SELECT id, link_plan_id, bl_no
    FROM freight_supplier_bills
   WHERE NULLIF(BTRIM(COALESCE(link_plan_id, '')), '') IS NOT NULL
     AND link_plan_id !~ '^[0-9]+$'
   ORDER BY bl_no NULLS LAST, id
`);

let normalizable = 0;
let skipped = 0;

console.log(`${commit ? "[COMMIT]" : "[DRY]"} freight_supplier_bills.link_plan_id 非整数候选 ${candidates.length} 行`);
console.log("id | old_link_plan_id | bl_no | -> new_plan_id | action");

try {
  if (commit) await pool.query("BEGIN");

  for (const row of candidates) {
    const plans = row.bl_no ? await q(`
      SELECT id
        FROM shipping_plans
       WHERE bl_no = $1
         AND bl_no NOT LIKE '%#%'
       ORDER BY id
    `, [row.bl_no]) : [];

    if (plans.length === 1) {
      normalizable++;
      const newPlanId = String(plans[0].id);
      console.log(`${row.id} | ${row.link_plan_id} | ${row.bl_no || ""} | -> ${newPlanId} | ${commit ? "update" : "would_update"}`);
      if (commit) {
        await pool.query(
          `UPDATE freight_supplier_bills
              SET link_plan_id = $2
            WHERE id = $1`,
          [row.id, newPlanId]
        );
      }
      continue;
    }

    skipped++;
    console.log(`${row.id} | ${row.link_plan_id} | ${row.bl_no || ""} | -> | skip:${plans.length === 0 ? "no_plan" : "ambiguous_plan"}`);
  }

  if (commit) await pool.query("COMMIT");
  console.log(`\n${commit ? "已归一" : "可归一"} ${normalizable} 行; 跳过 ${skipped} 行`);
} catch (err) {
  if (commit) await pool.query("ROLLBACK");
  throw err;
} finally {
  await pool.end();
}
