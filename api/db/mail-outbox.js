import { requireAuth, setCors } from './_auth.js';
import { getPool } from './_db.js';

const ALLOWED_STATUSES = new Set(['pending', 'changes', 'approved', 'sent', 'rejected', 'failed']);

function getStatusFilter(value) {
  if (!value) return ['pending', 'changes'];
  const status = String(value).trim();
  return ALLOWED_STATUSES.has(status) ? [status] : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  }
  return [value];
}

function parseJsonValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRow(row) {
  return {
    id: row.id,
    tpl_key: row.tpl_key,
    sender_key: row.sender_key,
    to_emails: asArray(row.to_emails),
    cc_emails: asArray(row.cc_emails),
    subject: row.subject || '',
    body_html: row.body_html || '',
    attachments: parseJsonValue(row.attachments, []),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    related_bl_no: row.related_bl_no,
    status: row.status,
    prepared_by: row.prepared_by,
    prepared_at: row.prepared_at,
    review_note: row.review_note || ''
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const statuses = getStatusFilter(req.query?.status);
  if (!statuses) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }

  const pool = getPool();
  const params = [statuses, 50];
  const { rows } = await pool.query(
    `
      SELECT
        id, tpl_key, sender_key, to_emails, cc_emails, subject,
        body_html, attachments, entity_type, entity_id, related_bl_no,
        status, prepared_by, prepared_at, review_note
      FROM mail_outbox
      WHERE status = ANY($1::text[])
      ORDER BY created_at DESC
      LIMIT $2
    `,
    params
  );

  return res.status(200).json({ ok: true, data: rows.map(normalizeRow) });
}
