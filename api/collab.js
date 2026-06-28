// api/collab.js — P1-3: 协作记录最小 API
//
// GET  /api/collab?task_id=t-xxxx
// GET  /api/collab?owner_object_type=order&owner_object_id=XXX
//   返回该任务 / 对象下所有 threads + messages（按时间升序）
//
// POST /api/collab
//   body: {
//     task_id?,                          // 可选，指定后自动挂该任务的 thread
//     owner_object_type, owner_object_id, owner_object_label?,  // 必填（task_id 不提供时）
//     title?,                            // 新建 thread 时用
//     body, kind?                        // 消息体；kind 默认 'text'
//   }
//
// 强制：必须挂对象 (owner_object_type + owner_object_id)，不允许裸聊天
// 留痕：写入后自动触发 collaboration_threads.last_message_at 更新（DB trigger）

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

const VALID_OWNER_TYPES = ["order", "factory", "document", "logistics"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  // ── GET: 读取协作记录 ──
  if (req.method === "GET") {
    const { task_id, owner_object_type, owner_object_id } = req.query;
    if (!task_id && !(owner_object_type && owner_object_id)) {
      return res.status(400).json({
        success: false,
        error: "Provide task_id OR (owner_object_type + owner_object_id)",
      });
    }

    try {
      let threadsSql, threadsParams;
      if (task_id) {
        threadsSql = "SELECT * FROM collaboration_threads WHERE task_id = $1 ORDER BY created_at ASC";
        threadsParams = [task_id];
      } else {
        threadsSql =
          "SELECT * FROM collaboration_threads " +
          "WHERE owner_object_type = $1 AND owner_object_id = $2 " +
          "ORDER BY created_at ASC";
        threadsParams = [owner_object_type, owner_object_id];
      }
      const threads = await pool.query(threadsSql, threadsParams);

      // tenant 过滤（非 admin）
      let filteredThreads = threads.rows;
      if (req.user.role !== "admin") {
        const codes = req.user.companyCodes ||
          (req.user.companyCode ? [req.user.companyCode] : []);
        filteredThreads = threads.rows.filter(function(t) {
          // BUG-A fix: factory 账号须同时比对 factory_company_code
          if (!t.company_code && !t.factory_company_code) return true;
          if (t.company_code && codes.includes(t.company_code)) return true;
          if (t.factory_company_code && codes.includes(t.factory_company_code)) return true;
          return false;
        });
      }

      if (filteredThreads.length === 0) {
        return res.status(200).json({ success: true, threads: [], messages: [] });
      }

      const ids = filteredThreads.map(function(t) { return t.id; });
      const ph = ids.map(function(_, i) { return "$" + (i + 1); }).join(",");
      const msgs = await pool.query(
        "SELECT * FROM collaboration_messages WHERE thread_id IN (" + ph + ") ORDER BY created_at ASC",
        ids
      );

      return res.status(200).json({
        success: true,
        threads: filteredThreads,
        messages: msgs.rows,
      });
    } catch (err) {
      console.error("[collab GET]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── POST: 新增消息（必要时新建 thread） ──
  if (req.method === "POST") {
    const b = req.body || {};
    const taskId            = b.task_id || null;
    const ownerType         = b.owner_object_type;
    const ownerId           = b.owner_object_id;
    const ownerLabel        = b.owner_object_label || null;
    const title             = b.title || null;
    const body              = b.body;
    const kind              = b.kind || "text";
    const companyCode       = b.company_code ||
      (req.user && req.user.companyCode) ||
      (req.user && req.user.companyCodes && req.user.companyCodes[0]) ||
      null;

    if (!body) {
      return res.status(400).json({ success: false, error: "body required" });
    }
    if (!["text", "event", "system"].includes(kind)) {
      return res.status(400).json({ success: false, error: "invalid kind" });
    }

    // 定位或创建 thread
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let thread;
      if (taskId) {
        // task_id 指定：找该任务的 thread
        const r = await client.query(
          "SELECT * FROM collaboration_threads WHERE task_id = $1 LIMIT 1",
          [taskId]
        );
        if (r.rowCount > 0) {
          thread = r.rows[0];
        } else {
          // 从任务表取 owner 信息以保证绑定对象
          const tr = await client.query("SELECT * FROM tasks WHERE id = $1 LIMIT 1", [taskId]);
          if (tr.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "task not found" });
          }
          const task = tr.rows[0];
          const tid = "th-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const ins = await client.query(
            `INSERT INTO collaboration_threads
              (id, task_id, owner_object_type, owner_object_id, owner_object_label,
               company_code, factory_company_code, title, status, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
             RETURNING *`,
            [
              tid, taskId,
              task.owner_object_type || "order",
              task.owner_object_id || task.related_order_no || task.id,
              task.owner_object_label || task.title,
              task.company_code || companyCode,
              task.factory_company_code || null,
              title || task.title,
              (req.user && req.user.username) || "system",
            ]
          );
          thread = ins.rows[0];
        }
      } else {
        // 无 task_id：必须提供 owner
        if (!ownerType || !ownerId) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            error: "owner_object_type + owner_object_id required when task_id is absent (no naked chat)",
          });
        }
        if (!VALID_OWNER_TYPES.includes(ownerType)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            error: "owner_object_type must be one of " + VALID_OWNER_TYPES.join(", "),
          });
        }

        // 找该对象下现有 open thread；没有就建
        const r = await client.query(
          `SELECT * FROM collaboration_threads
             WHERE owner_object_type = $1 AND owner_object_id = $2 AND status = 'open'
             ORDER BY created_at DESC LIMIT 1`,
          [ownerType, ownerId]
        );
        if (r.rowCount > 0) {
          thread = r.rows[0];
        } else {
          const tid = "th-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const ins = await client.query(
            `INSERT INTO collaboration_threads
              (id, task_id, owner_object_type, owner_object_id, owner_object_label,
               company_code, title, status, created_by)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, 'open', $7)
             RETURNING *`,
            [
              tid, ownerType, ownerId, ownerLabel,
              companyCode, title,
              (req.user && req.user.username) || "system",
            ]
          );
          thread = ins.rows[0];
        }
      }

      // 插消息
      const mid = "m-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const msg = await client.query(
        `INSERT INTO collaboration_messages
          (id, thread_id, author, author_role, body, kind, event_type, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          mid, thread.id,
          (req.user && req.user.username) || "anonymous",
          (req.user && req.user.role) || null,
          body,
          kind,
          b.event_type || null,
          JSON.stringify(b.raw || {}),
        ]
      );

      await client.query("COMMIT");
      return res.status(200).json({
        success: true,
        thread,
        message: msg.rows[0],
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(function() {});
      console.error("[collab POST]", err);
      return res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
