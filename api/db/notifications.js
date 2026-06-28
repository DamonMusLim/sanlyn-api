// notifications.js — 系统收件箱 CRUD + 已读/置顶/归档
//
// GET  ?action=list&filter=unread     列表（默认未归档，按 created_at DESC）
// GET  ?action=detail&id=N            单条
// POST                                创建（写库 + 触发派发钩子）
// PATCH ?action=read|pin|unpin|archive&id=N
//
import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth } from "../lib/viewmodel-adapter.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const action = req.query?.action || "list";
  const userId = req.user?.username || "anonymous";

  // POST (create notification) is internal-only — customers/factories cannot inject.
  // GET and PATCH are scoped per-user via userId so all authenticated users may call them.
  if (req.method === "POST") {
    const role = roleFromAuth(req);
    if (!isInternalRole(role)) {
      return res.status(403).json({ error: "Forbidden: internal access only" });
    }
  }

  try {
    // ─── GET list ────────────────────────────────────────
    if (req.method === "GET" && action === "list") {
      const filter = req.query.filter || "all"; // all | unread | pinned | archived
      const type   = req.query.type;             // optional filter by type
      const scope  = req.query.scope;            // optional
      const scopeId= req.query.scope_id;
      const limit  = Math.min(parseInt(req.query.limit) || 50, 200);

      // userId always first param so SELECT computed columns reference it safely via $1
      const params = [userId];
      const userIdx = 1;

      const conds = [];
      if (filter === "unread") {
        conds.push("archived_at IS NULL");
        conds.push("NOT jsonb_exists(read_by, $" + userIdx + ")");
      } else if (filter === "pinned") {
        conds.push("$" + userIdx + " = ANY(COALESCE(pinned_by, ARRAY[]::TEXT[]))");
      } else if (filter === "archived") {
        conds.push("archived_at IS NOT NULL");
      } else {
        conds.push("archived_at IS NULL");
      }
      if (type)    { params.push(type);    conds.push("type = $" + params.length); }
      if (scope)   { params.push(scope);   conds.push("scope = $" + params.length); }
      if (scopeId) { params.push(scopeId); conds.push("scope_id = $" + params.length); }

      const whereSql = conds.length ? "WHERE " + conds.join(" AND ") : "";
      params.push(limit);
      const sql = `
        SELECT id, type, level, title, body, payload, scope, scope_id,
               recipients, recipient_roles, channels, delivery_status,
               read_by, pinned_by, archived_at,
               related_op, related_summary, related_task,
               created_at,
               jsonb_exists(read_by, $${userIdx}) AS is_read,
               ($${userIdx} = ANY(COALESCE(pinned_by, ARRAY[]::TEXT[]))) AS is_pinned
        FROM notifications
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length}
      `;
      const r = await pool.query(sql, params);

      // unread count — jsonb_exists avoids string interpolation
      const c = await pool.query(
        `SELECT COUNT(*) AS unread FROM notifications
         WHERE archived_at IS NULL AND NOT jsonb_exists(read_by, $1)`,
        [userId]
      );

      return res.status(200).json({
        success: true,
        data: r.rows,
        unread: parseInt(c.rows[0].unread),
        total: r.rows.length,
      });
    }

    // ─── GET detail ──────────────────────────────────────
    if (req.method === "GET" && action === "detail") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await pool.query("SELECT * FROM notifications WHERE id = $1", [id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
      // mark read — COALESCE guards against NULL read_by
      await pool.query(
        `UPDATE notifications SET read_by = COALESCE(read_by, '{}'::jsonb) || jsonb_build_object($2, NOW()::TEXT)
         WHERE id = $1`,
        [id, userId]
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    // ─── POST create ─────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.type || !b.title) {
        return res.status(400).json({ error: "type and title required" });
      }
      const r = await pool.query(`
        INSERT INTO notifications
          (type, level, title, body, payload, scope, scope_id,
           recipients, recipient_roles, channels,
           related_op, related_summary, related_task)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *
      `, [
        b.type, b.level || "info", b.title, b.body || null, b.payload || {},
        b.scope || null, b.scope_id || null,
        b.recipients || [], b.recipient_roles || [], b.channels || ["inapp"],
        b.related_op || null, b.related_summary || null, b.related_task || null,
      ]);
      // TODO: 异步派发到企微/邮件，回写 delivery_status
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    // ─── PATCH read/pin/unpin/archive ────────────────────
    if (req.method === "PATCH") {
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: "id required" });

      if (action === "read") {
        await pool.query(
          `UPDATE notifications SET read_by = COALESCE(read_by, '{}'::jsonb) || jsonb_build_object($2, NOW()::TEXT)
           WHERE id = $1`,
          [id, userId]
        );
        return res.status(200).json({ success: true });
      }

      if (action === "pin") {
        await pool.query(
          `UPDATE notifications
           SET pinned_by = ARRAY(SELECT DISTINCT unnest(COALESCE(pinned_by, ARRAY[]::TEXT[]) || $2))
           WHERE id = $1`,
          [id, userId]
        );
        return res.status(200).json({ success: true });
      }

      if (action === "unpin") {
        await pool.query(
          `UPDATE notifications SET pinned_by = array_remove(pinned_by, $2) WHERE id = $1`,
          [id, userId]
        );
        return res.status(200).json({ success: true });
      }

      if (action === "archive") {
        await pool.query(
          `UPDATE notifications SET archived_at = NOW() WHERE id = $1`,
          [id]
        );
        return res.status(200).json({ success: true });
      }
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
