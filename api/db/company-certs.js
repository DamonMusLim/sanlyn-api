// company-certs.js
// 公司资质证书 CRUD — 工厂/外贸自己管理自己公司的证书
//
// GET  /api/db/company-certs?role=factory   — 返回该角色所有 cert_type_config + 本公司已填数据（合并）
// POST /api/db/company-certs                — upsert 一条证书记录（cert_key + 证书数据）
// DELETE /api/db/company-certs?cert_key=xx  — 删除一条（soft: status='removed'）
//
// 权限：req.user.companyCode 即本公司，不能查/改别人的

import { getPool, setCors } from "../db.js";

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_certs (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_code  VARCHAR(32) NOT NULL,
      cert_key      VARCHAR(64) NOT NULL,
      cert_no       VARCHAR(128),
      issued_at     DATE,
      expires_at    DATE,
      issuer        VARCHAR(256),
      cert_file_url TEXT,
      status        VARCHAR(16) DEFAULT 'active',
      note          TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_code, cert_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_company_certs_code ON company_certs(company_code)
  `);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var pool = getPool();
  var isAdmin = req.user.role === "admin" || req.user.role === "super_admin";
  var overrideCode = isAdmin ? (req.query?.company_code || req.body?.company_code) : null;
  var myCode = overrideCode || req.user.companyCode || req.user.company_code;
  if (!myCode) {
    if (req.method === "GET") return res.status(200).json({ success: true, company_code: null, data: [] });
    return res.status(400).json({ error: "company_code missing from token" });
  }

  await ensureTable(pool);

  // ── GET: cert_type_config (for role) merged with company_certs ──
  if (req.method === "GET") {
    var role = req.query?.role || "factory";

    // Role alias mapping — normalize incoming role names to cert category
    var ROLE_ALIAS = {
      // buyer / customer variants
      "customer":          "customer",
      "buyer":             "customer",
      "client":            "customer",
      // factory / seller variants
      "factory":           "factory",
      "seller":            "factory",
      "trader":            "seller",
      "trader_internal":   "seller",
      "direct_export":     "factory",
      "supplier_limited":  "factory",
      // forwarder / logistics
      "forwarder":         "forwarder",
      "logistics":         "forwarder",
      "ocean":             "forwarder",
      // supply chain types
      "supply_chain":      "forwarder",    // fallback until SC-specific seeds exist
      "customs":           "forwarder",
      "trucking":          "forwarder",
      "inspection":        "forwarder",
      "warehouse":         "forwarder",
      // broker
      "broker_factory":    "seller",
      "broker_customer":   "customer",
      "broker_supply":     "forwarder",
      // platform
      "admin":             "seller",       // admin sees seller certs by default
      "platform_admin":    "seller",
      "platform_finance":  "seller",
      "finance":           "seller",
    };
    role = ROLE_ALIAS[role] || role;  // normalize, keep original if no alias

    // 1. 拉出该角色需要的 cert 类型（只取 active 的）
    var typesRes = await pool.query(
      `SELECT cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, warn_days, sort_order
       FROM cert_type_config
       WHERE active = true AND $1 = ANY(company_roles)
       ORDER BY sort_order ASC, cert_key ASC`,
      [role]
    );

    // 2. 拉出本公司已有的证书数据
    var certsRes = await pool.query(
      `SELECT cert_key, cert_no, issued_at, expires_at, issuer, cert_file_url, status, note, updated_at
       FROM company_certs WHERE company_code = $1`,
      [myCode]
    );

    var certMap = {};
    certsRes.rows.forEach(function(c) { certMap[c.cert_key] = c; });

    // 3. 合并：每个 type 附上已有数据 + 到期状态
    var merged = typesRes.rows.map(function(t) {
      var existing = certMap[t.cert_key] || null;
      var daysLeft = null;
      var expStatus = "none"; // none | ok | warning | expired
      if (existing && existing.expires_at) {
        daysLeft = Math.floor((new Date(existing.expires_at) - new Date()) / 86400000);
        expStatus = daysLeft < 0 ? "expired" : daysLeft <= (t.warn_days || 30) ? "warning" : "ok";
      } else if (existing && existing.cert_file_url) {
        expStatus = t.expire_track ? "no_date" : "ok";
      }
      return Object.assign({}, t, { existing: existing, days_left: daysLeft, exp_status: expStatus });
    });

    return res.status(200).json({ success: true, company_code: myCode, data: merged });
  }

  // ── POST: upsert a cert record ──
  if (req.method === "POST") {
    var body = req.body || {};
    var { cert_key, cert_no, issued_at, expires_at, issuer, cert_file_url, note } = body;
    if (!cert_key) return res.status(400).json({ error: "cert_key required" });

    await pool.query(
      `INSERT INTO company_certs (company_code, cert_key, cert_no, issued_at, expires_at, issuer, cert_file_url, note, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',NOW())
       ON CONFLICT (company_code, cert_key) DO UPDATE SET
         cert_no       = EXCLUDED.cert_no,
         issued_at     = EXCLUDED.issued_at,
         expires_at    = EXCLUDED.expires_at,
         issuer        = EXCLUDED.issuer,
         cert_file_url = EXCLUDED.cert_file_url,
         note          = EXCLUDED.note,
         status        = 'active',
         updated_at    = NOW()`,
      [myCode, cert_key, cert_no||null, issued_at||null, expires_at||null, issuer||null, cert_file_url||null, note||null]
    );

    return res.status(200).json({ success: true, company_code: myCode, cert_key });
  }

  // ── DELETE: soft remove ──
  if (req.method === "DELETE") {
    var certKey = req.query?.cert_key;
    if (!certKey) return res.status(400).json({ error: "cert_key required" });
    await pool.query(
      `UPDATE company_certs SET status='removed', updated_at=NOW() WHERE company_code=$1 AND cert_key=$2`,
      [myCode, certKey]
    );
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
