// seed-zc-group.js
// 一次性：初始化烟台中宠集团结构
// GET /api/db/seed-zc-group  (Sanlyn admin only)

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "admin only" });

  var pool = getPool();
  var log = [];

  // 1. 升级 CN-00051 为集团根
  var r1 = await pool.query(
    `UPDATE customers SET
       group_code = 'ZC',
       group_name = '烟台中宠集团',
       parent_company_code = NULL,
       raw = COALESCE(raw, '{}'::jsonb) || '{"plan":"vip"}'::jsonb,
       updated_at = NOW()
     WHERE company_code = 'CN-00051'
     RETURNING company_code, name_en, group_code, group_name`,
    []
  );
  log.push("Root updated: " + JSON.stringify(r1.rows[0]));

  // 2. 创建 OEM 部门
  var r2 = await pool.query(
    `INSERT INTO customers
       (company_code, name_en, name_cn, group_code, group_name, parent_company_code, is_active, created_at, updated_at)
     VALUES
       ('ZC-OEM', '烟台中宠-OEM', '烟台中宠食品-OEM部门', 'ZC', '烟台中宠集团', 'CN-00051', true, NOW(), NOW())
     ON CONFLICT (company_code) DO UPDATE SET
       name_en = EXCLUDED.name_en,
       name_cn = EXCLUDED.name_cn,
       group_code = 'ZC',
       group_name = '烟台中宠集团',
       parent_company_code = 'CN-00051',
       updated_at = NOW()
     RETURNING company_code, name_en`,
    []
  );
  log.push("OEM dept: " + JSON.stringify(r2.rows[0]));

  // 3. 创建 BRAND 部门
  var r3 = await pool.query(
    `INSERT INTO customers
       (company_code, name_en, name_cn, group_code, group_name, parent_company_code, is_active, created_at, updated_at)
     VALUES
       ('ZC-BRAND', '烟台中宠-BRAND', '烟台中宠食品-品牌部门', 'ZC', '烟台中宠集团', 'CN-00051', true, NOW(), NOW())
     ON CONFLICT (company_code) DO UPDATE SET
       name_en = EXCLUDED.name_en,
       name_cn = EXCLUDED.name_cn,
       group_code = 'ZC',
       group_name = '烟台中宠集团',
       parent_company_code = 'CN-00051',
       updated_at = NOW()
     RETURNING company_code, name_en`,
    []
  );
  log.push("BRAND dept: " + JSON.stringify(r3.rows[0]));

  // 4. 验证
  var all = await pool.query(
    `SELECT company_code, name_en, group_code, parent_company_code FROM customers WHERE group_code = 'ZC' ORDER BY company_code`
  );
  log.push("ZC group members: " + JSON.stringify(all.rows));

  return res.status(200).json({ success: true, log });
}
