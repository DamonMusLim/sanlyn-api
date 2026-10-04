import { fail } from './hr-bossdesk-msgs-chat.mjs';

const SOURCES = `WITH history AS (
  SELECT 'mail' AS kind, id::text AS id,
    CASE WHEN status='sent' THEN sent_at ELSE updated_at END AS at,
    jsonb_build_object('id',id,'status',status,'to_emails',to_emails,'subject',subject,
      'body_html',body_html,'sent_by',sent_by,'reviewed_by',reviewed_by,'before_edit',before_edit,
      'review_note',review_note,'ai_note',ai_note) AS data
  FROM public.mail_outbox WHERE status IN ('sent','cancelled')
  UNION ALL
  SELECT 'chat',id::text,created_at,
    jsonb_build_object('task_id',task_id,'action',action,'note',note,'prev',prev)
  FROM boss_decisions WHERE action IN ('boss_msg_send','boss_msg_dismiss')
    AND task_id LIKE 'chat:%' AND undone_at IS NULL
    AND prev->>'phase'='completed'
)`;

export function mapHistory(row) {
  const data = row.data;
  if (row.kind === 'mail') {
    // cancelOutbox 把取消人/原因写进 ai_note，不能把 reviewed_by 猜成取消人。
    const cancelled = data.status === 'cancelled';
    const cancel = String(data.ai_note || '').match(/(?:^|\n)不发：([\s\S]*)；操作人：([^\n]+)$/);
    return { id: `mail:${data.id}`, channel: 'email',
      counterparty: Array.isArray(data.to_emails) ? data.to_emails.join(', ') : '',
      subject: data.subject || '', summary: '', final_reply: cancelled ? '' : data.body_html || '',
      body_format: 'html', before_edit: data.before_edit || null,
      actor: cancelled ? cancel?.[2] || '' : data.reviewed_by || data.sent_by || '', at: row.at, // sent_by 是发件邮箱代号,点审核的人在 reviewed_by
      outcome: cancelled ? 'dismissed' : 'sent', note: cancelled ? cancel?.[1] || '' : data.review_note || '' };
  }
  const prev = data.prev || {};
  return { id: `decision:${row.id}`, message_id: data.task_id, channel: prev.channel || '',
    counterparty: prev.counterparty || '', subject: prev.subject || '', summary: prev.summary || '',
    final_reply: prev.final_reply || '', body_format: 'text', actor: prev.actor || '', at: row.at,
    // queued 不伪装成已发；增加 queued 值，前端需按 status/outcome 显示排队。
    outcome: data.action === 'boss_msg_dismiss' ? 'dismissed' : prev.status,
    status: prev.status, note: prev.reason || data.note || '' };
}

export async function messageHistory(pool, body, now = Date.now()) {
  const before = body.before === undefined ? new Date(now).toISOString() : body.before;
  if (typeof before !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(before) ||
      !Number.isFinite(Date.parse(before))) throw fail(400, 'before 须为 ISO 时间');
  const limit = body.limit === undefined ? 20 : body.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(400, 'limit 须为1至100整数');
  const lower = new Date(Date.parse(before) - 7 * 86400000).toISOString();
  // WITH TIES 保全同一时间戳，ISO 游标不丢同秒/同微秒记录；并列时该页可超过 limit。
  const { rows } = await pool.query(`${SOURCES}
    SELECT kind,id,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,data
    FROM history WHERE at < $1::timestamptz AND at >= $2::timestamptz
    ORDER BY history.at DESC FETCH FIRST $3 ROWS WITH TIES`, [before, lower, limit]);
  let next = rows.length >= limit ? rows.at(-1).at : lower;
  const older = await pool.query(`${SOURCES} SELECT EXISTS
    (SELECT 1 FROM history WHERE at < $1::timestamptz) AS older`, [next]);
  if (!older.rows[0]?.older) next = null;
  return { success: true, items: rows.map(mapHistory), next_before: next };
}
