// migrate-factory-confirm-token-order.js
// Adds order_no to _idx_tokens so factory_confirm links can resolve their order.
//
// Run: node api/db/migrate-factory-confirm-token-order.js

import { getPool } from "../db.js";

const pool = getPool();

async function run() {
  try {
    await pool.query("ALTER TABLE _idx_tokens ADD COLUMN IF NOT EXISTS order_no TEXT");
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = '_idx_tokens'
         AND column_name = 'order_no'
    `);
    console.log("Migration complete.");
    console.table(rows);
  } catch (e) {
    console.error("Migration failed:", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
