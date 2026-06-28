/**
 * migrate-factory-orders.js — Factory PO (FPO) 模块建表
 * 2026-05-19
 *
 * 建表:
 *   factory_orders        — BABI 发给工厂的采购单（主表）
 *   factory_order_events  — FPO 协同事件流（audit trail）
 *
 * 幂等. 调用:
 *   curl -X POST https://api.sanlyn.cn/api/db/migrate-factory-orders \
 *        -H "Authorization: Bearer <ADMIN_JWT>"
 */

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const STATEMENTS = [
  // ── factory_orders ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS factory_orders (
    id              SERIAL PRIMARY KEY,
    _id             VARCHAR NOT NULL UNIQUE,
    fpo_no          VARCHAR NOT NULL UNIQUE,
    factory_code    VARCHAR NOT NULL,
    factory_company_id INTEGER,
    factory_invoice_no VARCHAR,
    buyer_code      VARCHAR DEFAULT 'BABI',
    customer_order_contract_nos JSONB DEFAULT '[]',
    customer_po_refs JSONB DEFAULT '[]',
    payment_terms   VARCHAR DEFAULT '30/70',
    incoterms       VARCHAR DEFAULT 'EXW Qingdao',
    currency        VARCHAR DEFAULT 'CNY',
    status          VARCHAR DEFAULT 'draft',
    gross_amount    NUMERIC,
    discount        NUMERIC DEFAULT 0,
    net_amount      NUMERIC,
    deposit_paid    NUMERIC DEFAULT 0,
    balance_paid    NUMERIC DEFAULT 0,
    po_date         DATE,
    factory_confirmed_at TIMESTAMP,
    expected_ready_date  DATE,
    actual_ready_date    DATE,
    raw             JSONB DEFAULT '{}',
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_factory_orders_factory_code ON factory_orders(factory_code)`,
  `CREATE INDEX IF NOT EXISTS idx_factory_orders_status ON factory_orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_factory_orders_buyer_code ON factory_orders(buyer_code)`,
  `CREATE INDEX IF NOT EXISTS idx_factory_orders_customer_orders
     ON factory_orders USING GIN(customer_order_contract_nos)`,

  // ── factory_order_events ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS factory_order_events (
    id              SERIAL PRIMARY KEY,
    fpo_no          VARCHAR NOT NULL,
    event_type      VARCHAR NOT NULL,
    actor           VARCHAR,
    notes           TEXT,
    payload         JSONB DEFAULT '{}',
    created_at      TIMESTAMP DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_factory_order_events_fpo
     ON factory_order_events(fpo_no, created_at DESC)`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }

  const pool = getPool();
  const results = [];
  try {
    for (const sql of STATEMENTS) {
      const r = await pool.query(sql);
      results.push({ sql: sql.trim().slice(0, 80) + "…", rowCount: r.rowCount ?? 0 });
    }
    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
