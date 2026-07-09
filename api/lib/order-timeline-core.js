// api/lib/order-timeline-core.js — 单票时间轴聚合核心
// 聚合 order_events / task_events / notification_project_runs / email_message_log / order_diary_notes
// + 从订单字段派生当前阶段。供内部(全量)和外部(裁剪)两个路由复用。
import { ensureOrderDiaryNotes } from "../db/order-diary-notes.js";

// 事件类型 → 外部(客户/工厂)可见性（Damon拍板：外部只看进度节点，不含通知/邮件发送记录）
const EXTERNAL_VISIBLE_SOURCES = new Set(["milestone", "order_event", "manual_note"]);

// order_events.stage_key → 外部展示文案（内部保留原始 stage_key）
const STAGE_LABELS = {
  production_complete: "生产完成", customs_declared: "已报关", vessel_etd_carrier: "已开航",
  vessel_loaded: "已装船", booking_confirmed: "已订舱", container_loaded: "已装柜",
  bl_released: "提单已出", arrival_confirmed: "已到港", payment_received: "已收款",
};

function deriveMilestones(order) {
  const out = [];
  if (order.delivery_date) out.push({ event_key: "scheduled", title: "预计交货", occurred_at: order.delivery_date });
  if (order.confirmed_delivery) out.push({ event_key: "ready", title: "货已备好", occurred_at: order.confirmed_delivery });
  if (order.confirmed_ship_date) out.push({ event_key: "ship_scheduled", title: "确认发货时间", occurred_at: order.confirmed_ship_date });
  if (order.etd) out.push({ event_key: "shipped", title: "已出运 (ETD)", occurred_at: order.etd });
  if (order.bl_no) out.push({ event_key: "bl_issued", title: "提单已出 (BL " + order.bl_no + ")", occurred_at: order.etd || null });
  if (order.eta) out.push({ event_key: "eta", title: "预计到港 (ETA)", occurred_at: order.eta });
  return out.filter(e => e.occurred_at);
}

function currentStage(order) {
  const now = Date.now();
  if (order.eta) {
    const etaMs = new Date(order.eta).getTime();
    const days = (now - etaMs) / 86400000;
    if (days >= 30) return "delivered";
    if (days >= 0) return "customs";
    return "in_transit";
  }
  if (order.etd || order.bl_no) return "shipped";
  if (order.confirmed_delivery) return "ready";
  if (order.delivery_date) return "scheduled";
  return "pending";
}

export async function buildOrderTimeline(pool, orderId, { viewerRole = "internal" } = {}) {
  await ensureOrderDiaryNotes(pool);

  const ordR = await pool.query(
    `SELECT id, order_no, contract_no, customer, factory, status,
            delivery_date, confirmed_delivery, confirmed_ship_date, etd, eta, bl_no
       FROM orders WHERE id=$1`, [orderId]);
  const order = ordR.rows[0];
  if (!order) return null;

  const events = [];

  // ① 派生里程碑(实时推导,不落表)
  for (const m of deriveMilestones(order)) {
    events.push({
      id: "milestone:" + m.event_key, source: "milestone", event_key: m.event_key,
      group: "progress", title: m.title, detail: null, occurred_at: m.occurred_at,
      actor: "system", visibility_class: "shared", severity: "info",
    });
  }

  // ② order_events（真实里程碑事件表，已有141条真数据在跑）
  const oe = await pool.query(
    `SELECT id, stage_key, event_group, occurred_at, actor_role, actor_user_id, source, status, meta
       FROM order_events WHERE order_id=$1 ORDER BY occurred_at DESC NULLS LAST, id DESC LIMIT 200`, [order.id]);
  oe.rows.forEach(r => events.push({
    id: "order_event:" + r.id, source: "order_event", event_key: r.stage_key,
    group: r.event_group || "progress", title: STAGE_LABELS[r.stage_key] || r.stage_key,
    detail: r.meta || null, occurred_at: r.occurred_at, actor: r.actor_user_id || r.actor_role || r.source,
    visibility_class: "shared", severity: r.status === "failed" ? "warning" : "info",
  }));

  // ③ task_events（内部专用，走 tasks.related_order_no 关联）
  if (viewerRole === "internal") {
    const te = await pool.query(
      `SELECT te.id, te.event_type, te.actor_id, te.from_status, te.to_status, te.note, te.created_at
         FROM task_events te JOIN tasks t ON t.id = te.task_id
        WHERE t.related_order_no = $1 ORDER BY te.created_at DESC LIMIT 100`, [order.order_no]);
    te.rows.forEach(r => events.push({
      id: "task:" + r.id, source: "task", event_key: r.event_type, group: "task",
      title: `任务${r.event_type}${r.to_status ? "→" + r.to_status : ""}`, detail: r.note,
      occurred_at: r.created_at, actor: r.actor_id, visibility_class: "internal", severity: "info",
    }));
  }

  // ④ notification_project_runs + email_message_log（内部专用，Damon拍板外部不显示通知/邮件记录）
  if (viewerRole === "internal") {
    const npr = await pool.query(
      `SELECT id, project_key, status, channels, created_at, finished_at, triggered_by
         FROM notification_project_runs WHERE (context->>'order_id')::text = $1 ORDER BY created_at DESC LIMIT 50`,
      [String(order.id)]);
    npr.rows.forEach(r => events.push({
      id: "notify:" + r.id, source: "notify", event_key: r.project_key, group: "communication",
      title: `通知项目触发: ${r.project_key} (${r.status})`, detail: { channels: r.channels },
      occurred_at: r.finished_at || r.created_at, actor: r.triggered_by, visibility_class: "internal", severity: r.status === "success" ? "success" : "warning",
    }));

    const eml = await pool.query(
      `SELECT id, tpl_key, status, recipient_name, recipient_email, subject, sent_at, created_at
         FROM email_message_log WHERE order_id=$1 ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 50`, [order.id]);
    eml.rows.forEach(r => events.push({
      id: "email:" + r.id, source: "email", event_key: "email_" + r.status, group: "communication",
      title: `邮件${r.status === "sent" ? "已发送" : r.status}: ${r.subject || r.tpl_key}`,
      detail: { to: r.recipient_name, email: r.recipient_email }, occurred_at: r.sent_at || r.created_at,
      actor: "system", visibility_class: "internal", severity: r.status === "failed" ? "error" : r.status === "sent" ? "success" : "info",
    }));
  }

  // ⑤ 人工日记备注（按 viewerRole 裁剪 visibility）
  const notes = await pool.query(
    `SELECT id, note_text, note_type, visibility, author_name, created_at
       FROM order_diary_notes WHERE order_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`, [order.id]);
  notes.rows.forEach(r => {
    const visible = viewerRole === "internal" || r.visibility === "shared" || r.visibility === viewerRole;
    if (!visible) return;
    events.push({
      id: "note:" + r.id, source: "manual_note", event_key: r.note_type, group: "note",
      title: r.note_text, detail: null, occurred_at: r.created_at, actor: r.author_name,
      visibility_class: r.visibility, severity: "info",
    });
  });

  let finalEvents = events;
  if (viewerRole !== "internal") {
    finalEvents = events.filter(e => EXTERNAL_VISIBLE_SOURCES.has(e.source));
  }
  finalEvents.sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0));

  return {
    order: { id: order.id, order_no: order.order_no, contract_no: order.contract_no,
      customer: viewerRole === "internal" || viewerRole === "customer" ? order.customer : undefined,
      factory: viewerRole === "internal" || viewerRole === "factory" ? order.factory : undefined,
      current_stage: currentStage(order) },
    events: finalEvents,
  };
}
