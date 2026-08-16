// /opt/sanlyn-taskrunner/auto-runner.mjs
// B1 最小闭环:tasks(auto_run=true, status='open') → MiniMax 执行 → 回写 → task_events 审计。
//
// 只捡显式 opt-in 的任务(auto_run=true),绝不碰退税/业务真任务(那些没有这个标记)。
// 不部署、不改老系统;这是全新独立文件,pm2 单独跑一个进程。
//
// 状态机(受 tasks_status_check 约束,只有 open/doing/done/cancelled 四态,没有 review/error):
//   open        → runner 捞到,置为 doing (占用锁,防止并发/重复跑)
//   doing→done  → MiniMax 正常返回,结果写 ai_suggestion,status=done
//   doing→doing → MiniMax 返回但内容判定"建议人看"(见 NEEDS_REVIEW_MARK),
//                 停在 doing,ai_suggestion 里前缀标注,auto_run 置 false 防止重复重跑
//   doing→doing → 出错(网络/超时/JSON解析失败),停在 doing,ai_suggestion 记录错误原因,
//                 auto_run 置 false 防止死循环重试同一个坏任务
//
// 环境变量(复用 /opt/sanlyn-api-test/.env 里已验证能用的凭据,不新建密钥):
//   PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD
//   MINIMAX_API_KEY
//   MINIMAX_BASE_URL  (可选,默认 https://api.minimax.chat/v1/text/chatcompletion_v2)
//   MINIMAX_MODEL     (可选,默认 abab6.5s-chat)
//   RUNNER_POLL_MS    (可选,默认 15000)
//   RUNNER_BATCH_SIZE (可选,默认 5,每轮最多处理几条,防止一次刷爆 MiniMax 配额)

import pkg from "pg";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Reuse the already-proven-working credentials from sanlyn-api-test's .env
// instead of duplicating secrets into this new directory. Override with
// AUTO_RUNNER_ENV_PATH if the deploy location differs.
dotenv.config({ path: process.env.AUTO_RUNNER_ENV_PATH || "/opt/sanlyn-api-test/.env" });

const { Pool } = pkg;

const PG_HOST     = process.env.PG_HOST || "127.0.0.1";
const PG_PORT     = parseInt(process.env.PG_PORT || "5432");
const PG_DATABASE = process.env.PG_DATABASE || "sanlyn_db";
const PG_USER     = process.env.PG_USER;
const PG_PASSWORD = process.env.PG_PASSWORD;

const MM_KEY   = process.env.MINIMAX_API_KEY || "";
const MM_URL   = process.env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1/text/chatcompletion_v2";
const MM_MODEL = process.env.MINIMAX_MODEL || "abab6.5s-chat";

const POLL_MS    = parseInt(process.env.RUNNER_POLL_MS || "15000");
const BATCH_SIZE = parseInt(process.env.RUNNER_BATCH_SIZE || "5");

// MiniMax 回复里出现这些词 → 判定"该人看",不自动 done,留在 doing 给人工确认。
const NEEDS_REVIEW_MARKERS = ["不确定", "无法确定", "需要人工", "需要更多信息", "无法回答"];

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: PG_HOST, port: PG_PORT, database: PG_DATABASE,
      user: PG_USER, password: PG_PASSWORD,
      ssl: false, max: 3,
    });
  }
  return pool;
}

// ── 按字节截断(SQL_ASCII 库,中文按字节存,varchar 上限按字节算)──
function fitBytes(str, maxBytes) {
  if (!str) return str;
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  return buf.slice(0, maxBytes).toString("utf8", 0, maxBytes).replace(/�+$/, "");
}

// ── 组 prompt:title + context(reason/next_action)──
function buildPrompt(task) {
  const parts = [];
  parts.push(`任务标题: ${task.title || "(无标题)"}`);
  if (task.reason) parts.push(`背景/原因: ${task.reason}`);
  if (task.next_action) parts.push(`下一步动作要求: ${task.next_action}`);
  if (task.domain) parts.push(`领域: ${task.domain}`);
  parts.push("");
  parts.push("请针对以上任务给出简洁的处理建议或结果,3条以内要点。如果信息不足以给出确定结论,明确说'不确定'并说明缺什么。");
  return parts.join("\n");
}

// ── 调用 MiniMax ──────────────────────────────────────────
async function callMiniMax(prompt) {
  if (!MM_KEY) throw new Error("MINIMAX_API_KEY not set");
  const payload = {
    model: MM_MODEL,
    messages: [{ role: "user", content: prompt.slice(0, 4000) }],
    max_tokens: 800,
    temperature: 0.3,
  };
  const r = await fetch(MM_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${MM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (j?.base_resp?.status_code && j.base_resp.status_code !== 0) {
    throw new Error(`minimax_error: ${j.base_resp.status_msg || j.base_resp.status_code}`);
  }
  const reply = j?.choices?.[0]?.message?.content || "";
  if (!reply) throw new Error("minimax_empty_reply");
  return { reply, model: j?.model || MM_MODEL, usage: j?.usage || {} };
}

function needsReview(replyText) {
  return NEEDS_REVIEW_MARKERS.some((m) => replyText.includes(m));
}

// ── 捞一批待跑任务,先占坑(open→doing)防止多进程/多轮重复处理 ──
async function claimBatch(db) {
  const { rows } = await db.query(
    `UPDATE tasks SET status = 'doing', updated_at = now()
     WHERE id IN (
       SELECT id FROM tasks
       WHERE auto_run = true AND status = 'open'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, title, reason, next_action, domain`,
    [BATCH_SIZE]
  );
  return rows;
}

async function logEvent(db, taskId, eventType, fromStatus, toStatus, note) {
  await db.query(
    `INSERT INTO task_events (task_id, event_type, actor_type, actor_id, from_status, to_status, note, metadata)
     VALUES ($1, $2, 'ai', 'minimax-auto-runner', $3, $4, $5, $6)`,
    [taskId, eventType, fromStatus, toStatus, fitBytes(note || "", 2000), JSON.stringify({ model: MM_MODEL })]
  );
}

async function processTask(db, task) {
  const prompt = buildPrompt(task);
  try {
    const { reply, model, usage } = await callMiniMax(prompt);
    const reviewFlag = needsReview(reply);
    const suggestion = fitBytes(reply, 60000); // text 列理论无限但留个安全上限

    if (reviewFlag) {
      // 停在 doing,标记需要人看,auto_run 关掉防止无限重跑同一条
      await db.query(
        `UPDATE tasks SET ai_suggestion = $1, auto_run = false, updated_at = now()
         WHERE id = $2`,
        [fitBytes(`[需人工确认] ${suggestion}`, 60000), task.id]
      );
      await logEvent(db, task.id, "auto_run_needs_review", "doing", "doing", `MiniMax(${model}) 回复含不确定标记,停留待人工确认`);
      console.log(`[${task.id}] needs_review`);
      return;
    }

    await db.query(
      `UPDATE tasks SET ai_suggestion = $1, status = 'done', closed_at = now(), updated_at = now()
       WHERE id = $2`,
      [suggestion, task.id]
    );
    await logEvent(db, task.id, "auto_run_done", "doing", "done",
      `MiniMax(${model}) 自动完成,tokens_in=${usage.prompt_tokens || usage.total_tokens || 0} tokens_out=${usage.completion_tokens || 0}`);
    console.log(`[${task.id}] done`);
  } catch (e) {
    const errMsg = String(e && e.message || e);
    await db.query(
      `UPDATE tasks SET ai_suggestion = $1, auto_run = false, updated_at = now()
       WHERE id = $2`,
      [fitBytes(`[自动执行出错] ${errMsg}`, 60000), task.id]
    );
    await logEvent(db, task.id, "auto_run_error", "doing", "doing", `出错: ${errMsg}`);
    console.log(`[${task.id}] error: ${errMsg}`);
  }
}

async function tick() {
  const db = getPool();
  let claimed;
  try {
    claimed = await claimBatch(db);
  } catch (e) {
    console.error("[claimBatch failed]", e.message);
    return;
  }
  if (claimed.length === 0) return;
  console.log(`[tick] claimed ${claimed.length} task(s)`);
  for (const task of claimed) {
    await processTask(db, task);
  }
}

async function main() {
  if (!PG_USER || !PG_PASSWORD) {
    console.error("FATAL: PG_USER/PG_PASSWORD not set. Exiting.");
    process.exit(1);
  }
  if (!MM_KEY) {
    console.error("FATAL: MINIMAX_API_KEY not set. Exiting.");
    process.exit(1);
  }
  console.log(`[auto-runner] starting. poll=${POLL_MS}ms batch=${BATCH_SIZE} model=${MM_MODEL}`);
  // 首次立即跑一轮,之后按间隔轮询
  await tick().catch((e) => console.error("[tick error]", e));
  setInterval(() => {
    tick().catch((e) => console.error("[tick error]", e));
  }, POLL_MS);
}

main();
