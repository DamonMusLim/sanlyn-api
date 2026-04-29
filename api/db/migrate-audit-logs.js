// migrate-audit-logs.js
// v2.0 升级 — 在已有 audit_logs (S94) 基础上加 entity 关联字段 + before/after diff
// 蓝图 §12.12 + §13 Day 1
//
// 已有列保留 (action/operator/role/company/contract_no/document_*/detail/created_at)
// 新增列:
//   entity_type    VARCHAR(32)   — customer/order/payment/sailing
//   entity_id      VARCHAR(64)
//   before         JSONB
//   after          JSONB
//   diff_summary   TEXT
//   ip             VARCHAR(45)
//   user_agent     TEXT
//   request_id     VARCHAR(64)
//
// 老 operator 字段继续作为 actor_id 使用，不重复造列

import { getPool, setCors } from "../db.js";

var PLAN = [
  // 确保表存在 (兼容首次部署环境)
  ["ensure table",
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      action VARCHAR(50) NOT NULL,
      operator VARCHAR(100),
      role VARCHAR(50),
      company VARCHAR(200),
      contract_no VARCHAR(100),
      document_id VARCHAR(200),
      document_name VARCHAR(200),
      document_key VARCHAR(50),
      detail JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`],

  // v2 新增列
  ["audit.entity_type",  "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type  VARCHAR(32)"],
  ["audit.entity_id",    "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id    VARCHAR(64)"],
  ["audit.before",       "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before       JSONB DEFAULT '{}'::jsonb"],
  ["audit.after",        "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after        JSONB DEFAULT '{}'::jsonb"],
  ["audit.diff_summary", "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS diff_summary TEXT"],
  ["audit.ip",           "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip           VARCHAR(45)"],
  ["audit.user_agent",   "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent   TEXT"],
  ["audit.request_id",   "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id   VARCHAR(64)"],

  // 索引
  ["idx audit.entity",   "CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_logs(entity_type, entity_id)"],
  ["idx audit.actor",    "CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_logs(operator)"],
  ["idx audit.action",   "CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_logs(action)"],
  ["idx audit.created",  "CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_logs(created_at DESC)"],
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  var dryRun = req.method === "GET" || req.query?.dry_run === "true";

  if (dryRun) {
    var cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_logs' ORDER BY ordinal_position"
    ).catch(() => ({ rows: [] }));
    return res.status(200).json({
      success: true,
      mode: "dry_run",
      plan: PLAN.map(p => ({ step: p[0] })),
      currentColumns: cols.rows.map(c => c.column_name),
      note: "POST to execute. Idempotent.",
    });
  }

  var results = [];
  for (var [name, sql] of PLAN) {
    try {
      await pool.query(sql);
      results.push({ step: name, ok: true });
    } catch (e) {
      results.push({ step: name, ok: false, error: e.message });
    }
  }
  return res.status(200).json({ success: true, results });
}
