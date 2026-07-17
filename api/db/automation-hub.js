// api/db/automation-hub.js — 自动化观测台聚合端点。
// GET  /api/db/automation-hub  → 一屏所需全部数据(自动任务/邮件/通知项目/任务积压/告警)。内部(requireAuth)。
// POST /api/db/automation-hub  → 心跳上报(任一自动任务跑完 POST 自己的状态)。x-cron-secret 保护,无需登录。
//   body: { job_key, name, machine, schedule, category, status(ok|warn|crit|idle), metric{}, message, last_run }
// 设计:任何新自动化只要 POST 心跳就自动出现在看板——"以后加自动化直接往里挂"。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const CRON_SECRET = process.env.CRON_SECRET || "a931e0008d84d0e1a6f69129457dbe54";
const EDIT_ROLES = new Set(["admin", "finance"]);
// 只允许改这些列(白名单,防注入任意列)
const PROJECT_EDITABLE = new Set(["name", "description", "is_active", "tpl_key", "sender_key", "recipient_config"]);

// 已知自动任务清单(还没接心跳的先按计划展示,不伪造健康,状态=pending_heartbeat)
const KNOWN_JOBS = [
  { job_key: "meituan_scrape",   name: "美团抓取",        machine: "Studio", schedule: "每晚 21:30", category: "抓取" },
  { job_key: "eleme_scrape",     name: "饿了么抓取",      machine: "Studio", schedule: "每晚 21:30", category: "抓取" },
  { job_key: "rebate_gaps",      name: "退税缺口扫描",     machine: "腾讯",   schedule: "每日 08:15", category: "扫描" },
  { job_key: "amount_divergence",name: "差额审核扫描",     machine: "腾讯",   schedule: "每日 08:25", category: "扫描" },
  { job_key: "invoice_gap",      name: "开票缺口扫描",     machine: "腾讯",   schedule: "每日 08:30", category: "扫描" },
  { job_key: "invoice_confirm",  name: "开票确认扫描",     machine: "腾讯",   schedule: "每 30 分", category: "扫描" },
  { job_key: "scan_anomalies",   name: "经营异常扫描",     machine: "腾讯",   schedule: "每日 10:10", category: "扫描" },
  { job_key: "scan_odoo_pos",    name: "Odoo POS 同步",   machine: "腾讯",   schedule: "每日 10:20", category: "同步" },
  { job_key: "sync_mini_odoo",   name: "mini→Odoo 同步",  machine: "腾讯",   schedule: "每日 02:30", category: "同步" },
  { job_key: "push_digest",      name: "每日汇总推送",     machine: "mini",   schedule: "每日 08:10", category: "推送" },
];

// 检测器 task_type → 用 tasks 表的 open 数 + 最近 updated_at 直接算"活着没"(不用等心跳)
const DETECTOR_MAP = {
  invoice_gap: "INVOICE_GAP", rebate_gaps: "REBATE_GAP", amount_divergence: "AMOUNT_DIVERGENCE",
};

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_heartbeats(
    job_key text PRIMARY KEY,
    name text, machine text, schedule text, category text,
    status text, metric jsonb, message text,
    last_run timestamptz, updated_at timestamptz DEFAULT now()
  )`);
}

function daysSince(ts) { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000) : null; }

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    await ensureTable(pool);

    if (req.method === "POST") {
      const b = req.body || {};
      // ---- 心跳上报(自动任务自报状态):cron-secret,无 action ----
      if (b.job_key && !b.action) {
        if ((req.headers["x-cron-secret"] || "") !== CRON_SECRET) return res.status(403).json({ error: "forbidden" });
        await pool.query(
          `INSERT INTO automation_heartbeats(job_key,name,machine,schedule,category,status,metric,message,last_run,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,now()),now())
           ON CONFLICT(job_key) DO UPDATE SET name=EXCLUDED.name,machine=EXCLUDED.machine,schedule=EXCLUDED.schedule,
             category=EXCLUDED.category,status=EXCLUDED.status,metric=EXCLUDED.metric,message=EXCLUDED.message,
             last_run=EXCLUDED.last_run,updated_at=now()`,
          [b.job_key, b.name || b.job_key, b.machine || "", b.schedule || "", b.category || "",
           b.status || "ok", b.metric ? JSON.stringify(b.metric) : null, b.message || "", b.last_run || null]
        );
        return res.status(200).json({ ok: true });
      }
      // ---- 编辑动作(管理台):JWT 已由全局中间件校验,这里查角色 ----
      if (!req.user || !EDIT_ROLES.has(req.user.role)) return res.status(403).json({ error: "Forbidden", message: "需要 admin/finance 权限" });
      if (b.action === "update_project") {
        const key = b.project_key;
        const patch = b.patch || {};
        if (!key) return res.status(400).json({ error: "project_key required" });
        const cols = Object.keys(patch).filter((c) => PROJECT_EDITABLE.has(c));
        if (!cols.length) return res.status(400).json({ error: "no editable field" });
        const sets = cols.map((c, i) => `${c}=$${i + 2}`);
        const vals = cols.map((c) => (c === "recipient_config" ? JSON.stringify(patch[c]) : patch[c]));
        const r = await pool.query(
          `UPDATE notification_projects SET ${sets.join(",")}, updated_by=$${cols.length + 2}, updated_at=now()
             WHERE project_key=$1 RETURNING project_key`,
          [key, ...vals, req.user.username || req.user.account || "admin"]
        );
        if (!r.rows.length) return res.status(404).json({ error: "project not found" });
        return res.status(200).json({ ok: true, project_key: r.rows[0].project_key });
      }
      return res.status(400).json({ error: "unknown action" });
    }

    if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
    if (!requireAuth(req, res)) return; // 内部数据,须登录

    // ---- 聚合 ----
    const hbRows = (await pool.query(`SELECT * FROM automation_heartbeats`)).rows;
    const hb = Object.fromEntries(hbRows.map((r) => [r.job_key, r]));

    const detRows = (await pool.query(
      `SELECT task_type, count(*) FILTER (WHERE status='open')::int AS open_cnt, max(updated_at) AS last_seen
         FROM tasks WHERE task_type = ANY($1::text[]) GROUP BY task_type`,
      [Object.values(DETECTOR_MAP)]
    )).rows;
    const detBy = Object.fromEntries(detRows.map((r) => [r.task_type, r]));

    // 合并成统一 jobs 列表:心跳优先 → 检测器 DB 推断 → 仅计划(待接心跳)
    const jobs = KNOWN_JOBS.map((k) => {
      const h = hb[k.job_key];
      if (h) return { ...k, status: h.status, message: h.message, metric: h.metric, last_run: h.last_run, source: "heartbeat" };
      const dt = DETECTOR_MAP[k.job_key] && detBy[DETECTOR_MAP[k.job_key]];
      if (dt) {
        const d = daysSince(dt.last_seen);
        return { ...k, status: d !== null && d <= 1 ? "ok" : "warn", message: `${dt.open_cnt} 条待办`,
                 metric: { open: dt.open_cnt }, last_run: dt.last_seen, source: "db" };
      }
      return { ...k, status: "pending_heartbeat", message: "状态待接心跳", last_run: null, source: "none" };
    });
    // 心跳里有、但不在 KNOWN_JOBS 的(以后新加的自动化)也带上
    for (const r of hbRows) if (!KNOWN_JOBS.find((k) => k.job_key === r.job_key))
      jobs.push({ job_key: r.job_key, name: r.name, machine: r.machine, schedule: r.schedule,
                  category: r.category, status: r.status, message: r.message, metric: r.metric, last_run: r.last_run, source: "heartbeat" });

    const projects = (await pool.query(
      `SELECT p.project_key, p.name, p.description, p.is_active, p.channels, p.trigger_type,
        p.recipient_config, p.tpl_key, p.sender_key,
        (SELECT status FROM notification_project_runs r WHERE r.project_key=p.project_key ORDER BY created_at DESC LIMIT 1) AS last_status,
        (SELECT created_at FROM notification_project_runs r WHERE r.project_key=p.project_key ORDER BY created_at DESC LIMIT 1) AS last_run,
        (SELECT error_message FROM notification_project_runs r WHERE r.project_key=p.project_key ORDER BY created_at DESC LIMIT 1) AS last_error
       FROM notification_projects p ORDER BY p.is_active DESC, p.name`
    )).rows;
    const templates = (await pool.query(`SELECT tpl_key, name FROM email_templates ORDER BY name`)).rows;

    const emails = (await pool.query(
      `SELECT recipient_name, recipient_email, subject, status, error_message, COALESCE(sent_at, created_at) AS at
         FROM email_message_log ORDER BY created_at DESC LIMIT 15`
    )).rows;
    const emailStats = (await pool.query(`SELECT status, count(*)::int AS n FROM email_message_log GROUP BY status`)).rows;

    const tasks = (await pool.query(
      `SELECT task_type, count(*)::int AS n FROM tasks WHERE status='open' GROUP BY task_type ORDER BY n DESC LIMIT 12`
    )).rows;

    // ---- 告警计算 ----
    const alerts = [];
    for (const j of jobs) if (j.status === "crit") alerts.push({ level: "crit", cat: j.category || "任务", text: `${j.name}:${j.message || "异常"}` });
    for (const j of jobs) if (j.status === "warn") alerts.push({ level: "warn", cat: j.category || "任务", text: `${j.name}:${j.message || "注意"}` });
    const sentN = emailStats.find((s) => s.status === "sent")?.n || 0;
    const notSentN = emailStats.filter((s) => ["pending", "skipped", "failed"].includes(s.status)).reduce((a, s) => a + s.n, 0);
    if (notSentN > 0 && sentN === 0) alerts.push({ level: "crit", cat: "邮件", text: `${notSentN} 封邮件未真正发出(pending/skipped/failed)` });
    for (const p of projects) {
      const d = daysSince(p.last_run);
      if (p.is_active && d !== null && d >= 3) alerts.push({ level: "warn", cat: "自动化", text: `${p.name} 已 ${d} 天没运行` });
    }

    const summary = {
      jobs_total: jobs.length,
      jobs_ok: jobs.filter((j) => j.status === "ok").length,
      jobs_crit: jobs.filter((j) => j.status === "crit").length,
      jobs_warn: jobs.filter((j) => j.status === "warn").length,
      jobs_pending: jobs.filter((j) => j.status === "pending_heartbeat").length,
      email_sent: sentN, email_not_sent: notSentN,
      open_tasks: tasks.reduce((a, t) => a + t.n, 0),
      alerts: alerts.length,
    };

    return res.status(200).json({ as_of: new Date().toISOString(), summary, jobs, projects, emails, emailStats, tasks, alerts, meta: { templates, can_edit: EDIT_ROLES.has(req.user?.role) } });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
