import crypto from "node:crypto";
import fs from "node:fs";
import pkg from "pg";

const { Pool } = pkg;
const MAX_TASKS_PER_RUN = 5;
const RULE_VERSION = "staff-diary-problem-trigger-v1";

function loadEnv() {
  const candidates = ["/opt/sanlyn-api-test/.env", ".env"];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const envTxt = fs.readFileSync(file, "utf8");
    for (const line of envTxt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] == null) process.env[m[1]] = v;
    }
    return file;
  }
  return null;
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith("--date=")) args.date = arg.slice("--date=".length);
  }
  return args;
}

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function taskIdFor(dedupeKey) {
  return `probtask-${shortHash(dedupeKey)}`;
}

function compact(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function resultLabel(state) {
  return {
    module_fail: "模块故障",
    abnormal: "数据异常",
    none: "无数据",
    have: "有数据",
  }[state] || state || "问题";
}

function dedupeKey(row) {
  const dataSource = compact(row.data_source, "(未填数据源)");
  const signature = compact(row.fail_reason, dataSource);
  return `${row.report_date}|${dataSource}|${signature}`;
}

function recurrenceKey(row) {
  const dataSource = compact(row.data_source, "(未填数据源)");
  const signature = compact(row.fail_reason, dataSource);
  return `${dataSource}|${signature}`;
}

function uniq(values) {
  return Array.from(new Set(values.map((v) => compact(v)).filter(Boolean)));
}

function worseState(a, b) {
  const rank = { module_fail: 3, abnormal: 2, none: 1 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

async function notifyWecom(content) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    });
    return { ok: true };
  } catch (e) {
    console.error("[problem-trigger-scan] wecom failed:", e.message);
    return { ok: false, error: e.message };
  }
}

async function recurrenceDays(pool, { date, key }) {
  const r = await pool.query(
    `SELECT count(DISTINCT report_date)::int AS days
     FROM staff_daily_reports
     WHERE report_date >= ($1::date - interval '13 days')
       AND report_date <= $1::date
       AND result_state = 'none'
       AND CONCAT(COALESCE(NULLIF(data_source, ''), '(未填数据源)'), '|',
                  COALESCE(NULLIF(fail_reason, ''), COALESCE(NULLIF(data_source, ''), '(未填数据源)'))) = $2`,
    [date, key]
  );
  return Number(r.rows[0]?.days || 0);
}

function decisionFor(group, affectedDays) {
  const { state, rows } = group;
  const stateRows = rows.filter((row) => row.result_state === state);
  if (state === "module_fail") {
    return { shouldTrigger: true, reason: "模块故障立即升级" };
  }
  if (state === "abnormal") {
    if (stateRows.length >= 2) return { shouldTrigger: true, reason: `数据异常当天同源同签名已达${stateRows.length}次，触发升级` };
    return { shouldTrigger: false, reason: `数据异常未达当天≥2次阈值，当前${stateRows.length}次` };
  }
  if (state === "none") {
    const staffCount = uniq(stateRows.map((row) => row.staff_name)).length;
    if (affectedDays >= 2) return { shouldTrigger: true, reason: `无数据最近14天已出现${affectedDays}个不同日期，触发升级` };
    if (staffCount >= 2) return { shouldTrigger: true, reason: `无数据当天${staffCount}个不同岗位同时出现，触发升级` };
    return { shouldTrigger: false, reason: `无数据未达连续2周期/未达多岗同时阈值，最近14天${affectedDays}天，当天${staffCount}岗` };
  }
  return { shouldTrigger: false, reason: `${resultLabel(state)}不触发` };
}

async function upsertProblem(pool, group, affectedDays, reason) {
  const first = selectFirstForState(group.rows, group.state);
  const roles = uniq(group.rows.map((row) => row.staff_name));
  const r = await pool.query(
    `INSERT INTO problem_tasks
       (dedupe_key, recurrence_key, source_report_id, module, data_source, result_state,
        error_signature, affected_roles, affected_days_count, occurrence_count, status,
        trigger_reason, rule_version, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'untriggered',$11,$12,now(),now())
     ON CONFLICT (dedupe_key) DO UPDATE SET
       last_seen_at = now(),
       source_report_id = COALESCE(problem_tasks.source_report_id, excluded.source_report_id),
       module = excluded.module,
       data_source = excluded.data_source,
       result_state = excluded.result_state,
       error_signature = excluded.error_signature,
       affected_roles = (
         SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
         FROM jsonb_array_elements_text(COALESCE(problem_tasks.affected_roles, '[]'::jsonb) || excluded.affected_roles) AS t(value)
       ),
       affected_days_count = GREATEST(COALESCE(problem_tasks.affected_days_count, 0), excluded.affected_days_count),
       occurrence_count = GREATEST(COALESCE(problem_tasks.occurrence_count, 0), excluded.occurrence_count),
       trigger_reason = excluded.trigger_reason,
       rule_version = excluded.rule_version,
       status = CASE WHEN problem_tasks.task_id IS NULL THEN problem_tasks.status ELSE problem_tasks.status END,
       updated_at = now()
     RETURNING *`,
    [
      group.dedupe,
      group.recurrence,
      first.id,
      compact(first.data_source, "(未填数据源)"),
      compact(first.data_source, "(未填数据源)"),
      group.state,
      compact(first.fail_reason, compact(first.data_source, "(未填数据源)")),
      JSON.stringify(roles),
      affectedDays,
      group.rows.length,
      reason,
      RULE_VERSION,
    ]
  );
  return r.rows[0];
}

function selectFirstForState(rows, state) {
  return rows.find((row) => row.result_state === state) || rows[0];
}

async function createTask(pool, group, problem, reason) {
  const first = selectFirstForState(group.rows, group.state);
  const taskId = taskIdFor(group.dedupe);
  const dataSource = compact(first.data_source, "(未填数据源)");
  const failReason = compact(first.fail_reason, resultLabel(group.state));
  const stores = uniq(group.rows.map((row) => row.store_name)).join("、") || "未填门店";
  const roles = uniq(group.rows.map((row) => row.staff_name));
  const title = `员工日记问题:${dataSource} ${failReason}`;
  const humanReason = `${first.report_date} ${stores} 的员工日记发现 ${resultLabel(group.state)}：数据源 ${dataSource}，签名 ${failReason}，涉及 ${roles.length} 个岗位（${roles.join("、") || "未填"}），触发行 staff_daily_reports#${first.id}。${reason}`;
  const nextAction = "请判断是否需要修复对应模块/数据源，若确认需要代码修复请转发给 Codex/Claude 处理";

  await pool.query(
    `INSERT INTO tasks
       (id, title, reason, next_action, domain, source, dedupe_key, mode, auto_run, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'general','studio',$5,'owned',true,'open',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [taskId, title, humanReason, nextAction, group.dedupe]
  );

  await pool.query(
    `UPDATE problem_tasks
     SET task_id = COALESCE(task_id, $2),
         status = 'task_created',
         notified_at = COALESCE(notified_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [problem.id, taskId]
  );

  await pool.query(
    `UPDATE staff_daily_reports
     SET problem_task_id = $2, updated_at = now()
     WHERE report_date = $1::date
       AND CONCAT(COALESCE(NULLIF(data_source, ''), '(未填数据源)'), '|',
                  COALESCE(NULLIF(fail_reason, ''), COALESCE(NULLIF(data_source, ''), '(未填数据源)'))) = $3`,
    [first.report_date, problem.id, group.recurrence]
  );

  const wecom = await notifyWecom([
    `⚠️ 员工日记发现问题：${dataSource} ${resultLabel(group.state)}`,
    `**门店**: ${stores}`,
    `**数据源**: ${dataSource}`,
    `**问题类型**: ${resultLabel(group.state)}`,
    `**涉及岗位数**: ${roles.length}`,
    `**任务 id**: \`${taskId}\``,
  ].join("\n"));

  return { taskId, wecom };
}

async function main() {
  const envFile = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const date = args.date || shanghaiToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);

  const pool = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || "5432", 10),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: false,
    max: 3,
  });

  const summary = { ok: true, date, envFile, scanned: 0, problem_groups: 0, tasks_created: 0, skipped_have: 0, results: [] };
  try {
    const rows = await pool.query(
      `SELECT id, report_date::text AS report_date, staff_name, store_name, data_source, result_state, fail_reason
       FROM staff_daily_reports
       WHERE report_date = $1::date
         AND problem_task_id IS NULL
       ORDER BY created_at, id`,
      [date]
    );
    summary.scanned = rows.rowCount;

    const groups = new Map();
    for (const row of rows.rows) {
      if (row.result_state === "have") {
        summary.skipped_have += 1;
        continue;
      }
      if (!["module_fail", "abnormal", "none"].includes(row.result_state)) continue;
      const key = dedupeKey(row);
      if (!groups.has(key)) {
        groups.set(key, { state: row.result_state, dedupe: dedupeKey(row), recurrence: recurrenceKey(row), rows: [] });
      }
      const group = groups.get(key);
      group.state = worseState(group.state, row.result_state);
      group.rows.push(row);
    }
    summary.problem_groups = groups.size;

    for (const group of groups.values()) {
      const affectedDays = group.state === "none" ? await recurrenceDays(pool, { date, key: group.recurrence }) : 1;
      const decision = decisionFor(group, affectedDays);
      let problem = await upsertProblem(pool, group, affectedDays, decision.reason);
      const suppressed = problem.suppress_until && new Date(problem.suppress_until).getTime() > Date.now();

      if (!decision.shouldTrigger || problem.task_id || suppressed) {
        summary.results.push({
          dedupe_key: group.dedupe,
          status: problem.task_id ? "already_tasked" : suppressed ? "suppressed" : "untriggered",
          reason: suppressed ? `已 suppress 至 ${problem.suppress_until}` : decision.reason,
          problem_task_id: problem.id,
          task_id: problem.task_id,
        });
        continue;
      }

      if (summary.tasks_created >= MAX_TASKS_PER_RUN) {
        const limitReason = "超出单次运行上限，待下轮";
        await pool.query(
          `UPDATE problem_tasks SET trigger_reason = $2, updated_at = now() WHERE id = $1`,
          [problem.id, limitReason]
        );
        summary.results.push({ dedupe_key: group.dedupe, status: "rate_limited", reason: limitReason, problem_task_id: problem.id });
        continue;
      }

      const created = await createTask(pool, group, problem, decision.reason);
      summary.tasks_created += 1;
      summary.results.push({
        dedupe_key: group.dedupe,
        status: "task_created",
        reason: decision.reason,
        problem_task_id: problem.id,
        task_id: created.taskId,
        wecom: created.wecom,
      });
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
