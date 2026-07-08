import "dotenv/config";
import { getPool } from "../api/db.js";
import { classifyFobScope } from "../api/db/invoice-collab-confirm.js";

const pool = getPool();

try {
  const r = await pool.query(
    `SELECT id, canonical_category, cost_category, fob_scope
       FROM freight_supplier_bills
      ORDER BY id`
  );

  let updated = 0;
  for (const row of r.rows) {
    const scope = classifyFobScope(row.canonical_category, row.cost_category);
    if (row.fob_scope === scope) continue;
    await pool.query(
      `UPDATE freight_supplier_bills
          SET fob_scope=$2
        WHERE id=$1
          AND fob_scope IS DISTINCT FROM $2`,
      [row.id, scope]
    );
    updated += 1;
  }

  console.log(`fob_scope backfill complete: scanned=${r.rowCount} updated=${updated}`);
} finally {
  await pool.end();
}
