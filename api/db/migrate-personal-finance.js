// api/db/migrate-personal-finance.js
// 个人财务表 — 与业务数据完全隔离
// owner='damon' 标记，未来其他用户用各自 owner 区分

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

var STATEMENTS = [

  // ── 1. personal_loans 借款主表 ─────────────────────────
  `CREATE TABLE IF NOT EXISTS personal_loans (
    id              SERIAL PRIMARY KEY,
    owner           VARCHAR(32) DEFAULT 'damon',
    borrower_name   VARCHAR(64) NOT NULL,
    direction       VARCHAR(8)  DEFAULT 'out'
                    CHECK (direction IN ('out','in')),
    principal       DECIMAL(14,2) NOT NULL,
    monthly_interest DECIMAL(12,2) DEFAULT 0,
    monthly_cost    DECIMAL(12,2) DEFAULT 0,
    monthly_net     DECIMAL(12,2) DEFAULT 0,
    start_date      DATE NOT NULL,
    due_date        DATE,
    bank_source     VARCHAR(64),
    bank_repay_day  INTEGER,
    status          VARCHAR(20) DEFAULT 'active'
                    CHECK (status IN ('active','overdue','closed','cancelled')),
    note            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_pl_owner ON personal_loans(owner, status)`,

  // ── 2. personal_loan_payments 利息收款明细 ─────────────
  `CREATE TABLE IF NOT EXISTS personal_loan_payments (
    id              SERIAL PRIMARY KEY,
    loan_id         INTEGER REFERENCES personal_loans(id) ON DELETE CASCADE,
    expected_date   DATE NOT NULL,
    expected_amount DECIMAL(12,2) NOT NULL,
    cost            DECIMAL(12,2) DEFAULT 0,
    net_profit      DECIMAL(12,2) DEFAULT 0,
    received_date   DATE,
    received_amount DECIMAL(12,2),
    status          VARCHAR(20) DEFAULT 'pending'
                    CHECK (status IN ('pending','received','overdue','partial','waived')),
    note            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_plp_loan ON personal_loan_payments(loan_id, expected_date)`,
  `CREATE INDEX IF NOT EXISTS idx_plp_status ON personal_loan_payments(status, expected_date)`,

  // ── 3. personal_assets 资产明细（存款/股权/资产） ───────
  `CREATE TABLE IF NOT EXISTS personal_assets (
    id              SERIAL PRIMARY KEY,
    owner           VARCHAR(32) DEFAULT 'damon',
    category        VARCHAR(32) NOT NULL,
    asset_name      VARCHAR(128) NOT NULL,
    amount          DECIMAL(14,2) DEFAULT 0,
    currency        VARCHAR(8)  DEFAULT 'CNY',
    note            TEXT,
    snapshot_date   DATE DEFAULT CURRENT_DATE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── 4. personal_living_expenses 生活费记录 ──────────────
  `CREATE TABLE IF NOT EXISTS personal_living_expenses (
    id              SERIAL PRIMARY KEY,
    owner           VARCHAR(32) DEFAULT 'damon',
    category        VARCHAR(32) NOT NULL,
    item            VARCHAR(128),
    amount          DECIMAL(12,2) NOT NULL,
    spend_date      DATE NOT NULL,
    payment_method  VARCHAR(32),
    note            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ple_date ON personal_living_expenses(owner, spend_date DESC)`,

  // ── 5. personal_collection_log 催收日志 ─────────────────
  `CREATE TABLE IF NOT EXISTS personal_collection_log (
    id              SERIAL PRIMARY KEY,
    loan_id         INTEGER REFERENCES personal_loans(id),
    contact_date    DATE NOT NULL,
    method          VARCHAR(32),
    their_response  TEXT,
    my_request      TEXT,
    next_followup   DATE,
    evidence_url    TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  try {
    var pool = getPool();
    var log = [];
    for (var sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.slice(0, 80).replace(/\s+/g, " "));
    }
    return res.status(200).json({ ok: true, log });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
