// migrate-customers-v2.js
// 主数据 v2.0 — customers 表升级
// 详细设计见 ~/Desktop/Sanlyn/blueprints/master-tables-v2.md §1
//
// 9 个新字段:
//   roles                JSONB   — 多角色数组 ["buyer","factory"]，老 role 兼容保留
//   parent_company_code  VARCHAR — 自关联，集团母公司
//   group_name           VARCHAR — 老板自定义集团名
//   kyc_status           VARCHAR — pending/verified/expired/rejected
//   kyc_docs             JSONB   — DAS 文件指针清单 (business_license/bank/iso/...)
//   kyc_verified_at      TIMESTAMPTZ
//   kyc_verified_by      VARCHAR
//   bank_swift           VARCHAR — SWIFT/BIC
//   bank_branch          VARCHAR — 支行 (踩坑: PUBLIC BANK·JALAN ABDULLAH)
//
// 幂等：全部 IF NOT EXISTS。GET ?dry_run=true 仅返回 plan。

import { getPool, setCors } from "../db.js";

var PLAN = [
  ["customers.roles",                "ALTER TABLE customers ADD COLUMN IF NOT EXISTS roles JSONB DEFAULT '[]'::jsonb"],
  ["customers.parent_company_code",  "ALTER TABLE customers ADD COLUMN IF NOT EXISTS parent_company_code VARCHAR(32)"],
  ["customers.group_name",           "ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_name VARCHAR(128)"],
  ["customers.kyc_status",           "ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(16) DEFAULT 'pending'"],
  ["customers.kyc_docs",             "ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_docs JSONB DEFAULT '{}'::jsonb"],
  ["customers.kyc_verified_at",      "ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ"],
  ["customers.kyc_verified_by",      "ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_verified_by VARCHAR(64)"],
  ["customers.bank_swift",           "ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_swift VARCHAR(16)"],
  ["customers.bank_branch",          "ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_branch VARCHAR(128)"],

  ["idx customers.parent",           "CREATE INDEX IF NOT EXISTS idx_customers_parent ON customers(parent_company_code)"],
  ["idx customers.kyc_status",       "CREATE INDEX IF NOT EXISTS idx_customers_kyc_status ON customers(kyc_status)"],
  ["idx customers.group_name",       "CREATE INDEX IF NOT EXISTS idx_customers_group ON customers(group_name)"],

  // Backfill: 老 role (单串) 同步到 roles[] 数组
  ["backfill roles[]",
    "UPDATE customers SET roles = jsonb_build_array(role) WHERE (roles IS NULL OR roles = '[]'::jsonb) AND role IS NOT NULL AND role != ''"],

  // 老客户 (合作过的) 视为已认证 — kyc_status='verified' for is_active=true 老客户
  ["backfill kyc_status for existing trusted",
    "UPDATE customers SET kyc_status = 'verified', kyc_verified_at = COALESCE(updated_at, created_at, NOW()), kyc_verified_by = 'legacy_trust' WHERE is_active = true AND (kyc_status IS NULL OR kyc_status = 'pending') AND created_at < '2026-04-29'"],
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  var dryRun = req.method === "GET" || req.query?.dry_run === "true";

  try {
    if (dryRun) {
      var cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'customers' ORDER BY ordinal_position"
      );
      var counts = await pool.query(
        "SELECT COUNT(*)::int AS total, " +
        "SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS active, " +
        "SUM(CASE WHEN role = 'factory' THEN 1 ELSE 0 END)::int AS factories " +
        "FROM customers"
      );
      return res.status(200).json({
        success: true,
        mode: "dry_run",
        plan: PLAN.map(p => ({ step: p[0], sql: p[1] })),
        currentColumns: cols.rows.map(c => c.column_name),
        stats: counts.rows[0],
        note: "POST to execute. All steps idempotent (IF NOT EXISTS).",
      });
    }

    var results = [];
    for (var i = 0; i < PLAN.length; i++) {
      var [name, sql] = PLAN[i];
      try {
        var r = await pool.query(sql);
        results.push({ step: name, ok: true, rowCount: r.rowCount });
      } catch (e) {
        results.push({ step: name, ok: false, error: e.message });
      }
    }
    return res.status(200).json({ success: true, executed: results.length, results });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
