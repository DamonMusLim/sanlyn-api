#!/usr/bin/env node
// 只由运维审核后登记 cron；导入本文件不连接数据库、不读取凭证、不发消息。
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { conversations, conversation, chatKey } from '../api/db/hr-bossdesk-msgs-chat.mjs';

export async function enqueueChatOwners(pool, list = conversations, detail = conversation) {
  let created = 0;
  for (const row of await list()) {
    if (row.need_owner !== true) continue;
    if (!row.conversation_id || !row.last_at || !Number.isFinite(Date.parse(row.last_at))) {
      throw new Error('老板会话缺少有效 conversation_id/last_at');
    }
    const full = await detail(row);
    const key = chatKey(row);
    // 确定性主键同时挡住并发、重跑以及 done 后再次建相同任务。
    const id = 'chat-owner-' + createHash('sha256').update(key).digest('hex');
    const title = `[聊天要老板批] ${row.channel || ''}·${row.customer_name || ''}:${Array.from(row.last_message || '').slice(0, 40).join('')}`;
    const next = `客人说:${row.last_message || ''}\nAI草稿:${full.draft?.text || ''}\n分类:${full.draft?.category_label || ''}`;
    const result = await pool.query(`INSERT INTO tasks
      (id,title,status,next_holder,source,dedupe_key,next_action,created_at,updated_at)
      SELECT $1,$2,'open','petshop-manager','chat-owner',$3,$4,now(),now()
      WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE source='chat-owner' AND dedupe_key=$3)
        AND NOT EXISTS (SELECT 1 FROM boss_decisions WHERE task_id=$5
          AND prev->>'chat_key'=$3 AND prev->>'phase'='completed' AND undone_at IS NULL
          AND action IN ('boss_msg_send','boss_msg_dismiss'))
      ON CONFLICT DO NOTHING RETURNING id`, [id, title, key, next, `chat:${row.conversation_id}`]);
    created += result.rows.length;
  }
  return { created };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 复用 API 已有 PG 环境配置；本脚本不自行加载任何 .env 或密钥文件。
  const { getPool } = await import('../api/db/db.js');
  const pool = getPool();
  try { console.log(JSON.stringify(await enqueueChatOwners(pool))); }
  catch { console.error('聊天建单失败，请检查服务与数据库状态'); process.exitCode = 1; }
  finally { await pool.end(); }
}
