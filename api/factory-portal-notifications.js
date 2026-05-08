// api/factory-portal-notifications.js — B2-2A
//
// 工厂通知 API：
//   GET    /api/factory-portal/notifications
//   PATCH  /api/factory-portal/notifications/:id
//
// B2-2A 升级：
//   - 优先走 PG（factory_notifications 表，见 migrate-factory-notifications.js）
//   - PG 表不存在或连接失败时自动回退到 JSON 文件源（保持 B2-1 兼容）
//   - 回退路径显式声明、可观测（response 带 `_dataSource` 字段，便于运维排查）
//
// 权限边界（与 B2-1 一致）：
//   - 非 admin：强制 factoryId 在 companyCodes 之内
//   - admin：可跨 factoryId，但写路径强制落 audit；audit.crossFactory=true 标注
//   - 不提供独立 assert-permission 端点
//
// 禁止（与 B2-1 一致）：
//   - PATCH 不允许 status=unread（400）
//   - 跨 factoryId 写 → 403
//   - audit 身份只从 req.user.sub / req.user.account / req.user.role 读取，
//     body.actorId / body.actorRole 完全忽略

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { requireAuth } from "./auth.js";
import { getPool, setCors } from "./db.js";
import {
  isValidNotificationPatchStatus,
  isValidActorRole,
  FACTORY_NOTIFICATION_STATUSES,
} from "./constants/factory-enums.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "..", "data", "factory-notifications.json");

// ── Shared helpers ────────────────────────────────────────────────────────
function userCompanyCodes(user) {
  if (!user) return [];
  if (Array.isArray(user.companyCodes) && user.companyCodes.length) return user.companyCodes;
  if (user.companyCode) return [user.companyCode];
  return [];
}

function canReadFactory(user, factoryId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const codes = userCompanyCodes(user);
  return codes.indexOf(factoryId) !== -1;
}

function extractIdFromPath(req) {
  if (req.params && req.params.id) return String(req.params.id);
  const u = String(req.url || "").split("?")[0];
  const m = u.match(/\/notifications\/([^/]+)$/);
  return m ? m[1] : null;
}

// ── JSON store (fallback) ─────────────────────────────────────────────────
function jsonRead() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    return [];
  }
}

function jsonWrite(items) {
  const payload = {
    _comment:
      "B2-1/B2-2A 回退数据源。生产环境 PG 表 factory_notifications 才是 source of truth。",
    items: items,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

const jsonStore = {
  name: "json",
  async list() {
    return jsonRead();
  },
  async findById(id) {
    return jsonRead().find(function (n) { return n.id === id; }) || null;
  },
  async update(id, patch) {
    const items = jsonRead();
    const idx = items.findIndex(function (n) { return n.id === id; });
    if (idx === -1) return null;
    const next = Object.assign({}, items[idx], patch);
    items[idx] = next;
    jsonWrite(items);
    return next;
  },
};

// ── PG store ──────────────────────────────────────────────────────────────
function pgRowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    factoryId: row.factory_id,
    supplierId: row.supplier_id,
    taskId: row.task_id,
    deliveryId: row.delivery_id,
    title: row.title,
    body: row.body,
    status: row.status,
    severity: row.severity,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    audit: row.audit || {},
  };
}

const pgStore = {
  name: "pg",
  async list() {
    const pool = getPool();
    const r = await pool.query(
      "SELECT id, factory_id, supplier_id, task_id, delivery_id, title, body, status, severity, " +
      "created_at, updated_at, audit FROM factory_notifications ORDER BY created_at DESC LIMIT 500"
    );
    return (r.rows || []).map(pgRowToItem);
  },
  async findById(id) {
    const pool = getPool();
    const r = await pool.query(
      "SELECT id, factory_id, supplier_id, task_id, delivery_id, title, body, status, severity, " +
      "created_at, updated_at, audit FROM factory_notifications WHERE id = $1 LIMIT 1",
      [id]
    );
    return pgRowToItem(r.rows && r.rows[0]);
  },
  async update(id, patch) {
    const pool = getPool();
    const r = await pool.query(
      "UPDATE factory_notifications SET status=$2, updated_at=$3, audit=$4 WHERE id=$1 " +
      "RETURNING id, factory_id, supplier_id, task_id, delivery_id, title, body, status, severity, " +
      "created_at, updated_at, audit",
      [id, patch.status, patch.updatedAt, JSON.stringify(patch.audit || {})]
    );
    return pgRowToItem(r.rows && r.rows[0]);
  },
};

// ── Store selector (probe once, cache) ────────────────────────────────────
let _storeCache = null;
let _probePromise = null;
async function chooseStore() {
  if (_storeCache) return _storeCache;
  if (_probePromise) return _probePromise;
  _probePromise = (async function () {
    try {
      const pool = getPool();
      // 探测：表存在且 SELECT 1 不报错
      await pool.query("SELECT 1 FROM factory_notifications LIMIT 1");
      _storeCache = pgStore;
    } catch (e) {
      // PG 不可用或表未建 → 回退 JSON
      _storeCache = jsonStore;
    }
    return _storeCache;
  })();
  return _probePromise;
}

// ── GET /api/factory-portal/notifications ─────────────────────────────────
async function handleGet(req, res) {
  const store = await chooseStore();
  const q = req.query || {};

  const factoryIdFilter = q.factoryId ? String(q.factoryId) : null;
  const supplierIdFilter = q.supplierId ? String(q.supplierId) : null;
  const statusFilter = q.status
    ? String(q.status).split(",").map(function (s) { return s.trim(); })
    : null;

  // 非 admin：安全 fallback — 未知身份或无 companyCodes 即空数据，不返回全库
  if (req.user.role !== "admin") {
    const codes = userCompanyCodes(req.user);
    if (codes.length === 0) {
      return res.status(200).json({ success: true, data: [], count: 0, unreadCount: 0, _dataSource: store.name });
    }
    if (factoryIdFilter && codes.indexOf(factoryIdFilter) === -1) {
      return res.status(403).json({ success: false, error: "Forbidden: factoryId not in your scope" });
    }
  }

  let items = [];
  try {
    items = await store.list();
  } catch (e) {
    items = [];
  }

  const filtered = items.filter(function (n) {
    if (req.user.role !== "admin") {
      const codes = userCompanyCodes(req.user);
      if (codes.indexOf(n.factoryId) === -1) return false;
    }
    if (factoryIdFilter && n.factoryId !== factoryIdFilter) return false;
    if (supplierIdFilter && n.supplierId !== supplierIdFilter) return false;
    if (statusFilter && statusFilter.indexOf(n.status) === -1) return false;
    return true;
  });

  filtered.sort(function (a, b) {
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  const unreadCount = filtered.filter(function (n) { return n.status === "unread"; }).length;

  return res.status(200).json({
    success: true,
    data: filtered,
    count: filtered.length,
    unreadCount: unreadCount,
    _dataSource: store.name,
  });
}

// ── PATCH /api/factory-portal/notifications/:id ───────────────────────────
async function handlePatch(req, res) {
  const store = await chooseStore();
  const id = extractIdFromPath(req);
  if (!id) return res.status(400).json({ success: false, error: "Missing :id in path" });

  const body = req.body || {};
  const nextStatus = body.status;
  if (!isValidNotificationPatchStatus(nextStatus)) {
    return res.status(400).json({
      success: false,
      error: "Invalid status. Allowed: read | handled | archived. (unread is not allowed on PATCH)",
    });
  }

  // audit 身份只从 req.user 读取；body.actorId / body.actorRole 完全忽略（B2-1 P0 Codex 修复）
  const actorId = req.user.sub || req.user.account || null;
  const actorRole = req.user.role || null;
  if (actorRole && !isValidActorRole(actorRole) && actorRole !== "system") {
    return res.status(400).json({
      success: false,
      error: "Invalid actorRole on token. Allowed: factory | admin | ops | system",
    });
  }

  let current = null;
  try {
    current = await store.findById(id);
  } catch (e) {
    return res.status(500).json({ success: false, error: "Store read failed: " + e.message });
  }
  if (!current) return res.status(404).json({ success: false, error: "Notification not found" });

  if (req.user.role !== "admin") {
    if (!canReadFactory(req.user, current.factoryId)) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: cannot modify notifications outside your factory scope",
      });
    }
  }

  if (nextStatus === "unread") {
    return res.status(400).json({ success: false, error: "Cannot revert status to unread" });
  }

  const nowIso = new Date().toISOString();
  const crossFactory =
    req.user.role === "admin" &&
    userCompanyCodes(req.user).indexOf(current.factoryId) === -1
      ? true
      : undefined;

  const auditPayload = {
    lastActionBy: actorId,
    lastActionRole: actorRole,
    lastActionAt: nowIso,
  };
  if (crossFactory) auditPayload.crossFactory = true;

  let updated = null;
  try {
    updated = await store.update(id, {
      status: nextStatus,
      updatedAt: nowIso,
      audit: auditPayload,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: "Store write failed: " + e.message });
  }

  if (!updated) return res.status(404).json({ success: false, error: "Notification not found after update" });
  return res.status(200).json({ success: true, data: updated, _dataSource: store.name });
}

// ── default export (Express + Vercel adapter) ─────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "PATCH") return handlePatch(req, res);
  return res.status(405).json({ success: false, error: "Method not allowed" });
}

// 导出给测试 / 其他 handler 复用
export const __internals = {
  jsonStore,
  pgStore,
  chooseStore,
  userCompanyCodes,
  canReadFactory,
  FACTORY_NOTIFICATION_STATUSES,
};
