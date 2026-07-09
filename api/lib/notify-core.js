// api/lib/notify-core.js — 通知项目编排核心：解析收件人 → 渲染模版 → (真发送/仅预览) → 写记录
// 被 api/notify-trigger.js 和 api/notify-preview.js 共用，避免逻辑分叉。
import { resolveActiveAssignee } from "./task-role-routing.js";
import { logEmailMessage } from "../db/email-message-log.js";
import { sendViaDM } from "../send-email.js";

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
function extractVars(...strs) {
  const set = new Set(); let m;
  strs.forEach(s => { VAR_RE.lastIndex = 0; while ((m = VAR_RE.exec(s || "")) !== null) set.add(m[1]); });
  return [...set];
}

// P0 范围内的字段解析：orders.* 靠 context.order_id，shipping_plans.* 靠 context.shipping_plan_id。
// 其它模块(order_line_items/products/companies等)留作P1扩展，缺失时如实标记 missing。
async function resolveFieldValues(pool, keys, context) {
  const values = {}; const missing = [];
  const ordersKeys = keys.filter(k => k.startsWith("orders."));
  const shippingKeys = keys.filter(k => k.startsWith("shipping_plans."));
  const otherKeys = keys.filter(k => !k.startsWith("orders.") && !k.startsWith("shipping_plans."));

  if (ordersKeys.length) {
    if (context.order_id) {
      const cols = ordersKeys.map(k => `"${k.slice(7)}"`).join(",");
      try {
        const r = await pool.query(`SELECT ${cols} FROM orders WHERE id=$1`, [context.order_id]);
        if (r.rows[0]) ordersKeys.forEach(k => { values[k] = r.rows[0][k.slice(7)]; });
        else ordersKeys.forEach(k => missing.push(k));
      } catch (e) { ordersKeys.forEach(k => missing.push(k)); }
    } else ordersKeys.forEach(k => missing.push(k));
  }
  if (shippingKeys.length) {
    if (context.shipping_plan_id || context.order_id) {
      const cols = shippingKeys.map(k => `"${k.slice(15)}"`).join(",");
      try {
        const r = context.shipping_plan_id
          ? await pool.query(`SELECT ${cols} FROM shipping_plans WHERE _id=$1`, [context.shipping_plan_id])
          : await pool.query(
              `SELECT ${cols} FROM shipping_plans sp JOIN orders o ON o.contract_no = ANY(string_to_array(sp.contract_nos, ',')) WHERE o.id=$1 LIMIT 1`,
              [context.order_id]);
        if (r.rows[0]) shippingKeys.forEach(k => { values[k] = r.rows[0][k.slice(15)]; });
        else shippingKeys.forEach(k => missing.push(k));
      } catch (e) { shippingKeys.forEach(k => missing.push(k)); }
    } else shippingKeys.forEach(k => missing.push(k));
  }
  // 非 orders/shipping_plans 前缀字段（自定义变量如amountPaid等）：直接从context同名取
  otherKeys.forEach(k => {
    if (context[k] !== undefined) values[k] = context[k];
    else missing.push(k);
  });
  return { values, missing };
}

function render(str, values) {
  return String(str || "").replace(VAR_RE, (_, k) => values[k] != null ? values[k] : `{{${k}}}`);
}

// 解析 recipient_config → [{type, name, email, role, entity_type, ref_id}]
async function resolveRecipients(pool, recipientConfig, context) {
  const cfg = recipientConfig || {};
  const out = [];

  async function resolveRole(role) {
    const resolved = await resolveActiveAssignee(pool, role);
    // 内部角色目前多数没有邮箱身份(account_identities只种了服务号openid)，
    // 用 fallback_email(recipient_config里配的兜底邮箱)兜底，找不到就标缺失。
    const fallbackEmail = cfg.fallback_email || cfg.fallback?.email;
    return {
      type: "role", role,
      name: resolved.assigned_to || role,
      email: fallbackEmail || null,
      resolved_via: fallbackEmail ? "fallback_email" : "unresolved_no_email_identity",
    };
  }

  async function resolveEntity(item) {
    const table = item.entity_type === "customer" || item.entity_type === "company" ? "customers" : null;
    if (!table) return { type: "entity", name: "(未知实体类型)", email: null, resolved_via: "unsupported_entity_type" };
    const idField = item.id_field || "customer_id";
    const id = context[idField];
    if (!id) return { type: "entity", name: "(缺少" + idField + ")", email: null, resolved_via: "missing_context_id" };
    const r = await pool.query(`SELECT company_code, name_cn, name_en, contact_email FROM customers WHERE company_code=$1 OR id::text=$1 LIMIT 1`, [String(id)]);
    const row = r.rows[0];
    if (!row) return { type: "entity", name: "(未找到:" + id + ")", email: null, resolved_via: "entity_not_found" };
    return { type: "entity", name: row.name_cn || row.name_en, email: row.contact_email || null,
      resolved_via: row.contact_email ? "entity_contact_email" : "entity_missing_email" };
  }

  if (cfg.mode === "role") for (const role of (cfg.roles || [])) out.push(await resolveRole(role));
  else if (cfg.mode === "entity") out.push(await resolveEntity(cfg));
  else if (cfg.mode === "fixed") for (const rec of (cfg.recipients || [])) out.push({ type: "fixed", name: rec.name, email: rec.email, resolved_via: "fixed" });
  else if (cfg.mode === "mixed") {
    for (const item of (cfg.items || [])) {
      if (item.type === "role") for (const role of (item.roles || [])) out.push(await resolveRole(role));
      else if (item.type === "entity") out.push(await resolveEntity(item));
      else if (item.type === "fixed") out.push({ type: "fixed", name: item.name, email: item.email, resolved_via: "fixed" });
    }
  }
  return out;
}

// 核心：给定 project 行 + context，解析收件人+渲染模版，dryRun=true 只返回预览不发送不落库(除非force_log)
export async function runNotification(pool, project, { context = {}, sourceModule, sourceAction, triggeredBy = "system", dryRun = false } = {}) {
  const recipients = await resolveRecipients(pool, project.recipient_config, context);

  let templateRow = null, subject = "", html = "", missingVars = [];
  if (project.template_id) {
    const tr = await pool.query(`SELECT * FROM email_templates WHERE id=$1`, [project.template_id]);
    templateRow = tr.rows[0] || null;
  }
  if (templateRow) {
    const vars = extractVars(templateRow.subject, templateRow.html);
    const { values, missing } = await resolveFieldValues(pool, vars, context);
    subject = render(templateRow.subject, values);
    html = render(templateRow.html, values);
    missingVars = missing;
  }

  const senderKey = project.sender_key || templateRow?.sender || null;
  let senderRow = null;
  if (senderKey) {
    const sr = await pool.query(`SELECT * FROM email_senders WHERE sender_key=$1`, [senderKey]);
    senderRow = sr.rows[0] || null;
  }

  const preview = {
    project_key: project.project_key,
    recipients,
    template: templateRow ? { tpl_key: templateRow.tpl_key, subject, html, missing_variables: missingVars } : null,
    sender: senderRow ? { sender_key: senderRow.sender_key, name: senderRow.company_name_en, email: senderRow.email } : null,
    channels: project.channels || [],
  };

  if (dryRun) return { dryRun: true, preview };

  // ── 真正触发：写 run 记录 + 按渠道执行 ──
  const runIns = await pool.query(
    `INSERT INTO notification_project_runs
       (project_id,project_key,trigger_type,trigger_source,triggered_by,context,resolved_recipients,resolved_template,channels,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running') RETURNING *`,
    [project.id, project.project_key, project.trigger_type, sourceModule || sourceAction || "manual", triggeredBy,
     JSON.stringify(context), JSON.stringify(recipients), JSON.stringify(preview.template || {}), project.channels || []]);
  const run = runIns.rows[0];

  const result = { email: null, inapp: null, task: null };
  let anyFailed = false;

  if ((project.channels || []).includes("email") && templateRow && senderRow) {
    const dmConfigured = !!(process.env.DM_ACCESS_KEY_ID && process.env.DM_ACCESS_KEY_SECRET);
    for (const rcp of recipients) {
      if (!rcp.email) {
        await logEmailMessage(pool, {
          direction: "outbound", message_type: "template_email", template_id: templateRow.id, tpl_key: templateRow.tpl_key,
          template_name: templateRow.name, sender_key: senderRow.sender_key, sender_email: senderRow.email,
          sender_name: senderRow.company_name_en, category: project.category, recipient_type: rcp.type,
          recipient_name: rcp.name, recipient_email: null, subject, order_id: context.order_id || null,
          contract_no: context.contract_no || null, notification_project_id: project.id,
          notification_project_key: project.project_key, trigger_source: sourceModule || "manual",
          triggered_by: triggeredBy, status: "skipped", error_message: "收件人无邮箱(" + rcp.resolved_via + ")",
        });
        continue;
      }
      if (!dmConfigured) {
        await logEmailMessage(pool, {
          direction: "outbound", message_type: "template_email", template_id: templateRow.id, tpl_key: templateRow.tpl_key,
          template_name: templateRow.name, sender_key: senderRow.sender_key, sender_email: senderRow.email,
          sender_name: senderRow.company_name_en, category: project.category, recipient_type: rcp.type,
          recipient_name: rcp.name, recipient_email: rcp.email, subject, body_snapshot: html,
          order_id: context.order_id || null, contract_no: context.contract_no || null,
          notification_project_id: project.id, notification_project_key: project.project_key,
          trigger_source: sourceModule || "manual", triggered_by: triggeredBy,
          status: "pending", error_message: "阿里云DirectMail密钥未配置，未真正发送",
        });
        result.email = { status: "pending", reason: "DM_ACCESS_KEY 未配置" };
        continue;
      }
      try {
        const dm = await sendViaDM({ fromAlias: senderRow.email, fromName: senderRow.company_name_en, to: rcp.email, subject, htmlBody: html });
        const ok = dm && (dm.Code === undefined || dm.Code === "OK");
        await logEmailMessage(pool, {
          direction: "outbound", message_type: "template_email", template_id: templateRow.id, tpl_key: templateRow.tpl_key,
          template_name: templateRow.name, sender_key: senderRow.sender_key, sender_email: senderRow.email,
          sender_name: senderRow.company_name_en, category: project.category, recipient_type: rcp.type,
          recipient_name: rcp.name, recipient_email: rcp.email, subject, body_snapshot: html,
          order_id: context.order_id || null, contract_no: context.contract_no || null,
          notification_project_id: project.id, notification_project_key: project.project_key,
          trigger_source: sourceModule || "manual", triggered_by: triggeredBy,
          status: ok ? "sent" : "failed", provider: "aliyun_directmail", provider_response: dm,
          sent_at: ok ? new Date().toISOString() : null, error_message: ok ? null : JSON.stringify(dm),
        });
        result.email = { status: ok ? "sent" : "failed" };
        if (!ok) anyFailed = true;
      } catch (e) {
        anyFailed = true;
        await logEmailMessage(pool, {
          direction: "outbound", template_id: templateRow.id, tpl_key: templateRow.tpl_key, sender_key: senderRow.sender_key,
          category: project.category, recipient_type: rcp.type, recipient_name: rcp.name, recipient_email: rcp.email,
          subject, notification_project_id: project.id, notification_project_key: project.project_key,
          trigger_source: sourceModule || "manual", triggered_by: triggeredBy, status: "failed", error_message: e.message,
        });
        result.email = { status: "failed", error: e.message };
      }
    }
  }

  await pool.query(
    `UPDATE notification_project_runs SET status=$1, result=$2, finished_at=now() WHERE id=$3`,
    [anyFailed ? "partial_failed" : "success", JSON.stringify(result), run.id]);

  return { dryRun: false, run_id: run.id, status: anyFailed ? "partial_failed" : "success", channels: result, preview };
}
