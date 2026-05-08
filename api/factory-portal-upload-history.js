// api/factory-portal-upload-history.js — B2-1
//
// 工厂上传历史 API（只读）：
//   GET /api/factory-portal/upload-history
//
// 数据来源：从现有 `tasks` 表 raw.uploads[] 聚合派生（非 mock），
//   搭配 `doc_uploads` 表（若存在）合并。
// 任一数据源不可用时 fail-closed 返回空数组，不 500。
//
// 权限边界（B2-1 最小实现）：
//   - 非 admin：强制 factoryId == req.user.companyCode（或在 companyCodes 之内）
//   - admin：可跨 factoryId 查询，audit 字段保留 uploadedBy
//   - 不提供独立 assert-permission 端点
//
// 查询参数：
//   factoryId, supplierId, taskId, deliveryId, status, limit (default 100)

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";
import { isValidUploadStatus } from "./constants/factory-enums.js";

function userCompanyCodes(user) {
  if (!user) return [];
  if (Array.isArray(user.companyCodes) && user.companyCodes.length) return user.companyCodes;
  if (user.companyCode) return [user.companyCode];
  return [];
}

// 归一化一条上传记录 → FactoryUploadHistoryItem
function normalize(row, source) {
  return {
    id: String(row.id),
    factoryId: row.factory_id || row.factoryId || row.factory_company_code || null,
    supplierId: row.supplier_id || row.supplierId || null,
    taskId: row.task_id || row.taskId || null,
    deliveryId: row.delivery_id || row.deliveryId || null,
    fileName: row.file_name || row.fileName || row.name || "(unnamed)",
    fileType: row.file_type || row.fileType || null,
    fileSize: row.file_size != null ? Number(row.file_size) : (row.fileSize != null ? Number(row.fileSize) : null),
    uploadedBy: row.uploaded_by || row.uploadedBy || null,
    uploadedAt: row.uploaded_at || row.uploadedAt || row.created_at || new Date(0).toISOString(),
    status: isValidUploadStatus(row.status) ? row.status : "uploaded",
    note: row.note || null,
    audit: {
      lastActionBy: row.last_action_by || row.uploaded_by || null,
      lastActionRole: row.last_action_role || null,
      lastActionAt: row.last_action_at || row.updated_at || row.uploaded_at || null,
    },
    _source: source, // 便于调试，前端可忽略
  };
}

async function fetchFromTasksUploads(pool, filters) {
  // 从 tasks.raw.uploads[] 展开。允许 raw.uploads 为 null / 缺失。
  const conds = [];
  const params = [];

  // companyCodes 租户隔离（与 factory-portal-tasks.js 同口径）
  if (filters.tenantScope && filters.tenantScope.length) {
    const ph = filters.tenantScope.map(function (c) { params.push(c); return "$" + params.length; });
    conds.push("(company_code IN (" + ph.join(",") + ") OR factory_company_code IN (" + ph.join(",") + "))");
  }
  if (filters.taskId) {
    params.push(filters.taskId);
    conds.push("id = $" + params.length);
  }

  let sql = "SELECT id, company_code, factory_company_code, raw FROM tasks";
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY updated_at DESC NULLS LAST LIMIT 500";

  let rows = [];
  try {
    const r = await pool.query(sql, params);
    rows = r.rows || [];
  } catch (e) {
    return [];
  }

  const flat = [];
  rows.forEach(function (t) {
    const uploads = t.raw && Array.isArray(t.raw.uploads) ? t.raw.uploads : [];
    uploads.forEach(function (u, i) {
      flat.push(normalize({
        id: (u.id || (t.id + ":" + i)),
        factory_id: t.factory_company_code || null,
        supplier_id: u.supplier_id || null,
        task_id: t.id,
        delivery_id: u.delivery_id || null,
        file_name: u.file_name || u.name || null,
        file_type: u.file_type || u.type || null,
        file_size: u.size || u.file_size || null,
        uploaded_by: u.uploaded_by || u.uploader || null,
        uploaded_at: u.uploaded_at || u.created_at || null,
        status: u.status || "uploaded",
        note: u.note || null,
        last_action_by: u.last_action_by || u.uploaded_by || null,
        last_action_role: u.last_action_role || null,
        last_action_at: u.last_action_at || u.updated_at || u.uploaded_at || null,
      }, "tasks.raw.uploads"));
    });
  });
  return flat;
}

async function fetchFromDocUploads(pool, filters) {
  // 可选：若 doc_uploads 表存在，合并进来。不存在则静默返回空。
  try {
    const conds = [];
    const params = [];
    if (filters.tenantScope && filters.tenantScope.length) {
      const ph = filters.tenantScope.map(function (c) { params.push(c); return "$" + params.length; });
      conds.push("factory_code IN (" + ph.join(",") + ")");
    }
    if (filters.taskId) {
      params.push(filters.taskId);
      conds.push("task_id = $" + params.length);
    }
    let sql = "SELECT id, factory_code AS factory_id, task_id, file_name, file_type, file_size, uploaded_by, created_at AS uploaded_at, status, note FROM doc_uploads";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY created_at DESC LIMIT 500";
    const r = await pool.query(sql, params);
    return (r.rows || []).map(function (row) { return normalize(row, "doc_uploads"); });
  } catch (e) {
    return []; // 表不存在或字段不匹配 → fail-closed
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  const q = req.query || {};
  const factoryIdFilter = q.factoryId ? String(q.factoryId) : null;
  const supplierIdFilter = q.supplierId ? String(q.supplierId) : null;
  const taskIdFilter = q.taskId ? String(q.taskId) : null;
  const deliveryIdFilter = q.deliveryId ? String(q.deliveryId) : null;
  const statusFilter = q.status ? String(q.status).split(",").map(function (s) { return s.trim(); }) : null;
  const limit = Math.min(parseInt(q.limit || "100", 10) || 100, 500);

  // 租户隔离
  let tenantScope = null;
  if (req.user.role !== "admin") {
    tenantScope = userCompanyCodes(req.user);
    if (tenantScope.length === 0) {
      return res.status(200).json({ success: true, data: [], count: 0 });
    }
    if (factoryIdFilter && tenantScope.indexOf(factoryIdFilter) === -1) {
      return res.status(403).json({ success: false, error: "Forbidden: factoryId not in your scope" });
    }
  }

  let items = [];
  try {
    const pool = getPool();
    const fromTasks = await fetchFromTasksUploads(pool, { tenantScope: tenantScope, taskId: taskIdFilter });
    const fromDocs = await fetchFromDocUploads(pool, { tenantScope: tenantScope, taskId: taskIdFilter });
    items = fromTasks.concat(fromDocs);
  } catch (e) {
    // 数据库完全不可用 → 返回空数据，不 500
    items = [];
  }

  // 查询过滤
  const filtered = items.filter(function (x) {
    if (factoryIdFilter && x.factoryId !== factoryIdFilter) return false;
    if (supplierIdFilter && x.supplierId !== supplierIdFilter) return false;
    if (taskIdFilter && x.taskId !== taskIdFilter) return false;
    if (deliveryIdFilter && x.deliveryId !== deliveryIdFilter) return false;
    if (statusFilter && statusFilter.indexOf(x.status) === -1) return false;
    return true;
  });

  filtered.sort(function (a, b) {
    return String(b.uploadedAt).localeCompare(String(a.uploadedAt));
  });

  return res.status(200).json({
    success: true,
    data: filtered.slice(0, limit),
    count: Math.min(filtered.length, limit),
  });
}
