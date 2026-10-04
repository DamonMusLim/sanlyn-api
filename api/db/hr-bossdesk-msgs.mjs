// 老板确认后桥接现有发件台/聊天发送闸，不代替审核、不直接写财务事实。
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { fail, requestJson, readChat, mapChat, sendChat, chatKey, ownerApproval } from './hr-bossdesk-msgs-chat.mjs';
import { messageHistory } from './hr-bossdesk-msgs-history.mjs';

export const MESSAGE_ACTIONS = ['boss_msg_detail', 'boss_msg_preview', 'boss_msg_send', 'boss_msg_dismiss', 'boss_msg_history'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FIELDS = 'id,sender_key,to_emails,cc_emails,subject,body_html,attachments,status,prepared_at,ai_note';
const PENDING = "status IN ('draft','changes') AND prepared_at >= now()-interval '30 days'";
const isBoss = actor => String(process.env.BOSS_EMPLOYEE_IDS || '35').split(',').map(x => x.trim()).includes(actor);

function messageId(id) {
  if (typeof id !== 'string' || !/^(mail:[1-9][0-9]{0,18}|chat:[A-Za-z0-9_-]{1,160})$/.test(id)) throw fail(400, '缺有效消息id');
  return id.startsWith('mail:');
}
function mapped(row) {
  return { id: `mail:${row.id}`, channel: 'email', source_label: '发件台',
    counterparty: Array.isArray(row.to_emails) ? row.to_emails.join(', ') : '', subject: row.subject ?? '',
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
  const { rows } = await pool.query(`SELECT ${FIELDS} FROM public.mail_outbox WHERE id=$1 AND ${PENDING}`, [id.slice(5)]);
  if (!rows[0]) throw fail(404, '邮件不存在或已不在待处理列表');
  return rows[0];
}
function detail(row, mail) {
  if (!mail) return { ...mapChat(row, row.task), original: row.messages, draft: row.draft?.text || '',
    body_format: 'text', can_send: true, can_dismiss: true, category_label: row.draft?.category_label || '', why: row.draft?.why || [] };
  return { ...mapped(row), original: '', ai_note: row.ai_note ?? '', draft: row.body_html ?? '',
    body_format: 'html', sender_key: row.sender_key, to_emails: row.to_emails, cc_emails: row.cc_emails,
    attachments: Array.isArray(row.attachments) ? row.attachments : [], can_send: true, can_dismiss: true };
}
function bodyText(body, max = 100000) {
  if (typeof body !== 'string' || !body.trim() || body.length > max) throw fail(400, `正文须为1至${max}字符`);
  return body;
}
function reasonText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw fail(400, '不用回理由须为1至2000字符');
  return value;
}
function mac(payload) {
  if (!process.env.JWT_SECRET) throw fail(503, '确认签名暂不可用');
  return createHmac('sha256', process.env.JWT_SECRET).update('boss-msg:' + payload).digest('hex');
}
function sign(id, body, row, actor, intent) {
  const payload = Buffer.from(JSON.stringify({ id, body_hash: hash(body), version: hash(row), intent,
    actor, issued: Date.now(), nonce: randomUUID() })).toString('base64url');
  return payload + '.' + mac(payload);
}
function verify(token, id, body, actor, intent) {
  if (typeof token !== 'string' || token.length > 4096) throw fail(409, '确认凭证无效');
  const [payload, sig, extra] = token.split('.');
  if (extra !== undefined || !payload || !/^[a-f0-9]{64}$/.test(sig ?? '')) throw fail(409, '确认凭证无效');
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(payload), 'hex'))) throw fail(409, '确认凭证无效');
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { throw fail(409, '确认凭证无效'); }
  if (!data || data.id !== id || data.intent !== intent || data.actor !== actor || data.body_hash !== hash(body) ||
      !Number.isFinite(data.issued) || Date.now() < data.issued || Date.now() - data.issued >= 300000) {
    throw fail(409, '确认已过期或内容改变，请重新确认');
  }
  return data;
}

// 与 acfin routes.mjs:firstRecipientEmail/mailConfirmPrefix 的确认串契约一致。
function mailConfirm(row) {
  const raw = (row.to_emails || []).map(x => String(x || '').trim()).find(Boolean) || '';
  const angle = raw.match(/<([^<>\s@]+@[^<>\s@]+)>/);
  const email = (angle ? angle[1] : raw.split(/\s+/).find(part => part.includes('@')) || raw).replace(/[;,，；]+$/u, '').trim();
  if (!email.includes('@')) throw fail(400, 'confirm_target_unresolved');
  return email.split('@', 1)[0].trim();
}
async function mailIdentity(pool) {
  const { rows } = await pool.query("SELECT id,username,role FROM accounts WHERE username=$1 AND is_active IS TRUE", ['damon']);
  if (rows.length !== 1) throw fail(503, '发件台身份不可用');
  return rows[0];
}
async function mailMutation(id, row, content, dismiss, identity) {
  // 惰性导入：只有老板闸、签名、当前快照校验全部通过后才会签发。
  // 代 Damon 调发件台的临时凭证:60 秒有效,只在内存用一次
  const { generateToken } = await import('../auth.js');
  const token = generateToken({ uid: identity.id, username: identity.username, role: identity.role, via: 'bossdesk' }, 60);
  const call = (suffix, method, body) => requestJson(`${(process.env.ACFIN_BASE || "http://127.0.0.1:4790").replace(/\/+$/, "")}/ac/api/mail-outbox/${id.slice(5)}${suffix}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }, [token]);
  if (dismiss) return call('/cancel', 'POST', { reason: content });
  if (content !== row.body_html) await call('', 'PATCH', { body_html: content });
  return call('/send', 'POST', { confirm: mailConfirm(row) });
}

async function mutate(pool, id, mail, content, actor, intent, signed) {
  // 会话级锁跨越上游调用；pending 留痕先提交。中断/超时不可当成没发而重试。
  const c = await pool.connect();
  let locked = false, recorded = false, remoteSucceeded = false;
  const batch = 'msg-' + randomUUID();
  try {
    const lock = await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', ['boss-msg:' + id]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw fail(409, '消息正在处理，请勿重复提交');
    const previous = await c.query(`SELECT id FROM boss_decisions WHERE task_id=$1
      AND action IN ('boss_msg_send','boss_msg_dismiss') AND undone_at IS NULL
      AND (prev->>'phase'='pending' OR prev->>'version'=$2 AND prev->>'phase'='completed') LIMIT 1`, [id, signed.version]);
    if (previous.rows.length) throw fail(409, '消息已处理或结果待核实，请勿重复发送');
    const row = mail ? await readMail(c, id) : await readChat(c, id);
    if (signed.version !== hash(row)) throw fail(409, '消息已变化，请重新确认');
    const dismiss = intent === 'dismiss';
    const identity = mail ? await mailIdentity(c) : null;
    if (!mail && !dismiss) {
      if (row.need_owner && !mapChat(row, row.task).nora) throw fail(409, 'Nora 还没看完');
      ownerApproval(String(row.conversation_id), content); // 写 pending 之前确认必需配置存在。
    }
    if (mail && !dismiss) mailConfirm(row);
    const item = detail(row, mail);
    const prev = { phase: 'pending', version: signed.version, actor: 'damon', employee_id: actor,
      channel: item.channel, counterparty: item.counterparty, subject: item.subject, summary: item.summary,
      final_reply: dismiss ? '' : content, reason: dismiss ? content : '',
      chat_key: mail ? null : chatKey(row) };
    const note = '经待我处理：' + (dismiss ? `不用回：${content.slice(0, 200)}；正文：${String(item.draft || '').slice(0, 200)}` : content.slice(0, 200));
    await c.query(`INSERT INTO boss_decisions (batch_id,task_id,action,note,prev)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [batch, id, dismiss ? 'boss_msg_dismiss' : 'boss_msg_send', note, JSON.stringify(prev)]);
    recorded = true;
    const result = mail ? await mailMutation(id, row, content, dismiss, identity) : dismiss ? { status: 'dismissed' } : await sendChat(row, content, actor);
    remoteSucceeded = true;
    if (!result || typeof result !== 'object' || !result.status ||
        mail && !(dismiss ? ['cancelled'] : ['approved', 'sent']).includes(result.status)) {
      throw fail(502, '消息处理状态未知，请核实');
    }
    prev.status = result.status;
    prev.phase = result.status === 'blocked' ? 'blocked' : 'completed';
    if (!dismiss && result.reason) prev.reason = result.reason;
    // 本地留痕和 chat-owner 结单要么一起成功，要么 pending 留待核实。
    await c.query('BEGIN');
    try {
      await c.query('UPDATE boss_decisions SET prev=$2::jsonb WHERE batch_id=$1', [batch, JSON.stringify(prev)]);
      if (!mail && ['sent', 'queued', 'dismissed'].includes(result.status)) {
        await c.query(`UPDATE tasks SET status='done',closed_at=now(),updated_at=now()
          WHERE source='chat-owner' AND dedupe_key=$1 AND status NOT IN ('done','cancelled')`, [chatKey(row)]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    return { ...result, success: true };
  } catch (e) {
    // 只有明确的上游4xx拒绝可解除 pending；5xx/网络失败/落账失败须先核实。
    if (recorded && !remoteSucceeded && e.upstream && e.status >= 400 && e.status < 500) {
      await c.query(`UPDATE boss_decisions SET prev=jsonb_set(prev,'{phase}','"rejected"'::jsonb) WHERE batch_id=$1`, [batch]);
    }
    if (remoteSucceeded) throw fail(503, '上游已处理，本地留痕未完成；请核实，勿重复发送');
    throw e;
  } finally {
    try { if (locked) await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['boss-msg:' + id]); }
    finally { c.release(); }
  }
}

export async function tryMessageAction({ action, b, res, pool, me, empId }) {
  if (!MESSAGE_ACTIONS.includes(action)) return false;
  try {
    const actor = String(me?.id || me?.employee_id || empId || '');
    if (!isBoss(actor)) throw fail(403, '只有老板能操作');
    if (action === 'boss_msg_history') { res.status(200).json(await messageHistory(pool, b)); return true; }
    const id = b.id, mail = messageId(id);
    const intent = action === 'boss_msg_dismiss' ? 'dismiss' : action === 'boss_msg_preview' ? b.intent || 'send' : 'send';
    if (!['send', 'dismiss'].includes(intent)) throw fail(400, '确认操作无效');
    let content = action === 'boss_msg_detail' ? null : intent === 'dismiss' ? reasonText(b.note) : bodyText(b.body, mail ? 100000 : 3000);
    if (!mail && intent === 'send' && content !== null) content = content.trim();
    if (action === 'boss_msg_send' || action === 'boss_msg_dismiss') {
      const signed = verify(b.token, id, content, actor, intent);
      res.status(200).json(await mutate(pool, id, mail, content, actor, intent, signed));
    } else {
      const row = mail ? await readMail(pool, id) : await readChat(pool, id);
      const data = detail(row, mail);
      if (action === 'boss_msg_preview') Object.assign(data, { body: content, intent,
        token: sign(id, content, row, actor, intent), expires_in: 300 });
      res.status(200).json({ success: true, ...data });
    }
  } catch (e) {
    res.status(e.status || 500).json(e.upstream ? { ...e.upstream, success: false } :
      { success: false, error: e.status ? e.message : '消息处理失败，请稍后重试' });
  }
  return true;
}
