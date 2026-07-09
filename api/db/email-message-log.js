// api/db/email-message-log.js — 邮件收发记录 + 归纳统计
// GET  /api/db/email-message-log            → 列表(筛选:direction/status/category/recipient_type/
//        recipient_ref_table/recipient_ref_id/template_id/project_key/order_id/contract_no/date_from/date_to)
// GET  /api/db/email-message-log?stats=1&group_by=recipient|category|template|day|week|month|project|status
// POST /api/db/email-message-log            → 内部写入一条记录(供 notify-trigger.js 等内部调用/直接HTTP写)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function ensureEmailMessageLog(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_message_log (
      id BIGSERIAL PRIMARY KEY,
      direction TEXT DEFAULT 'outbound',
      message_type TEXT DEFAULT 'template_email',
      template_id INTEGER, tpl_key TEXT, template_name TEXT,
      sender_key TEXT, sender_email TEXT, sender_name TEXT,
      category TEXT,
      recipient_type TEXT, recipient_ref_table TEXT, recipient_ref_id TEXT,
      recipient_name TEXT, recipient_email TEXT,
      cc_emails TEXT[] DEFAULT '{}', bcc_emails TEXT[] DEFAULT '{}',
      subject TEXT, body_snapshot TEXT,
      order_id BIGINT, contract_no TEXT,
      business_object_type TEXT, business_object_id TEXT,
      notification_project_id BIGINT, notification_project_key TEXT,
      trigger_source TEXT, triggered_by TEXT,
      status TEXT DEFAULT 'pending',
      provider TEXT, provider_message_id TEXT, provider_response JSONB DEFAULT '{}'::jsonb,
      error_code TEXT, error_message TEXT,
      queued_at TIMESTAMPTZ DEFAULT now(), sent_at TIMESTAMPTZ, failed_at TIMESTAMPTZ,
      raw JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_eml_sent_at   ON email_message_log(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_eml_dir_status ON email_message_log(direction, status);
    CREATE INDEX IF NOT EXISTS idx_eml_recipient  ON email_message_log(recipient_type, recipient_ref_table, recipient_ref_id);
    CREATE INDEX IF NOT EXISTS idx_eml_category   ON email_message_log(category, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_eml_template    ON email_message_log(template_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_eml_project     ON email_message_log(notification_project_key, sent_at DESC);
  `).catch(() => {});
}

// 供其它后端模块(notify-trigger.js)直接调用写日志，不走HTTP
export async function logEmailMessage(pool, fields) {
  await ensureEmailMessageLog(pool);
  const cols = [
    "direction","message_type","template_id","tpl_key","template_name",
    "sender_key","sender_email","sender_name","category",
    "recipient_type","recipient_ref_table","recipient_ref_id","recipient_name","recipient_email",
    "cc_emails","bcc_emails","subject","body_snapshot",
    "order_id","contract_no","business_object_type","business_object_id",
    "notification_project_id","notification_project_key","trigger_source","triggered_by",
    "status","provider","provider_message_id","provider_response",
    "error_code","error_message","sent_at","failed_at","raw",
  ];
  const vals = cols.map(c => fields[c] !== undefined ? fields[c] : null);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const r = await pool.query(
    `INSERT INTO email_message_log (${cols.join(",")}) VALUES (${placeholders}) RETURNING *`,
    vals.map((v, i) => {
      if (cols[i] === "cc_emails" || cols[i] === "bcc_emails") return v || [];
      if (cols[i] === "provider_response" || cols[i] === "raw") return JSON.stringify(v || {});
      return v;
    })
  );
  return r.rows[0];
}

const GROUP_COLUMNS = {
  recipient: ["recipient_type", "recipient_ref_table", "recipient_ref_id", "recipient_name"],
  category: ["category"],
  template: ["template_id", "tpl_key", "template_name"],
  project: ["notification_project_key"],
  status: ["status"],
};

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensureEmailMessageLog(pool);

    if (req.method === "POST") {
      const row = await logEmailMessage(pool, req.body || {});
      return res.json({ success: true, data: row });
    }

    if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

    const q = req.query || {};
    const where = [], params = [];
    const push = (cond, val) => { params.push(val); where.push(cond.replace("?", `$${params.length}`)); };
    if (q.direction) push("direction = ?", q.direction);
    if (q.status) push("status = ?", q.status);
    if (q.category) push("category = ?", q.category);
    if (q.recipient_type) push("recipient_type = ?", q.recipient_type);
    if (q.recipient_ref_table) push("recipient_ref_table = ?", q.recipient_ref_table);
    if (q.recipient_ref_id) push("recipient_ref_id = ?", q.recipient_ref_id);
    if (q.template_id) push("template_id = ?", q.template_id);
    if (q.project_key) push("notification_project_key = ?", q.project_key);
    if (q.order_id) push("order_id = ?", q.order_id);
    if (q.contract_no) push("contract_no = ?", q.contract_no);
    if (q.date_from) push("sent_at >= ?", q.date_from);
    if (q.date_to) push("sent_at <= ?", q.date_to);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    if (q.stats === "1" || q.stats === "true") {
      const groupBy = q.group_by || "category";
      if (groupBy === "day" || groupBy === "week" || groupBy === "month") {
        const trunc = groupBy === "day" ? "day" : groupBy === "week" ? "week" : "month";
        const r = await pool.query(
          `SELECT date_trunc('${trunc}', sent_at) AS bucket,
                  count(*)::int AS total_count,
                  count(*) FILTER (WHERE status='failed')::int AS failed_count
             FROM email_message_log ${whereSql}
            GROUP BY bucket ORDER BY bucket DESC LIMIT 90`, params);
        return res.json({ success: true, group_by: groupBy, data: r.rows });
      }
      const cols = GROUP_COLUMNS[groupBy] || GROUP_COLUMNS.category;
      const r = await pool.query(
        `SELECT ${cols.join(",")},
                count(*)::int AS total_count,
                count(*) FILTER (WHERE status='failed')::int AS failed_count,
                max(sent_at) AS last_sent_at
           FROM email_message_log ${whereSql}
          GROUP BY ${cols.join(",")}
          ORDER BY total_count DESC LIMIT 200`, params);
      return res.json({ success: true, group_by: groupBy, data: r.rows });
    }

    const page = Math.max(1, parseInt(q.page) || 1);
    const pageSize = Math.min(200, parseInt(q.page_size) || 50);
    const r = await pool.query(
      `SELECT * FROM email_message_log ${whereSql}
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
    const c = await pool.query(`SELECT count(*)::int AS n FROM email_message_log ${whereSql}`, params);
    return res.json({ success: true, data: r.rows, total: c.rows[0].n, page, page_size: pageSize });
  } catch (e) {
    console.error("[email-message-log]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
