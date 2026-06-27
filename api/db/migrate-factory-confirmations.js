// migrate-factory-confirmations.js
// Adds factory order confirmation support:
//   - factory_confirmations table (audit log of every confirm action)
//   - orders snapshot columns (latest confirm snapshot for fast queries)
//
// Run: node api/db/migrate-factory-confirmations.js

import { getPool } from '../db.js';

const pool = getPool();

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. orders snapshot columns
    await client.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS confirmed_ship_date    DATE,
        ADD COLUMN IF NOT EXISTS confirmed_qty          JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS factory_confirmed_at   TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS factory_confirmed_by   TEXT,
        ADD COLUMN IF NOT EXISTS factory_confirmation_id BIGINT
    `);
    console.log('✓ orders columns added');

    // 2. factory_confirmations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS factory_confirmations (
        id                  BIGSERIAL PRIMARY KEY,
        order_no            TEXT        NOT NULL REFERENCES orders(order_no) ON UPDATE CASCADE,
        token_id            TEXT,
        company_code        TEXT,
        confirmed_lines     JSONB       NOT NULL DEFAULT '[]'::jsonb,
        confirmed_ship_date DATE        NOT NULL,
        note                TEXT,
        confirmed_by        TEXT        NOT NULL,
        source              TEXT        NOT NULL CHECK (source IN ('token','portal')),
        version             INT         NOT NULL DEFAULT 1,
        raw                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('✓ factory_confirmations table created');

    // One active confirmation per order (version=1 = current active)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_factory_confirmations_order_v1
        ON factory_confirmations(order_no)
        WHERE version = 1
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_factory_confirmations_company
        ON factory_confirmations(company_code, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_factory_confirmed_at
        ON orders(factory_confirmed_at)
        WHERE factory_confirmed_at IS NOT NULL
    `);
    console.log('✓ indexes created');

    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
