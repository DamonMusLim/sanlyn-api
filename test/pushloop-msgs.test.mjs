import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBossdesk, tryBossdeskAction } from '../api/db/hr-bossdesk.mjs';
import { buildMessages, tryMessageAction } from '../api/db/hr-bossdesk-msgs.mjs';
import { buildChats, ownerApproval } from '../api/db/hr-bossdesk-msgs-chat.mjs';
import { messageHistory, mapHistory } from '../api/db/hr-bossdesk-msgs-history.mjs';
import { buildTaskList } from '../api/db/hr-bossdesk-tasks.mjs';
import { enqueueChatOwners } from '../scripts/chat-owner-to-nora.mjs';
process.env.JWT_SECRET = 'offline-test-only-not-a-real-secret';
process.env.BOSS_EMPLOYEE_IDS = '35';
process.env.MSG_RELAY_TOKEN = 'offline-relay-fixture';
process.env.OWNER_APPROVAL_SECRET = 'test-owner-secret';
const mail = { id: '12', sender_key: 'petbaby', to_emails: ['Customer <customer@example.invalid>'],
  cc_emails: [], subject: '测试邮件', body_html: '<p>草稿</p>', attachments: [{ name: '单据.pdf' }],
  status: 'draft', prepared_at: '2026-10-04T00:00:00Z', ai_note: '内部备注' };
const chat = { conversation_id: '17', channel: 'wework', account: 'test', customer_name: '客人',
  last_message: '可以吗', last_at: '2026-10-04T02:00:00Z', need_owner: true, unread: 1, has_draft: true };
const chatDetail = { messages: [{ from: 'customer', text: '可以吗', at: chat.last_at }],
  draft: { text: '可以', category_label: '要老板批', need_owner: true, why: ['待批准'] } };
function db(row = mail) {
  const pool = { calls: [], row: row && structuredClone(row), decisions: [], task: { id: 't1', status: 'open', next_action: 'Nora建议: 批 — 可以回复' },
    account: { id: 91, username: 'damon', role: 'petstore' }, locked: true, tasks: new Map() };
  pool.query = async (sql, args = []) => {
    pool.calls.push({ sql, args });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: pool.locked }] };
    if (sql.includes('pg_advisory_unlock') || ['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM accounts')) return { rows: pool.account ? [pool.account] : [] };
    if (sql.includes('FROM public.mail_outbox')) return { rows: pool.row ? [structuredClone(pool.row)] : [] };
    if (sql.includes('SELECT id,status,next_action FROM tasks')) return { rows: pool.task ? [structuredClone(pool.task)] : [] };
    if (sql.includes('SELECT id FROM boss_decisions')) return { rows: pool.decisions.filter(d => d.task_id === args[0] &&
      (sql.includes("prev->>'chat_key'") ? d.prev.chat_key === args[1] && d.prev.phase === 'completed' :
        d.prev.phase === 'pending' || d.prev.version === args[1] && d.prev.phase === 'completed')) };
    if (sql.includes('INSERT INTO boss_decisions')) {
      if (pool.failInsert) throw Error('offline audit failure');
      pool.decisions.push({ batch_id: args[0], task_id: args[1], action: args[2], note: args[3], prev: JSON.parse(args[4]) });
    }
    if (sql.includes('UPDATE boss_decisions SET prev=')) {
      if (pool.failUpdate) throw Error('offline audit failure');
      const record = pool.decisions.find(d => d.batch_id === args[0]);
      if (sql.includes('jsonb_set')) record.prev.phase = 'rejected';
      else record.prev = JSON.parse(args[1]);
    }
    if (sql.includes("UPDATE tasks SET status='done'")) pool.task.status = 'done';
    if (sql.includes('INSERT INTO tasks')) {
      if (pool.tasks.has(args[0])) return { rows: [] };
      pool.tasks.set(args[0], args); return { rows: [{ id: args[0] }] };
    }
    return { rows: [] };
  };
  pool.connect = async () => ({ query: pool.query, release() { pool.released = true; } });
  return pool;
}
function network({ rows = [chat], full = chatDetail, result = { status: 'sent' }, error, patchError, echo = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    url = String(url); calls.push({ url, options });
    let body, status = 200;
    if (url.endsWith('/api/inbox/conversations')) body = rows;
    else if (url.includes('/api/inbox/conversation/')) body = full;
    else {
      const failure = options.method === 'PATCH' ? patchError : error;
      if (failure === 'timeout') throw Error('offline timeout');
      if (failure) { body = failure.body; status = failure.status; }
      else if (options.method === 'PATCH') body = { status: 'draft' };
      else body = url.endsWith('/cancel') ? { status: 'cancelled' } : result;
      if (echo) body = { ...body, token: options.headers.Authorization, nested: { message: options.headers.Authorization } };
    }
    assert.equal(options.redirect, 'error');
    return { ok: status < 400, status, async text() { return JSON.stringify(body); } };
  };
  return calls;
}
async function action(name, b = {}, pool = db(), me = { id: 35 }, direct = false) {
  const res = { status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } };
  assert.equal(await (direct ? tryMessageAction : tryBossdeskAction)({ action: 'boss_msg_' + name, b, pool, me, res }), true);
  return res;
}
async function confirmed(pool, id = 'mail:12', body = '最终正文', intent = 'send') {
  const args = intent === 'dismiss' ? { id, intent, note: body } : { id, body };
  const preview = await action('preview', args, pool);
  assert.equal(preview.code, 200);
  return { ...args, token: preview.data.token };
}
test('所有消息动作和直接调用：非老板403，不读库不签token', async () => {
  const calls = network();
  for (const direct of [true, false]) for (const name of ['detail','preview','send','dismiss','history']) {
    const pool = db();
    assert.equal((await action(name, { id: 'mail:12' }, pool, { id: 36 }, direct)).code, 403);
    assert.equal(pool.calls.length, 0);
  }
  assert.equal(calls.length, 0); assert.equal(await buildBossdesk(db(), { id: 36 }), null);
});
test('邮件映射与详情保留真实字段，不伪造原消息', async () => {
  const pool = db(), [item] = await buildMessages(pool);
  assert.equal(item.id, 'mail:12'); assert.equal(item.summary, ''); assert.equal(item.received_at, null);
  assert.match(pool.calls[0].sql, /status IN \('draft','changes'\)/);
  assert.match(pool.calls[0].sql, /30 days/);
  const r = await action('detail', { id: 'mail:12' }, pool);
  assert.equal(r.data.draft, mail.body_html); assert.equal(r.data.attachments[0].name, '单据.pdf');
  assert.equal(r.data.original, ''); assert.equal(r.data.can_send, true);
});
test('确认绑定正文/id/操作者/意图，错误签名绝不查询身份或调用发送', async () => {
  const calls = network(), pool = db(), b = await confirmed(pool);
  for (const changed of [{ ...b, body: '篡改' }, { ...b, id: 'mail:13' }, { ...b, token: b.token + 'x' }]) {
    assert.equal((await action('send', changed, pool)).code, 409);
  }
  assert.equal((await action('dismiss', { ...b, note: b.body }, pool)).code, 409);
  assert.equal(pool.calls.some(c => c.sql.includes('FROM accounts')), false); assert.equal(calls.length, 0);
});
test('确认5分钟过期和消息快照变化均拒绝', async () => {
  network(); const pool = db(), now = Date.now;
  try {
    Date.now = () => 1800000000000; const b = await confirmed(pool);
    Date.now = () => 1800000300000; assert.equal((await action('send', b, pool)).code, 409);
    Date.now = () => 1800000000001; pool.row.to_emails = ['changed@example.invalid'];
    assert.equal((await action('send', b, pool)).code, 409);
  } finally { Date.now = now; }
});
test('邮件按真实身份签JWT，经PATCH再send；不泄露token，记录实际approved状态', async () => {
  const calls = network({ result: { status: 'approved', message: '已交发信队列' }, echo: true });
  const pool = db(), b = await confirmed(pool), r = await action('send', b, pool);
  assert.equal(r.code, 200); assert.equal(r.data.status, 'approved'); assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'PATCH'); assert.deepEqual(JSON.parse(calls[0].options.body), { body_html: b.body });
  assert.deepEqual(JSON.parse(calls[1].options.body), { confirm: 'customer' });
  const token = calls[0].options.headers.Authorization.slice(7);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.deepEqual({ uid: payload.uid, username: payload.username, role: payload.role, via: payload.via },
    { uid: 91, username: 'damon', role: 'petstore', via: 'bossdesk' });
  assert.equal(payload.exp - payload.iat, 60);
  assert.equal(JSON.stringify(r.data).includes(token), false); assert.equal(JSON.stringify(pool.decisions).includes(token), false);
  assert.match(pool.decisions[0].note, /^经待我处理：/); assert.equal(pool.decisions[0].prev.phase, 'completed');
  assert.ok(pool.calls.find(c => c.sql.includes('FROM accounts')).sql.includes('is_active IS TRUE'));
});
test('正文未改不PATCH，缺失或停用发件身份503且不调用上游', async () => {
  let calls = network(); let pool = db();
  assert.equal((await action('send', await confirmed(pool, 'mail:12', mail.body_html), pool)).code, 200);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/send'));
  calls = network(); pool = db(); pool.account = null;
  const r = await action('send', await confirmed(pool), pool);
  assert.equal(r.code, 503); assert.equal(r.data.error, '发件台身份不可用'); assert.equal(calls.length, 0);
});
test('acfin 409核对失败/403 AI闸错误原文和code透传', async () => {
  for (const status of [409,403]) {
    const body = { error: status === 409 ? 'lead_review_failed' : 'ai_cannot_send', code: '原始code', details: ['原始内容'] };
    network({ error: { status, body } }); const pool = db();
    const r = await action('send', await confirmed(pool), pool);
    assert.equal(r.code, status); assert.deepEqual(r.data, { ...body, success: false });
    assert.equal(pool.decisions[0].prev.phase, 'rejected');
  }
});
test('PATCH拒绝不再send', async () => {
  const calls = network({ patchError: { status: 409, body: { error: 'Only draft/changes mail can be edited' } } });
  const pool = db(); assert.equal((await action('send', await confirmed(pool), pool)).code, 409); assert.equal(calls.length, 1);
});
test('不用回必须签名绑定理由，走cancel并保留完整原因', async () => {
  const calls = network(), pool = db();
  assert.equal((await action('dismiss', { id: 'mail:12', note: '不用回' }, pool)).code, 409);
  const b = await confirmed(pool, 'mail:12', '客户已确认', 'dismiss');
  assert.equal((await action('dismiss', { ...b, note: '篡改' }, pool)).code, 409);
  assert.equal((await action('dismiss', b, pool)).code, 200);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/cancel'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { reason: '客户已确认' });
});
test('缺确认密钥503；非法id400；不存在邮件404', async () => {
  delete process.env.JWT_SECRET;
  try { assert.equal((await action('preview', { id: 'mail:12', body: '正文' })).code, 503); }
  finally { process.env.JWT_SECRET = 'offline-test-only-not-a-real-secret'; }
  assert.equal((await action('detail', { id: "mail:12'" })).code, 400);
  assert.equal((await action('detail', { id: 'mail:12' }, db(null))).code, 404);
});
test('聊天need_owner列表和详情复用Nora解析', async () => {
  network(); const pool = db(), rows = await buildChats(pool);
  assert.equal(rows[0].id, 'chat:17'); assert.equal(rows[0].nora.ok, true);
  const r = await action('detail', { id: 'chat:17' }, pool);
  assert.equal(r.data.draft, '可以'); assert.equal(r.data.original[0].from, 'customer');
});
test('聊天未回以messages.from判定，不以unread猜测', async () => {
  network({ rows: [{ ...chat, need_owner: false, unread: 99 }], full: { messages: [{ from: 'store', at: chat.last_at }], draft: null } });
  assert.deepEqual(await buildChats(db()), []);
  network({ rows: [{ ...chat, need_owner: false, unread: 0 }], full: { ...chatDetail, draft: null } });
  assert.equal((await buildChats(db())).length, 1);
});
test('need_owner无Nora409，不发请求、不写pending', async () => {
  const calls = network(), pool = db(); pool.task = null;
  const r = await action('send', await confirmed(pool, 'chat:17', '可以'), pool);
  assert.equal(r.code, 409); assert.equal(r.data.error, 'Nora 还没看完');
  assert.equal(calls.some(c => c.options.method === 'POST'), false); assert.equal(pool.decisions.length, 0);
});
test('老板批准HMAC固定向量', () => {
  const approval = ownerApproval('17', '可以', '2026-10-04T03:00:00.000Z');
  assert.equal(approval.by, 'damon');
  assert.equal(approval.sig, 'a76a1f086800e8ec0a5b2d7d80ee6c39772e33a12e2238e090f560a5ac667b01');
});
test('缺老板批准密钥503，即便非need_owner也不放行', async () => {
  network({ rows: [{ ...chat, need_owner: false }], full: { ...chatDetail, draft: null } });
  const pool = db(); delete process.env.OWNER_APPROVAL_SECRET;
  try {
    const r = await action('send', await confirmed(pool, 'chat:17', '可以'), pool);
    assert.equal(r.code, 503); assert.equal(r.data.error, '老板批准签名未配置'); assert.equal(pool.decisions.length, 0);
  } finally { process.env.OWNER_APPROVAL_SECRET = 'test-owner-secret'; }
});
test('聊天sent/queued/blocked如实返回；仅sent/queued结单', async () => {
  for (const status of ['sent','queued','blocked']) {
    const calls = network({ result: { status, reason: '真实原因' } }), pool = db();
    const r = await action('send', await confirmed(pool, 'chat:17', '可以'), pool);
    assert.equal(r.code, 200); assert.equal(r.data.status, status); assert.equal(r.data.reason, '真实原因');
    assert.equal(pool.task.status, status === 'blocked' ? 'open' : 'done');
    const body = JSON.parse(calls.find(c => c.url.endsWith('/api/inbox/send')).options.body);
    assert.deepEqual(body.owner_approval, ownerApproval('17', '可以', body.owner_approval.at));
    assert.equal(pool.decisions[0].prev.final_reply, '可以');
  }
});
test('聊天不用回留痕且从当前消息列表消失', async () => {
  const calls = network(), pool = db();
  assert.equal((await action('dismiss', await confirmed(pool, 'chat:17', '无需回复', 'dismiss'), pool)).code, 200);
  assert.equal(calls.some(c => c.options.method === 'POST'), false);
  assert.deepEqual(await buildChats(pool), []); assert.equal(pool.decisions[0].prev.reason, '无需回复');
});
test('已完成签名不能重放；并发锁未取得不发出', async () => {
  const calls = network(), pool = db(), b = await confirmed(pool);
  assert.equal((await action('send', b, pool)).code, 200);
  assert.equal((await action('send', b, pool)).code, 409); assert.equal(calls.length, 2);
  const busy = db(); busy.locked = false;
  assert.equal((await action('send', await confirmed(busy), busy)).code, 409); assert.equal(calls.length, 2);
});
test('上游超时保留pending且拒绝重试；不谎称失败即没发送', async () => {
  const calls = network({ error: 'timeout' }), pool = db(), b = await confirmed(pool);
  assert.equal((await action('send', b, pool)).code, 504); assert.equal(pool.decisions[0].prev.phase, 'pending');
  assert.equal((await action('send', b, pool)).code, 409); assert.equal(calls.length, 2);
});
test('pending写入失败不发送；发送后留痕失败明确提示核实', async () => {
  const calls = network(), pool = db(); pool.failInsert = true;
  assert.equal((await action('send', await confirmed(pool), pool)).code, 500); assert.equal(calls.length, 0);
  const after = db(); after.failUpdate = true;
  const r = await action('send', await confirmed(after), after);
  assert.equal(r.code, 503); assert.match(r.data.error, /上游已处理/); assert.equal(after.decisions[0].prev.phase, 'pending');
});
test('chat-owner同一会话时间戳幂等，后续新消息另建；Nora字段来自真源', async () => {
  const pool = db();
  const list = async () => [chat, { ...chat, conversation_id: '18', need_owner: false }];
  const detail = async () => chatDetail;
  assert.deepEqual(await enqueueChatOwners(pool, list, detail), { created: 1 });
  assert.deepEqual(await enqueueChatOwners(pool, list, detail), { created: 0 });
  assert.deepEqual(await enqueueChatOwners(pool, async () => [{ ...chat, last_at: '2026-10-04T04:00:00Z' }], detail), { created: 1 });
  const insert = pool.calls.find(c => c.sql.includes('INSERT INTO tasks'));
  assert.equal(insert.args[2], 'chat-owner:17:2026-10-04T02:00:00Z');
  assert.equal(insert.args[3], '客人说:可以吗\nAI草稿:可以\n分类:要老板批');
  assert.match(insert.sql, /ON CONFLICT DO NOTHING/); assert.match(insert.sql, /petshop-manager/);
});
test('历史映射已发邮件/取消邮件/聊天，queued不当成sent', () => {
  const sent = mapHistory({ kind: 'mail', at: '2026-10-04T00:00:00Z', data: { ...mail, status: 'sent', sent_by: 'damon', before_edit: { body_html: '旧稿' } } });
  assert.equal(sent.final_reply, mail.body_html); assert.equal(sent.actor, 'damon'); assert.equal(sent.outcome, 'sent');
  const cancelled = mapHistory({ kind: 'mail', data: { ...mail, status: 'cancelled', ai_note: '不发：无需回复；操作人：damon' } });
  assert.equal(cancelled.outcome, 'dismissed'); assert.equal(cancelled.note, '无需回复'); assert.equal(cancelled.actor, 'damon');
  const queued = mapHistory({ kind: 'chat', id: '5', data: { task_id: 'chat:17', action: 'boss_msg_send', prev: { status: 'queued', final_reply: '全文', actor: 'damon' } } });
  assert.equal(queued.outcome, 'queued'); assert.equal(queued.final_reply, '全文');
});
test('历史ISO分页next_before、默认7天、并列时间不漏记录', async () => {
  const calls = [];
  const at = '2026-10-03T01:00:00.123456Z';
  const pool = { async query(sql, args) {
    calls.push({ sql, args });
    return { rows: sql.includes('SELECT EXISTS') ? [{ older: true }] : [1,2].map(id => ({ kind: 'mail', at, data: { ...mail, id, status: 'sent' } })) };
  }};
  const r = await messageHistory(pool, { before: '2026-10-04T00:00:00Z', limit: 1 });
  assert.equal(r.next_before, at); assert.equal(r.items.length, 2);
  assert.equal(calls[0].args[1], '2026-09-27T00:00:00.000Z'); assert.match(calls[0].sql, /WITH TIES/);
  const b = await action('history', { before: 'bad' }); assert.equal(b.code, 400);
  assert.equal((await action('history', { limit: 0 })).code, 400);
});
test('历史空7天窗口仍能向前翻，无更早数据才返回null', async () => {
  for (const older of [true,false]) {
    const pool = { query: async sql => ({ rows: sql.includes('SELECT EXISTS') ? [{ older }] : [] }) };
    const r = await messageHistory(pool, {}, Date.parse('2026-10-04T00:00:00Z'));
    assert.deepEqual(r.items, []); assert.equal(r.next_before, older ? '2026-09-27T00:00:00.000Z' : null);
  }
});
test('列表单源失败不炸整页，chat-owner继续排除待办', async () => {
  network(); const pool = db(); const query = pool.query;
  pool.query = (sql,args) => { if (sql.includes('public.mail_outbox')) throw Error('offline mail db'); return query(sql,args); };
  const out = await buildBossdesk(pool, { id: 35 });
  assert.ok(out.errors.some(e => /offline mail db/.test(e))); assert.equal(out.messages[0].id, 'chat:17');
  assert.match(pool.calls.find(c => c.sql.includes('UNION ALL')).sql, /COALESCE\(source,''\) <> 'chat-owner'/);
  const tasks = db(); await buildTaskList(tasks);
  assert.equal((tasks.calls[0].sql.match(/COALESCE\(t.source,''\) <> 'chat-owner'/g) || []).length, 2);
});
test('签发实现只复用generateToken，不手工构造JWT', () => {
  const source = readFileSync(new URL('../api/db/hr-bossdesk-msgs.mjs', import.meta.url), 'utf8');
  assert.match(source, /import\('\.\.\/auth\.js'\)/); assert.equal((source.match(/generateToken\(\{/g) || []).length, 1);
});

test('消息留痕不能通过旧任务撤回，待办已办不混入消息', async () => {
  const pool = db(), res = { status(n) { this.code = n; return this; }, json(b) { this.data = b; } };
  await tryBossdeskAction({ action: 'boss_undo', b: { batch_id: 'msg-fixture' }, res, pool, me: { id: 35 } });
  assert.equal(res.code, 409); assert.equal(pool.calls.length, 0);
  network(); await buildBossdesk(pool, { id: 35 });
  assert.match(pool.calls.find(c => c.sql.includes('FROM boss_decisions d LEFT JOIN')).sql,
    /d.action NOT IN \('boss_msg_send','boss_msg_dismiss'\)/);
});
test('聊天确认和实际发送使用同一trim正文，匹配dispatcher签名契约', async () => {
  const calls = network(), pool = db();
  const b = await confirmed(pool, 'chat:17', '  可以\n');
  assert.equal((await action('send', b, pool)).code, 200);
  const payload = JSON.parse(calls.find(c => c.url.endsWith('/api/inbox/send')).options.body);
  assert.equal(payload.text, '可以');
  assert.deepEqual(payload.owner_approval, ownerApproval('17', '可以', payload.owner_approval.at));
});
