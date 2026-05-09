// ═══════════════════════════════════════════════════════════════
// api/db/sample-delivery-checkin.js  — 厂长样品确认 Magic Link
//
// GET  /api/db/sample-delivery-checkin?token=X
//   → 验证 token → 返回样品任务 + 产品简报（脱敏：无客户全名/价格）
//
// POST /api/db/sample-delivery-checkin
//   body: { token, action: "confirm"|"reject"|"update_schedule", ... }
//   confirm          → 厂长确认产能，填排期，可传 evidence_url
//   reject           → 厂长拒绝（需填 factory_note 说明原因）
//   update_schedule  → 修改排期（已确认后可更新）
//
// 安全：
//   · 无 JWT（magic-link 模式，SHA-256 hash 鉴权）
//   · collab_sheet_table 必须 = 'sample_delivery_sheets'
//   · 不返回客户全名 / 目标价格 / 利润
//   · token 不标记 used_at（厂长可多次查看）
// ═══════════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";
import { hashToken, sendError } from "../lib/viewmodel-adapter.js";

const ALLOWED_TABLE = "sample_delivery_sheets";

// 脱敏：只显示客户代号（不显示全名）
function maskCustomer(customer_code) {
  if (!customer_code) return null;
  const s = String(customer_code).toUpperCase();
  // 取前 2 字符 + "***"，e.g. "PETSOME" → "PE***"
  return s.slice(0, 2) + "***";
}

// 从 sample_brief JSONB 剥除价格字段
const PRICE_KEYS = new Set(["target_price", "unit_price", "total_price", "profit", "margin", "cost"]);
function sanitizeBrief(brief) {
  if (!brief || typeof brief !== "object") return {};
  const clean = { ...brief };
  for (const k of PRICE_KEYS) delete clean[k];
  return clean;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── 提取 + 验证 token ────────────────────────────────────────
  const rawToken = req.method === "GET"
    ? (req.query?.token || "")
    : ((req.body || {}).token || "");

  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 16) {
    return sendError(res, 400, "token_required");
  }

  const tokenHash = hashToken(rawToken);

  const { rows: asmRows } = await pool.query(
    `SELECT da.id AS assignment_id,
            da.collab_sheet_table,
            da.collab_sheet_id,
            da.order_id,
            da.task_type,
            da.status     AS assignment_status,
            da.expires_at,
            da.revoked_at
       FROM driver_assignments da
      WHERE da.magic_token_hash = $1
        AND da.expires_at > NOW()
        AND da.revoked_at IS NULL
      LIMIT 1`,
    [tokenHash]
  );
  if (!asmRows.length) return sendError(res, 401, "invalid_or_expired_link");

  const asm = asmRows[0];

  if (asm.collab_sheet_table !== ALLOWED_TABLE) {
    return sendError(res, 403, "token_not_for_sample_delivery");
  }
  if (!asm.collab_sheet_id) {
    return sendError(res, 400, "no_sheet_attached");
  }

  const sheetId = parseInt(asm.collab_sheet_id);

  // ── GET ──────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const { rows } = await pool.query(
        `SELECT id, order_no, contract_no, customer_code, status,
                sample_brief, factory_note, factory_capacity_ok,
                factory_schedule_date, factory_evidence_url,
                participant_note, visible_note, due_at,
                factory_confirmed_at
           FROM ${ALLOWED_TABLE}
          WHERE id = $1`,
        [sheetId]
      );
      if (!rows.length) return sendError(res, 404, "sheet_not_found");
      const sheet = rows[0];

      // 获取关联任务
      const { rows: taskRows } = await pool.query(
        `SELECT task_id, title, status, workflow_node, due_at
           FROM tasks
          WHERE sample_sheet_id = $1
          ORDER BY created_at ASC`,
        [sheetId]
      );

      return res.status(200).json({
        ok: true,
        task: {
          assignment_id:   asm.assignment_id,
          task_type:       asm.task_type,
          expires_at:      asm.expires_at,
          sheet_id:        sheet.id,
          sheet_status:    sheet.status,
          order_no:        sheet.order_no,
          contract_no:     sheet.contract_no,
          customer_masked: maskCustomer(sheet.customer_code),
          due_at:          sheet.due_at,
          visible_note:    sheet.visible_note || null,
          factory_confirmed_at: sheet.factory_confirmed_at,
        },
        sample_brief:    sanitizeBrief(sheet.sample_brief),
        factory_status: {
          capacity_ok:     sheet.factory_capacity_ok,
          schedule_date:   sheet.factory_schedule_date,
          evidence_url:    sheet.factory_evidence_url,
          note:            sheet.factory_note,
          participant_note: sheet.participant_note,
        },
        workflow_tasks: taskRows,
      });
    } catch (err) {
      console.error("[sample-delivery-checkin GET]", err);
      return sendError(res, 500, "internal_error", err.message);
    }
  }

  // ── POST ─────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};
    const action = body.action;
    const ALLOWED_ACTIONS = new Set(["confirm", "reject", "update_schedule"]);
    if (!action || !ALLOWED_ACTIONS.has(action)) {
      return sendError(res, 400, "invalid_action", "Allowed: confirm | reject | update_schedule");
    }

    try {
      // 加载当前表单
      const { rows: sheetRows } = await pool.query(
        `SELECT id, status, factory_confirmed_at FROM ${ALLOWED_TABLE} WHERE id = $1`,
        [sheetId]
      );
      if (!sheetRows.length) return sendError(res, 404, "sheet_not_found");
      const sheet = sheetRows[0];

      // ── confirm ──
      if (action === "confirm") {
        if (["customer_signed", "cancelled"].includes(sheet.status)) {
          return sendError(res, 409, "cannot_confirm_in_current_status");
        }

        const scheduleDate = body.schedule_date || null;
        const note        = body.factory_note != null ? String(body.factory_note) : null;
        const partNote    = body.participant_note != null ? String(body.participant_note) : null;
        const evidenceUrl = body.evidence_url || null;

        await pool.query(
          `UPDATE ${ALLOWED_TABLE}
              SET status                = 'factory_confirmed',
                  factory_capacity_ok   = TRUE,
                  factory_confirmed_at  = NOW(),
                  factory_schedule_date = $1,
                  factory_note          = COALESCE($2, factory_note),
                  participant_note      = COALESCE($3, participant_note),
                  factory_evidence_url  = COALESCE($4, factory_evidence_url),
                  updated_at            = NOW()
            WHERE id = $5`,
          [scheduleDate, note, partNote, evidenceUrl, sheetId]
        );

        // 推进关联任务状态
        await pool.query(
          `UPDATE tasks
              SET status       = 'DONE',
                  completed_at = NOW(),
                  updated_at   = NOW()
            WHERE sample_sheet_id = $1
              AND workflow_node = 'FACTORY_CONFIRM'
              AND status NOT IN ('DONE','CANCELLED')`,
          [sheetId]
        );

        // 写 task_event
        await _logEvent(pool, sheetId, "factory_confirmed", {
          actor_type: "HUMAN",
          actor_id:   "factory_manager",
          note:       note || "厂长确认产能",
          from_status: sheet.status,
          to_status:  "factory_confirmed",
        });

        return res.status(200).json({
          ok: true, action: "confirm",
          schedule_date: scheduleDate,
          message: "产能已确认，感谢！",
        });
      }

      // ── reject ──
      if (action === "reject") {
        const note = body.factory_note;
        if (!note || String(note).trim().length < 5) {
          return sendError(res, 400, "factory_note_required", "拒绝时请说明原因（至少5字）");
        }

        await pool.query(
          `UPDATE ${ALLOWED_TABLE}
              SET status              = 'awaiting_factory',
                  factory_capacity_ok = FALSE,
                  factory_note        = $1,
                  updated_at          = NOW()
            WHERE id = $2`,
          [String(note), sheetId]
        );

        await _logEvent(pool, sheetId, "factory_rejected", {
          actor_type: "HUMAN",
          actor_id:   "factory_manager",
          note:       String(note),
          from_status: sheet.status,
          to_status:  "awaiting_factory",
        });

        return res.status(200).json({ ok: true, action: "reject" });
      }

      // ── update_schedule ──
      if (action === "update_schedule") {
        const scheduleDate = body.schedule_date;
        const note         = body.factory_note || null;
        if (!scheduleDate) {
          return sendError(res, 400, "schedule_date_required");
        }

        await pool.query(
          `UPDATE ${ALLOWED_TABLE}
              SET factory_schedule_date = $1,
                  factory_note          = COALESCE($2, factory_note),
                  updated_at            = NOW()
            WHERE id = $3`,
          [scheduleDate, note, sheetId]
        );

        await _logEvent(pool, sheetId, "schedule_updated", {
          actor_type: "HUMAN",
          actor_id:   "factory_manager",
          note:       `排期更新为 ${scheduleDate}`,
          from_status: sheet.status,
          to_status:  sheet.status,
        });

        return res.status(200).json({ ok: true, action: "update_schedule", schedule_date: scheduleDate });
      }

    } catch (err) {
      console.error("[sample-delivery-checkin POST]", err);
      return sendError(res, 500, "internal_error", err.message);
    }
  }

  return sendError(res, 405, "method_not_allowed");
}

// ── 写 task_events 辅助 ────────────────────────────────────────
async function _logEvent(pool, sheetId, eventType, { actor_type, actor_id, note, from_status, to_status }) {
  try {
    // 找到关联任务
    const { rows } = await pool.query(
      `SELECT task_id FROM tasks WHERE sample_sheet_id = $1 LIMIT 1`,
      [sheetId]
    );
    if (!rows.length) return;

    await pool.query(
      `INSERT INTO task_events (event_id, task_id, event_type, from_status, to_status, actor_type, actor_id, note)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7)`,
      [rows[0].task_id, eventType, from_status, to_status, actor_type, actor_id, note]
    );
  } catch (_) {
    // 非关键路径，失败不阻断主流程
  }
}
