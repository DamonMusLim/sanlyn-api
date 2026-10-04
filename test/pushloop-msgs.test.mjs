import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBossdesk, tryBossdeskAction } from '/home/damon/wt-pushloop-1004/api/db/hr-bossdesk.mjs';
import { buildMessages } from '/home/damon/wt-pushloop-1004/api/db/hr-bossdesk-msgs.mjs';
import { buildTaskList } from '/home/damon/wt-pushloop-1004/api/db/hr-bossdesk-tasks.mjs';
process.env.JWT_SECRET = 'offline-test-only-not-a-real-secret';
process.env.BOSS_EMPLOYEE_IDS = '35';
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('offline dispatcher'); };
const mail = { id: '12', sender_key: 'petbaby', to_emails: ['customer@example.invalid'],
  cc_emails: [], subject: '测试邮件', body_html: '<p>草稿</p>', attachments: [{ name: '单据.pdf' }],
  status: 'draft', prepared_at: '2026-10-04T00:00:00Z', ai_note: '无规则命中，自由起草' };
function db(row = mail) {
  const calls = [];
  return { calls, async query(sql, args) {
    calls.push({ sql, args });
    assert.match(sql.trim(), /^SELECT/i, '邮件功能不得写库');
    if (sql.includes('public.mail_outbox')) return { rows: row ? [{ ...row }] : [] };
    return { rows: [] };
  }};
}
async function action(action, b = {}, pool = db(), me = { id: 35 }) {
  const res = { status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } };
  assert.equal(await tryBossdeskAction({ action, b, pool, me, res }), true);
  return res;
}
test('所有消息动作：非老板403，且不访问数据库', async () => {
  for (const name of ['detail', 'preview', 'send', 'dismiss']) {
    const pool = db();
    const r = await action('boss_msg_' + name, { id: 'mail:12' }, pool, { id: 36 });
    assert.equal(r.code, 403); assert.equal(pool.calls.length, 0);
  }
  assert.equal(await buildBossdesk(db(), { id: 36 }), null);
});
test('邮件映射使用真实字段，30天和draft/changes限制在SQL中', async () => {
  const pool = db();
  const [row] = await buildMessages(pool);
  assert.equal(row.id, 'mail:12'); assert.equal(row.channel, 'email');
  assert.equal(row.counterparty, 'customer@example.invalid');
  assert.equal(row.summary, ''); assert.equal(row.received_at, null);
  assert.equal(row.has_draft, true); assert.equal(row.nora, null);
  assert.match(pool.calls[0].sql, /status IN \('draft','changes'\)/);
  assert.match(pool.calls[0].sql, /prepared_at >= now\(\)-interval '30 days'/);
});
test('详情保留HTML草稿、附件名、发件人和收件人，不伪造原文', async () => {
  const r = await action('boss_msg_detail', { id: 'mail:12' });
  assert.equal(r.code, 200); assert.equal(r.data.draft, mail.body_html);
  assert.equal(r.data.sender_key, 'petbaby'); assert.equal(r.data.attachments[0].name, '单据.pdf');
  assert.deepEqual(r.data.to_emails, mail.to_emails); assert.equal(r.data.original, '');
  assert.equal(r.data.can_send, false);
});
test('签名绑定正文/id/操作者，篡改返回409', async () => {
  const p = await action('boss_msg_preview', { id: 'mail:12', body: '确认正文' });
  assert.equal(p.code, 200); assert.equal(p.data.expires_in, 300);
  for (const b of [
    { id: 'mail:12', body: '改了正文', token: p.data.token },
    { id: 'mail:13', body: '确认正文', token: p.data.token },
    { id: 'mail:12', body: '确认正文', token: p.data.token + 'x' },
  ]) assert.equal((await action('boss_msg_send', b)).code, 409);
});
test('签名满5分钟过期', async () => {
  const now = Date.now;
  try {
    Date.now = () => 1800000000000;
    const p = await action('boss_msg_preview', { id: 'mail:12', body: '正文' });
    Date.now = () => 1800000300000;
    assert.equal((await action('boss_msg_send', { id: 'mail:12', body: '正文', token: p.data.token })).code, 409);
  } finally { Date.now = now; }
});
test('邮件收件人变化使已有确认失效', async () => {
  const p = await action('boss_msg_preview', { id: 'mail:12', body: '正文' });
  const r = await action('boss_msg_send', { id: 'mail:12', body: '正文', token: p.data.token },
    db({ ...mail, to_emails: ['changed@example.invalid'] }));
  assert.equal(r.code, 409);
});
test('发送和不用回缺真人会话时503，不写库、不假留痕、不调用fetch', async () => {
  const pool = db();
  const p = await action('boss_msg_preview', { id: 'mail:12', body: '正文' }, pool);
  const send = await action('boss_msg_send', { id: 'mail:12', body: '正文', token: p.data.token }, pool);
  const dismiss = await action('boss_msg_dismiss', { id: 'mail:12', note: '无需回复' }, pool);
  assert.equal(send.code, 503); assert.equal(dismiss.code, 503);
  assert.match(send.data.error, /真人登录/); assert.equal(networkCalls, 0);
});
test('无签名密钥fail-closed', async () => {
  delete process.env.JWT_SECRET;
  try { assert.equal((await action('boss_msg_preview', { id: 'mail:12', body: '正文' })).code, 503); }
  finally { process.env.JWT_SECRET = 'offline-test-only-not-a-real-secret'; }
});
test('未知/已处理邮件404；非法id400', async () => {
  assert.equal((await action('boss_msg_detail', { id: 'mail:12' }, db(null))).code, 404);
  assert.equal((await action('boss_msg_detail', { id: "mail:12'" })).code, 400);
});
test('邮件库失败不炸整页，messages为空且errors有原因；聊天缺口显式报告', async () => {
  const pool = db(); const query = pool.query.bind(pool);
  pool.query = async (sql, args) => {
    if (sql.includes('public.mail_outbox')) throw new Error('offline mail db');
    return query(sql, args);
  };
  const out = await buildBossdesk(pool, { id: 35 });
  assert.deepEqual(out.messages, []);
  assert.ok(out.errors.some(e => /offline mail db/.test(e)));
  assert.ok(out.errors.some(e => /聊天未接入/.test(e)));
});
test('chat-owner在boss分组、DECIDE及REVIEW查询中排除（SQL静态契约）', async () => {
  const pool = db(); await buildBossdesk(pool, { id: 35 });
  assert.match(pool.calls.find(c => c.sql.includes('UNION ALL')).sql, /COALESCE\(source,''\) <> 'chat-owner'/);
  const tasks = db(); await buildTaskList(tasks);
  assert.equal((tasks.calls[0].sql.match(/COALESCE\(t.source,''\) <> 'chat-owner'/g) || []).length, 2);
});
test('聊天接口不满足契约时503，不猜字段或调用发送', async () => {
  assert.equal((await action('boss_msg_detail', { id: 'chat:17' })).code, 503);
  assert.equal(networkCalls, 0);
});
