import { createHmac } from 'node:crypto';
import { parseNora } from './hr-bossdesk-dna.mjs';

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const chatKey = row => `chat-owner:${row.conversation_id}:${row.last_at}`;

// 不跟随重定向，凭证不交给其它主机；不记录上游请求或异常对象。
export async function requestJson(url, options, secrets = []) {
  let response;
  try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
  catch { throw fail(504, '消息服务结果未知，请核实后再操作'); }
  let data;
  try {
    const raw = await response.text();
    try { data = JSON.parse(raw); } catch { data = { error: raw }; }
  } catch { throw fail(504, '消息服务结果未知，请核实后再操作'); }
  const scrub = value => {
    if (typeof value === 'string') return secrets.reduce((s, key) => key ? s.split(key).join('[凭证已隐藏]') : s, value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/token|authorization/i.test(key)).map(([key, val]) => [key, scrub(val)]));
    return value;
  };
  data = scrub(data);
  if (!response.ok) throw Object.assign(fail(response.status, data?.error || '消息服务拒绝请求'), { upstream: data });
  return data;
}

export async function relay(path, body) {
  const token = process.env.MSG_RELAY_TOKEN;
  if (!token) throw fail(503, '消息服务未配置');
  const base = (process.env.MSG_RELAY_BASE || 'http://100.87.134.113:3798').replace(/\/+$/, '');
  return requestJson(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, [token]);
}

export async function conversations() {
  const rows = await relay('/api/inbox/conversations');
  if (!Array.isArray(rows)) throw fail(502, '聊天列表格式不可用');
  return rows;
}

export async function conversation(row) {
  const data = await relay(`/api/inbox/conversation/${encodeURIComponent(row.conversation_id)}`);
  if (!Array.isArray(data?.messages)) throw fail(502, '聊天详情格式不可用');
  const messages = [...data.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ...row, messages, draft: data.draft, need_owner: row.need_owner === true || data.draft?.need_owner === true };
}

export function awaitingReply(row) {
  return row.need_owner === true || row.messages.at(-1)?.from === 'customer';
}

export async function chatTask(pool, row) {
  const { rows } = await pool.query(`SELECT id,status,next_action FROM tasks
    WHERE source='chat-owner' AND dedupe_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [chatKey(row)]);
  return rows[0] || null;
}

async function handled(pool, row) {
  const { rows } = await pool.query(`SELECT id FROM boss_decisions WHERE task_id=$1
    AND action IN ('boss_msg_send','boss_msg_dismiss') AND undone_at IS NULL
    AND prev->>'chat_key'=$2 AND prev->>'phase'='completed' LIMIT 1`, [`chat:${row.conversation_id}`, chatKey(row)]);
  return rows.length > 0;
}

export function mapChat(row, task) {
  return { id: `chat:${row.conversation_id}`, channel: row.channel, account: row.account,
    source_label: '聊天', counterparty: row.customer_name || '', subject: '', summary: row.last_message || '',
    received_at: row.last_at || null, needs_owner: row.need_owner === true,
    nora: parseNora(task?.next_action), has_draft: !!row.draft?.text,
    waiting: row.need_owner && !parseNora(task?.next_action) ? 'Nora 还没看完' : '待回复' };
}

// 通知/短信/系统号不进「消息」(Damon:广告、通知不进)。统一客服对这些会话没有分类,只能按确定特征挡。
// ponytail: 名单式过滤,新出现的通知号要补名单;等统一客服有分类后改用分类。
const NOISE_NAMES = new Set(['对外收款', '客户联系', '📬 邮件提醒']);
export function isNoise(row) {
  const name = String(row.customer_name || '').trim();
  return row.account === 'system' || /^\d{4,}$/.test(name) || NOISE_NAMES.has(name)
    || /正在转接另一个客服/.test(String(row.last_message || ''));
}

export async function buildChats(pool) {
  const items = [];
  // 先用列表字段粗筛再拉详情:全量 600+ 会话逐个拉详情太重。
  // ponytail: 只看近 7 天最新 30 个(已读未回也要看,不能按未读数筛);更老的未回会话会漏,量大了改分页。
  const since = Date.now() - 7 * 86400000;
  const candidates = (await conversations())
    .filter(r => Date.parse(r.last_at) >= since)
    .sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at)).slice(0, 30);
  for (const full of await Promise.all(candidates.filter(r => !isNoise(r)).map(conversation))) {
    // 列表没有方向字段，必须读真实消息；不把 unread 当作客人未回复。
    if (awaitingReply(full) && !await handled(pool, full)) items.push(mapChat(full, await chatTask(pool, full)));
  }
  return items;
}

export async function readChat(pool, id) {
  const rows = await conversations();
  const row = rows.find(item => String(item.conversation_id) === id.slice(5));
  if (!row) throw fail(404, '会话不存在');
  const full = await conversation(row);
  if (!awaitingReply(full) || await handled(pool, full)) throw fail(409, '会话已处理，请刷新');
  if (!full.draft?.text) { // 没草稿就按需让统一客服生成(带分类,要老板批的会被标出来)
    try {
      const made = await relay('/api/inbox/suggest', { conversation_id: String(row.conversation_id) });
      if (made?.draft) Object.assign(full, { draft: made.draft, need_owner: full.need_owner || made.draft.need_owner === true });
    } catch { full.draft_error = 'AI 草稿没生成出来,可以直接写'; } // 生成失败不挡打开
  }
  return { ...full, task: await chatTask(pool, full) };
}

export function ownerApproval(conversationId, text, at = new Date().toISOString()) {
  const secret = process.env.OWNER_APPROVAL_SECRET;
  if (!secret) throw fail(503, '老板批准签名未配置');
  return { by: 'damon', at, sig: createHmac('sha256', secret).update(`${conversationId}\n${text}\n${at}`).digest('hex') };
}

export async function sendChat(row, text, actor) {
  if (row.need_owner && !parseNora(row.task?.next_action)) throw fail(409, 'Nora 还没看完');
  const result = await relay('/api/inbox/send', { conversation_id: String(row.conversation_id), text,
    sender_employee_id: actor, sender_name: 'damon', owner_approval: ownerApproval(String(row.conversation_id), text) });
  if (!['sent', 'queued', 'blocked'].includes(result?.status)) throw fail(502, '聊天发送状态未知，请核实');
  return result;
}
