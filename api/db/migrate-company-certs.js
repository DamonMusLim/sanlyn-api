// migrate-company-certs.js
// 公司资质证书管理 — 两张表
//
// cert_type_config : admin 配置，按角色定义需要哪些证书
// company_certs    : 公司上传的实际证书（OCR核验 + 两步确认）
//
// 幂等：全部 IF NOT EXISTS。GET ?dry_run=true 预览。

import { getPool, setCors } from "../db.js";

var PLAN = [
  // ── 证书类型配置表 ──
  ["cert_type_config table", `
    CREATE TABLE IF NOT EXISTS cert_type_config (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cert_key     VARCHAR(64) UNIQUE NOT NULL,
      cert_name_cn VARCHAR(128) NOT NULL,
      cert_name_en VARCHAR(128),
      company_roles TEXT[] NOT NULL DEFAULT '{}',
      required     BOOLEAN DEFAULT false,
      expire_track BOOLEAN DEFAULT true,
      warn_days    INT DEFAULT 30,
      sort_order   INT DEFAULT 99,
      active       BOOLEAN DEFAULT true,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `],

  // ── 公司实际证书表 ──
  ["company_certs table", `
    CREATE TABLE IF NOT EXISTS company_certs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_code      VARCHAR(32) NOT NULL,
      cert_key          VARCHAR(64) NOT NULL,
      cert_no           VARCHAR(128),
      cert_name         VARCHAR(256),
      issuing_authority VARCHAR(256),
      issue_date        DATE,
      expire_date       DATE,
      file_url          VARCHAR(512),
      status            VARCHAR(16) DEFAULT 'pending',
      ocr_raw           JSONB DEFAULT '{}',
      ocr_confirmed     BOOLEAN DEFAULT false,
      verified_by       VARCHAR(64),
      verified_at       TIMESTAMPTZ,
      note              TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_code, cert_key)
    )
  `],

  ["idx company_certs.company_code", `
    CREATE INDEX IF NOT EXISTS idx_company_certs_code ON company_certs(company_code)
  `],
  ["idx company_certs.expire_date", `
    CREATE INDEX IF NOT EXISTS idx_company_certs_expire ON company_certs(expire_date) WHERE expire_date IS NOT NULL
  `],

  // ── 预埋证书类型（工厂）──
  ["seed: business_license", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('business_license','营业执照','Business License',ARRAY['factory','seller','forwarder'],true,true,1)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: food_production_license", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('food_production_license','食品生产许可证','Food Production License',ARRAY['factory'],true,true,2)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: feed_production_license", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('feed_production_license','饲料生产许可证','Feed Production License',ARRAY['factory'],false,true,3)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: export_registration", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('export_registration','出口备案证明','Export Registration',ARRAY['factory'],true,false,4)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: iso22000", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('iso22000','ISO 22000 食品安全管理体系','ISO 22000',ARRAY['factory'],false,true,5)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: haccp", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('haccp','HACCP认证','HACCP Certificate',ARRAY['factory'],false,true,6)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: fda", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('fda','FDA注册','FDA Registration',ARRAY['factory'],false,true,7)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: msds", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('msds','MSDS安全数据表','MSDS',ARRAY['factory'],false,false,8)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: en71", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('en71','EN71玩具安全认证','EN71 Toy Safety',ARRAY['factory'],false,true,9)
    ON CONFLICT (cert_key) DO NOTHING
  `],

  // ── 预埋证书类型（外贸公司）──
  ["seed: import_export_license", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('import_export_license','进出口经营权证','Import & Export License',ARRAY['seller'],true,false,10)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: general_taxpayer", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('general_taxpayer','一般纳税人资格证','General Taxpayer Certificate',ARRAY['seller'],true,false,11)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: aeo", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('aeo','AEO认证（海关高级认证）','AEO Certificate',ARRAY['seller','forwarder'],false,true,12)
    ON CONFLICT (cert_key) DO NOTHING
  `],

  // ── 预埋证书类型（货代）──
  ["seed: freight_forwarding_license", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('freight_forwarding_license','国际货代经营许可证','Freight Forwarding License',ARRAY['forwarder'],true,true,20)
    ON CONFLICT (cert_key) DO NOTHING
  `],
  ["seed: nvocc", `
    INSERT INTO cert_type_config (cert_key, cert_name_cn, cert_name_en, company_roles, required, expire_track, sort_order)
    VALUES ('nvocc','NVOCC无船承运人资质','NVOCC License',ARRAY['forwarder'],false,true,21)
    ON CONFLICT (cert_key) DO NOTHING
  `],
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  var dryRun = req.method === "GET" || req.query?.dry_run === "true";

  try {
    if (dryRun) {
      return res.status(200).json({
        success: true,
        mode: "dry_run",
        plan: PLAN.map(p => ({ step: p[0] })),
        note: "POST to execute. All steps idempotent.",
      });
    }

    var results = [];
    for (var [name, sql] of PLAN) {
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
