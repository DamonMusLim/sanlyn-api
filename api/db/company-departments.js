// company-departments.js
// 集团 / 部门管理
//
// GET  /api/db/company-departments          — 列出本公司所在集团的所有部门
// POST /api/db/company-departments          — 创建新部门（VIP 功能）
// PATCH /api/db/company-departments/:code  — 改部门名称（集团管理员）
//
// 逻辑：
//   - 集团根：parent_company_code IS NULL，group_code 有值
//   - 部门：parent_company_code = 根公司的 company_code，group_code 相同
//   - 集团账号（属于根公司）可看所有子部门
//   - 部门账号只看自己

import { getPool, setCors } from "../db.js";

function isVip(customer) {
  var raw = customer?.raw || {};
  var plan = (typeof raw === "string" ? JSON.parse(raw) : raw)?.plan || "";
  return plan === "vip" || customer?.grade === "vip";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var pool = getPool();
  var isAdmin = req.user.role === "admin" || req.user.role === "super_admin";
  var myCode = (isAdmin && (req.query?.company_code || req.body?.company_code))
    || req.user.companyCode || req.user.company_code;
  if (!myCode) return res.status(200).json({ success: true, group_code: null, departments: [] });

  // 拿本公司记录
  var meRes = await pool.query(
    `SELECT id, company_code, name_en, name_cn, group_code, group_name, parent_company_code, raw, grade
     FROM customers WHERE company_code = $1 LIMIT 1`,
    [myCode]
  );
  var me = meRes.rows[0];
  if (!me) return res.status(404).json({ error: "Company not found" });

  // 找集团根
  var rootCode = me.parent_company_code || me.company_code;
  var groupCode = me.group_code;

  // ── GET: list all departments in same group ──
  if (req.method === "GET") {
    if (!groupCode) return res.status(200).json({ success: true, group_code: null, departments: [] });

    var depts = await pool.query(
      `SELECT company_code, name_en, name_cn, parent_company_code, group_code, group_name, is_active
       FROM customers
       WHERE group_code = $1
       ORDER BY CASE WHEN parent_company_code IS NULL THEN 0 ELSE 1 END, company_code`,
      [groupCode]
    );

    return res.status(200).json({
      success: true,
      group_code: groupCode,
      group_name: me.group_name,
      root_code: rootCode,
      my_code: myCode,
      is_root: !me.parent_company_code,
      departments: depts.rows,
    });
  }

  // ── POST: create a new department (VIP only) ──
  if (req.method === "POST") {
    if (!isVip(me)) {
      return res.status(403).json({ error: "vip_required", message: "Creating departments is a VIP feature." });
    }

    // Only root can create departments
    if (me.parent_company_code) {
      return res.status(403).json({ error: "Only the group root account can create departments." });
    }

    var { dept_name_en, dept_name_cn } = req.body || {};
    if (!dept_name_en) return res.status(400).json({ error: "dept_name_en required" });

    // Auto-generate dept company_code: root + suffix
    var suffix = dept_name_en.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8);
    var newCode = myCode + "-" + suffix;

    // Ensure unique
    var exists = await pool.query("SELECT 1 FROM customers WHERE company_code = $1", [newCode]);
    if (exists.rowCount > 0) {
      newCode = newCode + "_" + Date.now().toString().slice(-4);
    }

    await pool.query(
      `INSERT INTO customers
         (company_code, name_en, name_cn, group_code, group_name, parent_company_code, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())`,
      [newCode, dept_name_en, dept_name_cn || "", groupCode, me.group_name, myCode]
    );

    return res.status(200).json({ success: true, company_code: newCode, name_en: dept_name_en });
  }

  // ── PATCH: rename a department ──
  if (req.method === "PATCH") {
    if (me.parent_company_code) {
      return res.status(403).json({ error: "Only root can rename departments." });
    }
    var targetCode = req.query?.code || req.body?.company_code;
    if (!targetCode) return res.status(400).json({ error: "target company_code required" });

    var { name_en, name_cn } = req.body || {};
    await pool.query(
      `UPDATE customers SET name_en = COALESCE($1, name_en), name_cn = COALESCE($2, name_cn), updated_at = NOW()
       WHERE company_code = $3 AND group_code = $4`,
      [name_en || null, name_cn || null, targetCode, groupCode]
    );
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
