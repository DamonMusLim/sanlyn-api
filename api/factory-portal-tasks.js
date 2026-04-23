// api/factory-portal-tasks.js — P1-2: GET /api/factory-portal/tasks
//
// 工厂工作台任务列表。要求登录（JWT），按当前用户的 company_code 过滤。
//
// Query params:
//   status=open|doing|done|cancelled|all   (default: open,doing)
//   level=order|factory|doc|logi|approve   (optional)
//   limit=N                                (default 100)
//
// Response shape (前端工作台直接消费)：
//   { success, data: [ {id,title,reason,due_at,risk_level,task_type,level,status,mode,
//                       owner_object_type,owner_object_id,owner_object_label,
//                       related_order_no, related_po_no, collaborators[]} ], count }

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { status, level, limit = 100 } = req.query;

    const conds = [];
    const params = [];

    // Tenant scoping: 非 admin 按 company_code 过滤
    if (req.user && req.user.role !== "admin") {
      const userCodes = req.user.companyCodes ||
        (req.user.companyCode ? [req.user.companyCode] : []);
      if (userCodes.length === 0) {
        return res.status(200).json({ success: true, data: [], count: 0 });
      }
      const ph = userCodes.map(function(c) { params.push(c); return "$" + params.length; });
      // BUG-A fix: factory 账号的 companyCode=FAC-xxx，但任务 company_code=客户 CN-xxx；
      // 须同时比对 factory_company_code 才能命中工厂自己的任务
      conds.push("(company_code IN (" + ph.join(",") + ") OR factory_company_code IN (" + ph.join(",") + "))");
    }

    // status 过滤（默认只看未完成）
    if (status && status !== "all") {
      const statusList = status.split(",").map(function(s) { return s.trim(); });
      const ph = statusList.map(function(s) { params.push(s); return "$" + params.length; });
      conds.push("status IN (" + ph.join(",") + ")");
    } else {
      conds.push("status IN ('open','doing')");
    }

    if (level) {
      params.push(level);
      conds.push("level = $" + params.length);
    }

    let sql =
      "SELECT id, title, task_type, level, status, risk_level, mode, " +
      "       owner_object_type, owner_object_id, owner_object_label, " +
      "       related_order_no, related_po_no, company_code, " +
      "       due_at, reason, " +
      "       raw->'collaborators' AS collaborators, " +
      "       created_at, updated_at " +
      "FROM tasks";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    sql += " ORDER BY " +
           "  CASE WHEN risk_level='urgent' THEN 0 WHEN risk_level='high' THEN 1 ELSE 2 END, " +
           "  COALESCE(due_at, NOW() + INTERVAL '1000 days') ASC " +
           " LIMIT $" + params.length;

    const result = await pool.query(sql, params);
    return res.status(200).json({
      success: true,
      data: result.rows,
      count: result.rowCount,
    });
  } catch (err) {
    console.error("[factory-portal-tasks]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
