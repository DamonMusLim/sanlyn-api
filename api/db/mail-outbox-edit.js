import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

const ALLOWED_FIELDS = ["to_emails", "cc_emails", "subject", "body_html", "attachments"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function reject(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

function validateEmails(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && EMAIL_RE.test(item.trim()));
}

function validateChanges(changes) {
  if (!isObject(changes)) return { error: "invalid_changes" };
  const fields = Object.keys(changes);
  const rejected = fields.filter((field) => !ALLOWED_FIELDS.includes(field));
  if (rejected.length) return { error: "rejected_fields", rejected_fields: rejected };
  if (!fields.length) return { error: "empty_changes" };
  if ("to_emails" in changes && !validateEmails(changes.to_emails)) return { error: "invalid_to_emails" };
  if ("cc_emails" in changes && !validateEmails(changes.cc_emails)) return { error: "invalid_cc_emails" };
  if ("subject" in changes && typeof changes.subject !== "string") return { error: "invalid_subject" };
  if ("body_html" in changes && typeof changes.body_html !== "string") return { error: "invalid_body_html" };
  if ("attachments" in changes && !Array.isArray(changes.attachments)) return { error: "invalid_attachments" };
  return { fields };
}

function normalizeValue(field, value) {
  if (field === "to_emails" || field === "cc_emails") return value.map((item) => item.trim());
  return value;
}

function buildUpdate(fields) {
  const sets = [];
  const params = [];
  fields.forEach((field) => {
    params.push(field === "subject" || field === "body_html" ? "$" + (params.length + 1) : "$" + (params.length + 1) + "::jsonb");
    sets.push(`${field} = ${params[params.length - 1]}`);
  });
  const beforeParam = "$" + (params.length + 1) + "::jsonb";
  const editedParam = "$" + (params.length + 2) + "::jsonb";
  sets.push(`before_edit = ${beforeParam} || COALESCE(before_edit, '{}'::jsonb)`);
  sets.push(`edited_fields = (SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(edited_fields, '[]'::jsonb) || ${editedParam}) AS t(value))`);
  return { sql: sets.join(", "), valueCount: params.length };
}

function normalizeRow(row) {
  return {
    id: row.id,
    tpl_key: row.tpl_key,
    sender_key: row.sender_key,
    to_emails: row.to_emails || [],
    cc_emails: row.cc_emails || [],
    subject: row.subject || "",
    body_html: row.body_html || "",
    attachments: row.attachments || [],
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    related_bl_no: row.related_bl_no,
    related_contract_no: row.related_contract_no,
    status: row.status,
    edited_fields: row.edited_fields || [],
    before_edit: row.before_edit || {}
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH, OPTIONS");
    return reject(res, 405, "method_not_allowed");
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = Number(req.body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return reject(res, 400, "invalid_id");

  const checked = validateChanges(req.body?.changes);
  if (checked.error) {
    return reject(res, 400, checked.error, checked.rejected_fields ? { rejected_fields: checked.rejected_fields } : {});
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      `SELECT id, tpl_key, sender_key, to_emails, cc_emails, subject, body_html,
              attachments, entity_type, entity_id, related_bl_no, related_contract_no,
              status, edited_fields, before_edit
         FROM mail_outbox
        WHERE id = $1
        FOR UPDATE`,
      [id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return reject(res, 404, "not_found");
    }
    if (current.status !== "draft") {
      await client.query("ROLLBACK");
      return reject(res, 400, "not_draft");
    }

    const before = {};
    const values = [];
    checked.fields.forEach((field) => {
      before[field] = current[field] == null ? null : current[field];
      const value = normalizeValue(field, req.body.changes[field]);
      values.push(field === "subject" || field === "body_html" ? value : JSON.stringify(value));
    });
    values.push(JSON.stringify(before), JSON.stringify(checked.fields), id);

    const update = buildUpdate(checked.fields);
    const idParam = "$" + (update.valueCount + 3);
    const updated = await client.query(
      `UPDATE mail_outbox
          SET ${update.sql}
        WHERE id = ${idParam}
        RETURNING id, tpl_key, sender_key, to_emails, cc_emails, subject, body_html,
                  attachments, entity_type, entity_id, related_bl_no, related_contract_no,
                  status, edited_fields, before_edit`,
      values
    );
    await client.query("COMMIT");
    return res.status(200).json({ ok: true, data: normalizeRow(updated.rows[0]) });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("[mail-outbox-edit] Error:", err);
    return reject(res, 500, "internal_error");
  } finally {
    client.release();
  }
}
