// 邮件只读接入；真人会话桥接未确认前，发送/取消保持 fail-closed。
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export const MESSAGE_ACTIONS = ['boss_msg_detail', 'boss_msg_preview', 'boss_msg_send', 'boss_msg_dismiss'];
export const CHAT_UNAVAILABLE = '聊天未接入：消息接口缺客人消息ID及老板批准发送字段';
const MAIL_UNAVAILABLE = '发件台需要真人登录会话，尚未接入审核/发送/取消授权';
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FIELDS = 'id,sender_key,to_emails,cc_emails,subject,body_html,attachments,status,prepared_at,ai_note';
const PENDING = "status IN ('draft','changes') AND prepared_at >= now()-interval '30 days'";

function mailId(id) {
  if (typeof id !== 'string' || !/^mail:[1-9][0-9]{0,18}$/.test(id)) {
    if (typeof id === 'string' && id.startsWith('chat:')) throw fail(503, CHAT_UNAVAILABLE);
    throw fail(400, '缺有效消息id');
  }
  return id.slice(5);
}
function mapped(row) {
  return { id: `mail:${row.id}`, channel: 'email', source_label: '发件台',
    counterparty: Array.isArray(row.to_emails) ? row.to_emails.join(', ') : '',
    subject: row.subject ?? '',
    // ai_note 已确认包含内部起草/缺料备注，未找到「对方诉求摘要」的可靠格式。
    summary: '', received_at: null, prepared_at: row.prepared_at,
    waiting: row.status === 'changes' ? '待修改' : '待审核', needs_owner: true,
    nora: null, has_draft: typeof row.body_html === 'string' && !!row.body_html.trim() };
}
export async function buildMessages(pool) {
  const { rows } = await pool.query(`SELECT ${FIELDS} FROM public.mail_outbox
    WHERE ${PENDING} ORDER BY prepared_at DESC,id DESC`);
  return rows.map(mapped);
}
async function readMail(pool, id) {
  const { rows } = await pool.query(`SELECT ${FIELDS} FROM public.mail_outbox
    WHERE id=$1 AND ${PENDING}`, [mailId(id)]);
  if (!rows[0]) throw fail(404, '邮件不存在或已不在待处理列表');
  return rows[0];
}
function detail(row) {
  return { ...mapped(row), original: '', ai_note: row.ai_note ?? '',
    draft: row.body_html ?? '', body_format: 'html', sender_key: row.sender_key,
    to_emails: row.to_emails, cc_emails: row.cc_emails,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    can_send: false, can_dismiss: false, unavailable_reason: MAIL_UNAVAILABLE };
}
function bodyText(body) {
  if (typeof body !== 'string' || !body.trim() || body.length > 100000) throw fail(400, '正文须为1至100000字符');
  return body; // 不截断、不改写确认的正文。
}
function mac(payload) {
  if (!process.env.JWT_SECRET) throw fail(503, '确认签名暂不可用');
  return createHmac('sha256', process.env.JWT_SECRET).update('boss-msg:' + payload).digest('hex');
}
function sign(id, body, row, actor) {
  const payload = Buffer.from(JSON.stringify({ id, body_hash: hash(body), version: hash(row),
    actor, issued: Date.now(), nonce: randomUUID() })).toString('base64url');
  return payload + '.' + mac(payload);
}
function verify(token, id, body, actor) {
  if (typeof token !== 'string' || token.length > 4096) throw fail(409, '确认凭证无效');
  const [payload, sig, extra] = token.split('.');
  if (extra !== undefined || !payload || !/^[a-f0-9]{64}$/.test(sig ?? '')) throw fail(409, '确认凭证无效');
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(payload), 'hex'))) throw fail(409, '确认凭证无效');
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { throw fail(409, '确认凭证无效'); }
  if (!data || data.id !== id || data.actor !== actor || data.body_hash !== hash(body) ||
      !Number.isFinite(data.issued) || Date.now() < data.issued || Date.now() - data.issued >= 300000) {
    throw fail(409, '确认已过期或内容改变，请重新确认');
  }
  return data;
}

// 只能由 tryBossdeskAction 的老板闸分发，不能单独注册为公开路由。
export async function tryMessageAction({ action, b, res, pool, me, empId }) {
  if (!MESSAGE_ACTIONS.includes(action)) return false;
  try {
    const id = b.id;
    mailId(id);
    const actor = String(me?.id || me?.employee_id || empId || '');
    const body = ['boss_msg_preview', 'boss_msg_send'].includes(action) ? bodyText(b.body) : null;
    const signed = action === 'boss_msg_send' ? verify(b.token, id, body, actor) : null;
    const row = await readMail(pool, id);
    if (signed && signed.version !== hash(row)) throw fail(409, '邮件已变化，请重新确认');
    if (action === 'boss_msg_send' || action === 'boss_msg_dismiss') throw fail(503, MAIL_UNAVAILABLE);
    const data = detail(row);
    if (action === 'boss_msg_preview') {
      data.body = body;
      data.token = sign(id, body, row, actor);
      data.expires_in = 300;
    }
    res.status(200).json({ success: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.status ? e.message : '消息读取失败，请稍后重试' });
  }
  return true;
}
