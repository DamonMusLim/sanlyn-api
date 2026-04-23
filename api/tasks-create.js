// api/tasks-create.js — P2-B: 管理后台手工发任务
//
// POST /api/tasks/create   (admin only)
//
// Body:
//   title*              任务标题
//   task_type           交期确认 / 装货安排 / 资料补齐 / 单证处理 / 审批处理 / 异常处理
//   level               order | factory | doc | logi | approve
//   risk_level          low | mid | high | urgent
//   owner_object_type*  order | factory | document | logistics
//   owner_object_id*    （order 类对象时，允许从 related_order_no 推导）
//   owner_object_label  显示用
//   related_order_no    订单号（order 级任务强相关）
//   related_po_no       客户 PO 号
//   company_code*       归属公司（tenant scope）
//   mode                owned | agent（默认 owned；若 related_order_no 匹配到订单，继承订单 mode）
//   due_at              ISO 时间
//   reason              触发原因文本
//   collaborators       [{ username, role }]（入 raw.collaborators）
//   primary_action      { action, label }（drawer 主按钮）
//   secondary_actions   [{ action, label }]（drawer 次按钮）
//
// 行为：
//   1) 校验必填 + CHECK 值域
//   2) order 级任务一致性校验（owner_object_id vs related_order_no 需至少一个有效，两者都传则必须一致）
//   3) 若 related_order_no 能匹配到 orders 行 → 自动继承 orders.mode（订单真值优先）
//   4) 插 tasks
//   5) 建 collab thread（若没有）+ 写系统事件 task_created
//   6) 返回 task_id + 完整 row + thread_id

import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

const VALID_LEVELS      = ["order", "factory", "doc", "logi", "approve"];
const VALID_OWNER_TYPES = ["order", "factory", "document", "logistics"];
const VALID_RISK        = ["low", "mid", "high", "urgent"];
const VALID_MODE        = ["owned", "agent", "agent_compliance"];

function genTaskId() {
  return "t-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}
function genThreadId() {
  return "th-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function genMsgId() {
  return "m-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Admin only
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Forbidden: admin only" });
  }

  const b = req.body || {};

  // ── 必填 ──
  const missing = [];
  if (!b.title)              missing.push("title");
  if (!b.owner_object_type)  missing.push("owner_object_type");
  if (!b.company_code)       missing.push("company_code");
  // owner_object_id 在 order 级任务时允许从 related_order_no 推导，见下面一致性校验
  if (b.owner_object_type !== "order" && !b.owner_object_id) missing.push("owner_object_id");
  if (missing.length) {
    return res.status(400).json({ success: false, error: "Missing: " + missing.join(", ") });
  }

  // ── 值域校验 ──
  if (b.level             && !VALID_LEVELS.includes(b.level))            return res.status(400).json({ success: false, error: "level must be " + VALID_LEVELS.join("|") });
  if (b.owner_object_type && !VALID_OWNER_TYPES.includes(b.owner_object_type)) return res.status(400).json({ success: false, error: "owner_object_type must be " + VALID_OWNER_TYPES.join("|") });
  if (b.risk_level        && !VALID_RISK.includes(b.risk_level))         return res.status(400).json({ success: false, error: "risk_level must be " + VALID_RISK.join("|") });
  if (b.mode              && !VALID_MODE.includes(b.mode))               return res.status(400).json({ success: false, error: "mode must be " + VALID_MODE.join("|") });

  // ── order 级一致性校验 ──
  let ownerObjectId  = b.owner_object_id || null;
  const relatedOrder = b.related_order_no || null;

  if (b.owner_object_type === "order") {
    if (!ownerObjectId && !relatedOrder) {
      return res.status(400).json({
        success: false,
        error: "owner_object_type='order' requires owner_object_id or related_order_no",
      });
    }
    // 若两者都传，必须一致
    if (ownerObjectId && relatedOrder && ownerObjectId !== relatedOrder) {
      return res.status(400).json({
        success: false,
        error: "owner_object_id (" + ownerObjectId + ") and related_order_no (" + relatedOrder + ") must match for order-type tasks",
      });
    }
    // 只传一个就用另一个补齐
    if (!ownerObjectId) ownerObjectId = relatedOrder;
  }

  const pool = getPool();

  // ── mode 推导：订单真值优先 ──
  // mode_source 回传给调用方，方便排查 mode 到底是怎么来的
  //   "order"   — related_order_no 匹配到订单，继承了 orders.mode
  //   "payload" — body 显式带了 mode，且未被订单覆盖
  //   "default" — body 未带 mode，订单也没匹配到，兜底为 'owned'
  let finalMode;
  let modeSource;
  let factoryCompanyCode = b.factory_company_code || null;  // 允许 body 显式覆盖
  if (relatedOrder) {
    try {
      const q = await pool.query(
        "SELECT mode, company_code, raw->>'factoryCompanyCode' AS factory_company_code FROM orders WHERE contract_no = $1 OR order_no = $1 LIMIT 1",
        [relatedOrder]
      );
      if (q.rowCount > 0) {
        finalMode  = q.rows[0].mode || "owned";
        modeSource = "order";
        if (!factoryCompanyCode && q.rows[0].factory_company_code) {
          factoryCompanyCode = q.rows[0].factory_company_code;
        }
      }
    } catch (e) {
      // 订单表查询出错不阻断创建；记 log
      console.error("[tasks-create] order mode lookup failed:", e.message);
    }
  }
  if (!modeSource) {
    if (b.mode) {
      finalMode  = b.mode;
      modeSource = "payload";
    } else {
      finalMode  = "owned";
      modeSource = "default";
    }
  }

  // factory 级任务：owner_object_id 就是工厂 company_code
  if (!factoryCompanyCode && b.owner_object_type === "factory" && ownerObjectId) {
    factoryCompanyCode = ownerObjectId;
  }

  // ── 组装 raw ──
  const rawBlob = {
    primary_action:    b.primary_action    || null,
    secondary_actions: Array.isArray(b.secondary_actions) ? b.secondary_actions : [],
    steps:             Array.isArray(b.steps) ? b.steps : [],
    collaborators:     Array.isArray(b.collaborators) ? b.collaborators : [],
    created_by_admin:  req.user.username || null,
    source:            "manual",
  };

  const taskId = genTaskId();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 插 tasks
    const insTask = await client.query(
      `INSERT INTO tasks (
         id, title, task_type, level, status, risk_level, mode,
         owner_object_type, owner_object_id, owner_object_label,
         related_order_no, related_po_no, company_code, factory_company_code,
         due_at, reason, raw
       ) VALUES (
         $1, $2, $3, $4, 'open', $5, $6,
         $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15, $16
       ) RETURNING *`,
      [
        taskId,
        b.title,
        b.task_type || null,
        b.level || null,
        b.risk_level || null,
        finalMode,
        b.owner_object_type,
        ownerObjectId,
        b.owner_object_label || null,
        relatedOrder,
        b.related_po_no || null,
        b.company_code,
        factoryCompanyCode,
        b.due_at || null,
        b.reason || null,
        JSON.stringify(rawBlob),
      ]
    );
    const task = insTask.rows[0];

    // 建 collab thread（task_id 唯一，一任务一主 thread）
    const threadId = genThreadId();
    const insThread = await client.query(
      `INSERT INTO collaboration_threads (
         id, task_id, owner_object_type, owner_object_id, owner_object_label,
         company_code, factory_company_code, title, status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
       RETURNING *`,
      [
        threadId,
        taskId,
        task.owner_object_type,
        task.owner_object_id,
        task.owner_object_label || task.title,
        task.company_code,
        factoryCompanyCode,
        task.title,
        req.user.username || "admin",
      ]
    );

    // 写系统事件消息
    await client.query(
      `INSERT INTO collaboration_messages (
         id, thread_id, author, author_role, body, kind, event_type, raw
       ) VALUES ($1, $2, $3, $4, $5, 'event', 'task_created', $6)`,
      [
        genMsgId(),
        threadId,
        req.user.username || "admin",
        "admin",
        "任务已创建：" + task.title,
        JSON.stringify({
          task_id: taskId,
          mode: finalMode,
          mode_source: modeSource,
          reason: task.reason,
          due_at: task.due_at,
        }),
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      task_id: taskId,
      thread_id: threadId,
      mode: finalMode,
      mode_source: modeSource, // "order" | "payload" | "default"
      factory_company_code: factoryCompanyCode,
      data: task,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(function() {});
    console.error("[tasks-create]", err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
}
