// api/public/taskhub.js — 任务中心新UI(thread.html)后端数据源
// 5条挂载路径,同一文件按 req.path 分发:
//   GET  /api/public/taskhub/summary  → 三个计数器(需要你/在跑/待看) + 需要你三类卡片(填写/决策/提醒汇总)
//   GET  /api/public/taskhub/recent   → 最近任务(用于聊天线程结果区)
//   GET  /api/public/taskhub/skills   → pm2 进程状态 + mini 可达性(任务大厅用)
//   POST /api/public/taskhub/create   → 聊天输入框建任务(status=open, source=web)
//   POST /api/public/taskhub/answer   → 需要你卡片提交(填写值/决策选择)→ 真回写 tasks.damon_feedback + task_events
//
// 无鉴权(public,同 forwarder 系列约定),供 damon.sanlyn.cn/cockpit/thread.html 直接 fetch。
// 只读 GET 走真实 SQL;POST /create 仅插入一行 open 任务;POST /answer 仅更新单行 damon_feedback/acknowledged_at(+action=mark_done时收尾)。
//
// ── 2026-07-22 改动(fast-worker):「需要你」口径收紧 + 去重 + 三类卡 ──
// 旧口径 = status=open AND (priority=P0 OR risk_level urgent/high) → 62张,含4张一模一样的"催款提醒30笔"日报重复。
// 新口径:
//   ①「真行动项」= task_type ∈ 白名单(下面 ACTIONABLE_TYPES),这些是已知需要老板亲自填数据/拍板/勾完成的业务任务
//      → 按 title 去重(同标题只留最新一张,标 dup_count),分 fill(✍️填写)/pick(🅰决策或勾清单)两种卡
//   ②「其余P0/高危」(notification_closure 类日报/INVOICE_GAP/REBATE_GAP等系统检测器噪音)→ 不逐条列,合并成 1 张
//      "🔔 提醒汇总" 卡,只报数不占卡片位,避免62张刷屏
// 这样 62 张压到:真行动项(现网数据约15张)+ 1张汇总 ≈ 16 张。
// ✅验收类卡片本轮只留占位(见 need_cards 里没有,下一轮接:done 但要老板过目的任务)。
//
// 表里没有 waiting_for/blocked_reason 列(brief 里假设的字段名,实测 tasks 表用 task_type + raw.primary_action/steps
// + damon_feedback + acknowledged_at 代替),分类改用 task_type 白名单,回写改用 damon_feedback(已有列,专为此设计)。

import { getPool, setCors } from "../db.js";
import { execSync } from "node:child_process";

function genTaskId() {
  return "t-web-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── 真行动项白名单:这些 task_type 意味着"老板不填/不拍板,任务卡住不能往下走" ──
const ACTIONABLE_TYPES = ["交期确认", "资料补齐", "装货安排", "单证处理", "AMOUNT_DIVERGENCE", "SAMPLE_REQUEST"];
// fill = 需要老板填一个值(交期/资料);其余(pick)= 需要老板拍板或勾"已处理完清单"
const FILL_TYPES = new Set(["交期确认", "资料补齐"]);

function classifyFtype(taskType) {
  return FILL_TYPES.has(taskType) ? "fill" : "pick";
}

// ── 2026-07-22 新增:按 task_type 出专属决策按钮(不再是通用"确认处理") ──
// close:true = 这个选择本身就是拍板,提交后任务标 done;close:false = 仍需人工/暂缓,任务保持 open。
// "暂缓"永远 close:false。这里只决定按钮长什么样+回写后状态,不触发任何下游副作用(不发款/不部署)。
const TYPE_OPTIONS = {
  AMOUNT_DIVERGENCE: [
    { label: "按报关金额", action: "use_customs_amount", close: true },
    { label: "留人工复核", action: "manual_review", close: false },
    { label: "暂缓", action: "defer", close: false },
  ],
  SAMPLE_REQUEST: [
    { label: "接单打样", action: "accept_sample", close: true },
    { label: "拒绝", action: "reject_sample", close: true },
    { label: "暂缓", action: "defer", close: false },
  ],
};

// 没有专属按钮组的 pick 类:有 checklist steps → "标记完成"+"暂缓";没有 → 通用"确认处理"+"暂缓"
function defaultPickOptions(hasSteps) {
  return hasSteps
    ? [
        { label: "标记完成", action: "mark_done", close: true },
        { label: "暂缓", action: "defer", close: false },
      ]
    : [
        { label: "确认处理", action: "ack", close: false },
        { label: "暂缓", action: "defer", close: false },
      ];
}

// 真行动项查询:按 title 去重(同标题只留最新一条,dup_count 记同类张数)
const NEED_ACTION_SQL = `
  SELECT DISTINCT ON (title)
    id, title, task_type, priority, risk_level, reason, ai_suggestion, next_action, raw, created_at,
    count(*) OVER (PARTITION BY title) AS dup_count
  FROM tasks
  WHERE status = 'open' AND task_type = ANY($1::text[])
  ORDER BY title, created_at DESC
`;

// 其余 P0/高危(未进白名单的,多为系统检测器日报,如催款提醒/海运补料/INVOICE_GAP/REBATE_GAP)→ 只统计数量做汇总卡
const NEED_ROLLUP_SQL = `
  SELECT count(*)::int AS n
    FROM tasks
   WHERE status = 'open'
     AND NOT (task_type = ANY($1::text[]))
     AND (lower(priority) = 'p0' OR risk_level IN ('urgent', 'high'))
`;

function buildActionCard(r) {
  const ftype = classifyFtype(r.task_type);
  const raw = r.raw || {};
  const steps = Array.isArray(raw.steps) ? raw.steps.filter((s) => s && typeof s === "object" && s.text) : [];
  const primaryLabel = (raw.primary_action && raw.primary_action.label) || (ftype === "fill" ? "提交" : "确认处理");
  const primaryAction = (raw.primary_action && raw.primary_action.action) || (ftype === "fill" ? "fill_value" : "ack");
  // pick 类的按钮组:task_type 命中专属白名单用专属选项,否则按有无 checklist 出默认组
  const options = ftype === "pick" ? (TYPE_OPTIONS[r.task_type] || defaultPickOptions(steps.length > 0)) : null;
  return {
    id: r.id,
    title: r.title,
    ftype,
    task_type: r.task_type,
    meta: [r.task_type, r.priority, r.risk_level].filter(Boolean).join(" · "),
    reason: r.reason || r.ai_suggestion || "",
    dup_count: r.dup_count || 1,
    steps: steps.map((s) => s.text),
    primary_label: primaryLabel,
    primary_action: primaryAction,
    options: options ? options.map((o) => ({ label: o.label, action: o.action })) : null,
  };
}

async function handleSummary(req, res, pool) {
  const needRows = await pool.query(NEED_ACTION_SQL, [ACTIONABLE_TYPES]);
  const rollupR = await pool.query(NEED_ROLLUP_SQL, [ACTIONABLE_TYPES]);
  const rollupN = rollupR.rows[0].n;

  const runningR = await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE status='doing'`);
  const doneTodayR = await pool.query(
    `SELECT count(*)::int AS n FROM tasks WHERE status='done' AND updated_at > now() - interval '24 hours'`
  );
  const openTotalR = await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE status='open'`);

  const cards = needRows.rows.map(buildActionCard);
  if (rollupN > 0) {
    cards.push({
      id: "rollup-alerts",
      title: `🔔 ${rollupN} 条系统提醒(催款/海运补料/开票缺口等日报,已合并不逐条列)`,
      ftype: "alert",
      meta: "汇总 · 非逐条行动项",
      reason: "系统检测器每日生成的P0/高危提醒,内容多为同类重复(如催款日报按天各生成一条)。要看明细去任务大厅或对账台,这里不占卡片位。",
      dup_count: rollupN,
      steps: [],
      primary_label: "",
      primary_action: "",
    });
  }

  return res.status(200).json({
    success: true,
    counts: {
      need: cards.length,
      running: runningR.rows[0].n,
      done_today: doneTodayR.rows[0].n,
      open_total: openTotalR.rows[0].n,
    },
    need_cards: cards,
    data_source: "tencent sanlyn_db.tasks (real) · 口径2026-07-22收紧见文件头注释",
  });
}

async function handleRecent(req, res, pool) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 30);
  const r = await pool.query(
    `SELECT id, title, status, domain, source, ai_suggestion, created_at
       FROM tasks
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.status(200).json({
    success: true,
    tasks: r.rows,
    data_source: "tencent sanlyn_db.tasks (real)",
  });
}

async function handleCreate(req, res, pool) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });
  const b = req.body || {};
  const title = (b.title || "").toString().trim().slice(0, 200);
  if (!title) return res.status(400).json({ success: false, error: "title required" });

  const id = genTaskId();
  await pool.query(
    `INSERT INTO tasks (id, title, status, source, domain, priority, mode, reason, raw)
     VALUES ($1, $2, 'open', 'web', $3, 'p1', 'owned', $4, $5::jsonb)`,
    [
      id,
      title,
      b.domain || "general",
      "聊天线程建的任务,待分诊",
      JSON.stringify({ from: "thread.html", raw_text: title }),
    ]
  );
  await pool.query(
    `INSERT INTO task_events (task_id, event_type, actor_type, actor_id, to_status, note)
     VALUES ($1, 'created', 'web_user', 'damon_via_thread', 'open', $2)`,
    [id, "从任务中心新UI聊天输入框创建"]
  );
  return res.status(200).json({ success: true, task_id: id, title });
}

// ── 需要你卡片提交:填写值 或 决策选择 → 真写回 tasks.damon_feedback(+acknowledged_at),留痕 task_events ──
// 不触发任何下游副作用(不发款/不部署/不自动推进业务流程);action=mark_done 时才把这一条本身标 done(老板明确点了"标记完成")
async function handleAnswer(req, res, pool) {
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });
  const b = req.body || {};
  const taskId = (b.task_id || "").toString().trim();
  const ftype = (b.ftype || "").toString().trim();
  const value = (b.value || "").toString().trim().slice(0, 2000);
  const action = (b.action || "").toString().trim().slice(0, 64);
  const label = (b.label || "").toString().trim().slice(0, 100);

  if (!taskId) return res.status(400).json({ success: false, error: "task_id required" });
  // 只有 fill 类(填一个值)才强制要求 value;pick 类(决策/清单按钮,含专属选项)靠 action 本身表达选择,不需要 value
  if (ftype === "fill" && !value) {
    return res.status(400).json({ success: false, error: "value required for ftype=fill" });
  }
  if (ftype !== "fill" && !action) {
    return res.status(400).json({ success: false, error: "action required for ftype=pick" });
  }

  const cur = await pool.query(`SELECT id, status, damon_feedback, task_type FROM tasks WHERE id = $1`, [taskId]);
  if (cur.rows.length === 0) return res.status(404).json({ success: false, error: "task not found" });
  const before = cur.rows[0];

  const noteLine =
    ftype === "fill"
      ? `[${new Date().toISOString()}] Damon填写: ${value}`
      : `[${new Date().toISOString()}] Damon选择: ${label || action}${value ? " · " + value : ""}`;
  const mergedFeedback = before.damon_feedback ? before.damon_feedback + "\n" + noteLine : noteLine;
  // close 判定不信前端:按该任务真实 task_type 查专属选项表,查不到落回默认规则(mark_done关/其余不关)
  const typeOpts = TYPE_OPTIONS[before.task_type];
  const matchedOpt = typeOpts ? typeOpts.find((o) => o.action === action) : null;
  const willClose = matchedOpt ? matchedOpt.close : action === "mark_done";
  const newStatus = willClose ? "done" : before.status;

  const upd = await pool.query(
    `UPDATE tasks
        SET damon_feedback = $2,
            acknowledged_at = now(),
            status = $3,
            closed_at = CASE WHEN $4 THEN now() ELSE closed_at END
      WHERE id = $1
      RETURNING id, status`,
    [taskId, mergedFeedback, newStatus, willClose]
  );

  await pool.query(
    `INSERT INTO task_events (task_id, event_type, actor_type, actor_id, from_status, to_status, note, metadata)
     VALUES ($1, 'damon_answer', 'human', 'damon', $2, $3, $4, $5::jsonb)`,
    [taskId, before.status, upd.rows[0].status, noteLine, JSON.stringify({ ftype, action, label, value, via: "thread.html" })]
  );

  return res.status(200).json({ success: true, task_id: taskId, status: upd.rows[0].status, note: noteLine });
}

// ── 任务大厅:能拿到真实状态的只有 tencent 本机 pm2 + mini 可达性;其余标占位 ──
const KNOWN_ALERTS_PLACEHOLDER = [
  { group: "🐾 宠物店", name: "美团采集", role: "每晚抓营业额/销量/评分", status: "warn", note: "占位·待接:登录态是否掉线需人工核对(历史已知会掉)" },
  { group: "🐾 宠物店", name: "饿了么采集", role: "每日订单/营业额", status: "warn", note: "占位·待接:同上" },
  { group: "🚢 海运", name: "Maya · 账单录入", role: "货代账单解析核对入库", status: "idle", note: "占位·待接:无实时任务队列可查" },
  { group: "🚢 海运", name: "Lena · 对账比价", role: "费用比价+差额审", role_note: "", status: "idle", note: "占位·待接" },
  { group: "🚢 海运", name: "Zoe · 订单流", role: "交货期/协同监听", status: "idle", note: "占位·待接" },
];

// ── 2026-07-22 检测器真实状态:按 tasks 表里该 task_type 今天有没有新记录 + cron 计划时间判定(SQL 全在 tencent 本地算,真实) ──
const DETECTOR_TYPES = [
  { name: "开票缺口 · invoice_gap", role: "cron 每天08:30 扫3类缺口 (invoice_gap_scan.mjs)", task_type: "INVOICE_GAP", scheduled: "08:30" },
  { name: "退税缺料 · rebate_gaps", role: "cron 每天08:15 扫 (rebate_gaps.mjs)", task_type: "REBATE_GAP", scheduled: "08:15" },
];

function fmtBeijing(d) {
  if (!d) return "无记录";
  try {
    return new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return String(d);
  }
}

async function computeDetectorStatus(pool) {
  const out = [];
  for (const d of DETECTOR_TYPES) {
    const r = await pool.query(
      `SELECT max(created_at) AS latest,
              (max(created_at)::date = now()::date) AS ran_today,
              (now()::time >= $2::time) AS past_scheduled
         FROM tasks WHERE task_type = $1`,
      [d.task_type, d.scheduled]
    );
    const row = r.rows[0] || {};
    let status, note;
    if (row.ran_today) {
      status = "idle";
      note = `今日已跑 · 最近一条 ${fmtBeijing(row.latest)}`;
    } else if (!row.past_scheduled) {
      status = "idle";
      note = `今日尚未到点(计划 ${d.scheduled})`;
    } else {
      status = "warn";
      note = `⚠️今日已过点(计划 ${d.scheduled})但未见新任务 · 最近一条 ${fmtBeijing(row.latest)}`;
    }
    out.push({ name: d.name, role: d.role, status, note });
  }
  return out;
}

// mini 可达性:真 tailscale ping(tencent→mini-damon),不走需要鉴权的本地代理接口
// 注意:tailscale ping 只在建立"直连"时 exit code=0,走 DERP 中继成功 pong 时 exit code=1 但仍是真可达——
// 所以不能用 execSync 是否抛异常判断,必须解析 stdout 里的 "pong from" 文本(无论 exit code)。
function checkMiniReachable() {
  let out = "";
  try {
    out = execSync("tailscale ping -c 1 mini-damon", { timeout: 5000 }).toString();
  } catch (e) {
    // exit code != 0(常见于 DERP 中继成功但未直连),stdout 仍在 e.stdout 里,不能直接判失败
    out = (e && e.stdout ? e.stdout.toString() : "") || "";
    if (!out) return { reachable: false, error: String((e && e.message) || e) };
  }
  const m = out.match(/pong from mini-damon .*?in (\d+)ms/);
  if (m) return { reachable: true, latency_ms: parseInt(m[1], 10), via: /DERP/.test(out) ? "derp_relay" : "direct" };
  return { reachable: false, raw: out.trim().slice(0, 200) };
}

async function handleSkills(req, res, pool) {
  let pm2List = [];
  try {
    const out = execSync("pm2 jlist", { timeout: 8000 }).toString();
    pm2List = JSON.parse(out);
  } catch (e) {
    pm2List = [];
  }
  const pm2Status = (name) => {
    const p = pm2List.find((x) => x.name === name);
    if (!p) return { found: false };
    return { found: true, status: p.pm2_env && p.pm2_env.status, restarts: p.pm2_env && p.pm2_env.restart_time };
  };

  const runner = pm2Status("sanlyn-auto-runner");
  const api = pm2Status("sanlyn-api");
  const cockpitWeb = pm2Status("sanlyn-cockpit-web");

  const detectors = await computeDetectorStatus(pool);
  const miniReachable = checkMiniReachable();

  return res.status(200).json({
    success: true,
    executor: {
      name: "sanlyn-auto-runner (MiniMax)",
      role: "文字/决策类任务自动执行 + 回写",
      status: runner.found ? runner.status : "unknown",
      pm2_restarts: runner.found ? runner.restarts : null,
    },
    tencent_local: {
      "sanlyn-api": api.found ? api.status : "unknown",
      "sanlyn-cockpit-web": cockpitWeb.found ? cockpitWeb.status : "unknown",
    },
    mini_reachability: miniReachable,
    known_alerts_placeholder: KNOWN_ALERTS_PLACEHOLDER,
    detectors_placeholder: detectors,
    offline_placeholder: [
      {
        group: "🔴 mini 侧",
        name: "forge / codex",
        role: "代码类写+审",
        note: miniReachable.reachable
          ? `mini 可达(tailscale ping ${miniReachable.latency_ms}ms),但 forge 进程实时状态占位·待接`
          : "占位·待接:mini 不可达(tailscale ping 无回应)",
      },
      {
        group: "🔴 mini 侧",
        name: "Lyn · 语音路由",
        role: "语音派单",
        note: miniReachable.reachable ? "mini 可达,语音路由实时状态占位·待接" : "占位·待接:mini 不可达",
      },
    ],
    data_source:
      "pm2 jlist(真) + tasks表按task_type今日created_at判定(真,SQL算) + tailscale ping mini-damon(真) + 宠物店/海运业务skills清单(占位,tencent查不到Studio/mini本地文件时间戳)",
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const p = req.path || "";

  try {
    if (p.endsWith("/summary")) return await handleSummary(req, res, pool);
    if (p.endsWith("/recent")) return await handleRecent(req, res, pool);
    if (p.endsWith("/create")) return await handleCreate(req, res, pool);
    if (p.endsWith("/answer")) return await handleAnswer(req, res, pool);
    if (p.endsWith("/skills")) return await handleSkills(req, res, pool);
    return res.status(404).json({ success: false, error: "unknown taskhub route" });
  } catch (err) {
    console.error("[taskhub]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
