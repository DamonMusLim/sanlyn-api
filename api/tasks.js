// api/tasks.js — P1-2 + P1-4
//
// GET  /api/tasks?id=t-xxxx           → 任务详情（抽屉用）
// POST /api/tasks?id=t-xxxx           body: { action, payload }  → 执行 drawer 主动作
//
// 本轮支持的 action（P1-4 第一批）：
//   'confirm_ready_date'   payload: { ready_date }          → 确认预计交期
//   'confirm_actual_date'  payload: { actual_date }         → 确认实际交期
//   'fill_driver_info'     payload: { driver_name, driver_phone, plate_no, arrive_at }  → 司机/到厂信息
//   'fill_container_info'  payload: { container_no, seal_no, size }  → 装货信息（箱/封）
//   'upload_document'      payload: { kind, url, filename }  → 登记已上传资料的引用
//
// 状态回写：
//   - 更新对应 orders / shipping_plans 字段
//   - 给任务写 'event' 消息到协作记录
//   - 必要时 status = 'done' + closed_at = NOW()
//
// 本轮 drawer 其他动作（催单、分配、打回退等）未接，仍在前端保留占位。

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

// ── 辅助：新增一条事件消息到任务绑定的 thread（按需创建 thread） ──
async function appendEventMessage(pool, task, user, eventType, payload) {
  // 找或建 thread
  let thread;
  const t = await pool.query(
    "SELECT id FROM collaboration_threads WHERE task_id = $1 LIMIT 1",
    [task.id]
  );
  if (t.rowCount > 0) {
    thread = t.rows[0];
  } else {
    const tid = "th-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await pool.query(
      `INSERT INTO collaboration_threads
        (id, task_id, owner_object_type, owner_object_id, owner_object_label,
         company_code, factory_company_code, title, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)`,
      [
        tid, task.id,
        task.owner_object_type || "order",
        task.owner_object_id || task.related_order_no || task.id,
        task.owner_object_label || task.title,
        task.company_code || null,
        task.factory_company_code || null,
        task.title,
        user.username || user.name || "system",
      ]
    );
    thread = { id: tid };
  }

  const mid = "m-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await pool.query(
    `INSERT INTO collaboration_messages
      (id, thread_id, author, author_role, body, kind, event_type, raw)
     VALUES ($1, $2, $3, $4, $5, 'event', $6, $7)`,
    [
      mid, thread.id,
      user.username || user.name || "system",
      user.role || null,
      `[${eventType}] ${JSON.stringify(payload)}`,
      eventType,
      JSON.stringify({ payload, task_id: task.id }),
    ]
  );
}

function actorType(user) {
  return user.role || "user";
}

function actorId(user) {
  return user.uid || user.id || user.sub || user.username || user.name || "unknown";
}

function taskClosureNote(task, action, payload) {
  const parts = [`action=${action}`];
  const payloadText = payload && Object.keys(payload).length ? JSON.stringify(payload) : "";
  if (payloadText) parts.push(`payload=${payloadText}`);
  if (task.title) parts.push(`task=${task.title}`);
  return parts.join("; ");
}

async function appendTaskDoneEvent(client, task, user, action, payload) {
  await client.query(
    `INSERT INTO task_events (
       task_id, event_type, actor_type, actor_id,
       from_status, to_status, note, metadata, created_at
     ) VALUES ($1, 'done', $2, $3, $4, 'done', $5, $6::jsonb, NOW())`,
    [
      task.id,
      actorType(user),
      actorId(user),
      task.status || null,
      taskClosureNote(task, action, payload),
      JSON.stringify({ action, payload: payload || {} }),
    ]
  );
}

// ── action 分发器 ──
async function applyAction(pool, task, actionName, payload, user) {
  const r = { orderTouched: false, shippingPlanTouched: false, taskClosed: false };

  if (actionName === "confirm_ready_date") {
    if (!payload || !payload.ready_date) throw new Error("ready_date required");
    if (!task.related_order_no) throw new Error("task has no related_order_no");
    await pool.query(
      `UPDATE orders
         SET raw = jsonb_set(COALESCE(raw,'{}'::jsonb), '{readyDate}', to_jsonb($1::text)),
             updated_at = NOW()
       WHERE contract_no = $2 OR order_no = $2`,
      [payload.ready_date, task.related_order_no]
    );
    r.orderTouched = true;
    r.taskClosed = true;
  }
  else if (actionName === "confirm_actual_date") {
    if (!payload || !payload.actual_date) throw new Error("actual_date required");
    if (!task.related_order_no) throw new Error("task has no related_order_no");
    await pool.query(
      `UPDATE orders
         SET raw = jsonb_set(COALESCE(raw,'{}'::jsonb), '{actDelivery}', to_jsonb($1::text)),
             updated_at = NOW()
       WHERE contract_no = $2 OR order_no = $2`,
      [payload.actual_date, task.related_order_no]
    );
    r.orderTouched = true;
    r.taskClosed = true;
  }
  else if (actionName === "fill_driver_info") {
    if (!task.related_order_no) throw new Error("task has no related_order_no");
    const patch = {
      driverName:  payload.driver_name || null,
      driverPhone: payload.driver_phone || null,
      plateNo:     payload.plate_no || null,
      arriveAt:    payload.arrive_at || null,
    };
    await pool.query(
      `UPDATE orders
         SET raw = COALESCE(raw,'{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE contract_no = $2 OR order_no = $2`,
      [JSON.stringify(patch), task.related_order_no]
    );
    r.orderTouched = true;
    r.taskClosed = true;
  }
  else if (actionName === "fill_container_info") {
    if (!task.related_order_no) throw new Error("task has no related_order_no");
    const patch = {};
    if (payload.container_no) patch.containerNo = payload.container_no;
    if (payload.seal_no)      patch.sealNo      = payload.seal_no;
    if (payload.size)         patch.containerSize = payload.size;
    await pool.query(
      `UPDATE orders
         SET raw = COALESCE(raw,'{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE contract_no = $2 OR order_no = $2`,
      [JSON.stringify(patch), task.related_order_no]
    );
    r.orderTouched = true;
    r.taskClosed = true;
  }
  else if (actionName === "upload_document") {
    // 本轮仅登记引用。实际文件上传复用现有 /api/db/doc-uploads。
    if (!payload || !payload.kind || !payload.url) throw new Error("kind and url required");
    const docRef = {
      kind:     payload.kind,
      url:      payload.url,
      filename: payload.filename || null,
      uploadedBy: user.username || user.name || "factory",
      uploadedAt: new Date().toISOString(),
    };
    // 以 append 方式写进 task.raw.uploads[]
    await pool.query(
      `UPDATE tasks
         SET raw = jsonb_set(
               COALESCE(raw,'{}'::jsonb),
               '{uploads}',
               COALESCE(raw->'uploads', '[]'::jsonb) || $1::jsonb
             )
       WHERE id = $2`,
      [JSON.stringify([docRef]), task.id]
    );
    r.taskClosed = false;  // 单纯传件不自动关闭，由用户或规则决定
  }
  else if (actionName === "claim") {
    const me = user.username || user.name || user.id || "unknown";
    if ((task.domain || "general") === "general")
      throw new Error("此任务非业务领取池（domain=general），不可领取");
    if (task.assigned_to && task.assigned_to !== me)
      throw new Error("已被 " + task.assigned_to + " 领取");
    await pool.query(
      "UPDATE tasks SET assigned_to=$1, status=CASE WHEN status='open' THEN 'doing' ELSE status END, updated_at=NOW() WHERE id=$2",
      [me, task.id]
    );
    r.claimedBy = me;
  }
  else if (actionName === "unclaim") {
    const me = user.username || user.name || user.id || "unknown";
    if (task.assigned_to && task.assigned_to !== me && user.role !== "admin")
      throw new Error("非本人任务，无法退回");
    await pool.query(
      "UPDATE tasks SET assigned_to=NULL, status=CASE WHEN status='doing' THEN 'open' ELSE status END, updated_at=NOW() WHERE id=$1",
      [task.id]
    );
    r.unclaimed = true;
  }
  else if (actionName === "complete") {
    r.taskClosed = true;
  }
  else {
    throw new Error("Unsupported action: " + actionName);
  }

  return r;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const id = req.query.id;

  // ── GET 详情 ──
  if (req.method === "GET") {
    if (!id) return res.status(400).json({ success: false, error: "id required" });
    try {
      const r = await pool.query("SELECT * FROM tasks WHERE id = $1 LIMIT 1", [id]);
      if (r.rowCount === 0) return res.status(404).json({ success: false, error: "task not found" });
      const task = r.rows[0];

      // tenant 过滤
      if (req.user.role !== "admin") {
        const codes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
        const hasScopeField = !!(task.company_code || task.factory_company_code);
        const inScope =
          (task.company_code && codes.includes(task.company_code)) ||
          (task.factory_company_code && codes.includes(task.factory_company_code));
        if (hasScopeField && !inScope) {
          return res.status(403).json({ success: false, error: "Forbidden" });
        }
      }

      // 带上协作消息（最多 100 条）
      const msgs = await pool.query(
        `SELECT m.id, m.author, m.author_role, m.body, m.kind, m.event_type, m.created_at, m.raw
           FROM collaboration_messages m
           JOIN collaboration_threads th ON m.thread_id = th.id
          WHERE th.task_id = $1
          ORDER BY m.created_at ASC
          LIMIT 100`,
        [id]
      );

      return res.status(200).json({
        success: true,
        data: {
          ...task,
          primary_action:    task.raw && task.raw.primary_action || null,
          secondary_actions: task.raw && task.raw.secondary_actions || [],
          steps:             task.raw && task.raw.steps || [],
          collaborators:     task.raw && task.raw.collaborators || [],
          collab_messages:   msgs.rows,
        },
      });
    } catch (err) {
      console.error("[tasks GET]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── POST 执行 action ──
  if (req.method === "POST") {
    if (!id) return res.status(400).json({ success: false, error: "id required" });
    const { action, payload = {} } = req.body || {};
    if (!action) return res.status(400).json({ success: false, error: "action required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const r = await client.query("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [id]);
      if (r.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "task not found" });
      }
      const task = r.rows[0];

      // tenant 过滤
      if (req.user.role !== "admin") {
        const codes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
        const hasScopeField = !!(task.company_code || task.factory_company_code);
        const inScope =
          (task.company_code && codes.includes(task.company_code)) ||
          (task.factory_company_code && codes.includes(task.factory_company_code));
        if (hasScopeField && !inScope) {
          await client.query("ROLLBACK");
          return res.status(403).json({ success: false, error: "Forbidden" });
        }
      }

      // 仅 open/doing 可执行 action
      if (!["open", "doing"].includes(task.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: "task is " + task.status + ", no action allowed" });
      }

      const outcome = await applyAction(client, task, action, payload, req.user || {});

      // 写事件消息
      await appendEventMessage(client, task, req.user || {}, action, payload);

      // 关任务
      if (outcome.taskClosed) {
        await appendTaskDoneEvent(client, task, req.user || {}, action, payload);
        await client.query(
          "UPDATE tasks SET status='done', closed_at=NOW() WHERE id=$1",
          [task.id]
        );
      }

      await client.query("COMMIT");
      return res.status(200).json({
        success: true,
        task_id: task.id,
        action,
        outcome,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(function() {});
      console.error("[tasks POST action]", err);
      return res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
