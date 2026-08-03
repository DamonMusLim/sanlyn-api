"use strict";

const express = require("express");
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX || "3", 10),
    });
  }
  return pool;
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanLimit(value) {
  const parsed = parseInt(value || "200", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 500);
}

// 拍板结论分流(中文判断只在 JS 做,SQL 只收参数,避开 SQL_ASCII)
const _TERMINAL = ["自己关的", "别再问", "不用管", "不用处理", "不做", "放弃", "取消",
                   "知道了", "记下", "已解决", "完成", "关闭", "驳回", "算了"];
const _EXEC = ["去执行", "补录", "跟进", "处理", "申报", "修改", "下架", "降价", "联系",
               "照做", "同意", "上吧", "开吧", "先做", "改成"];
const _OWNER = { finance: "安娜", 报关: "辛迪", 退税: "瑞塔", 宠物店: "诺拉",
                 petshop: "诺拉", "petshop-pricing": "诺拉", infra: "Ocean", code: "Ocean" };
function decideOutcome(decision, task) {
  const d = String(decision || "");
  if (_TERMINAL.some((k) => d.includes(k))) return { kind: "done", holder: null };
  const who = _OWNER[task && task.domain] || _OWNER[task && task.task_type] || "Lyn";
  if (_EXEC.some((k) => d.includes(k))) return { kind: "assign", holder: who };
  return { kind: "assign", holder: "Lyn" };   // 认不出 → 转 Lyn,绝不留在 Damon 也绝不丢
}

const router = express.Router();

// -- data source center --
router.get("/api/console/sources", async (req, res) => {
  try {
    const result = await getPool().query(
      "SELECT cat, name, status, detail, cnt, last_seen, probed_at FROM data_sources ORDER BY " +
      "CASE cat WHEN 'core' THEN 1 WHEN 'email' THEN 2 WHEN 'wechat' THEN 3 WHEN 'wecom' THEN 4 " +
      "WHEN 'sms' THEN 5 WHEN 'call' THEN 6 WHEN 'shop' THEN 7 ELSE 8 END, id");
    res.json({ success: true,
      probed_at: result.rows.length ? result.rows[0].probed_at : null,
      rows: result.rows });
  } catch (e) { res.json({ success: false, error: String(e.message || e), rows: [] }); }
});

// -- data source center: mini side ingest --
router.post("/api/console/sources/ingest", require("express").json(), async (req, res) => {
  try {
    if ((req.body && req.body.token) !== "06zume-src") return res.status(403).json({ success: false, error: "bad token" });
    const rows = (req.body && req.body.rows) || [];
    if (!Array.isArray(rows) || !rows.length) return res.json({ success: false, error: "no rows" });
    const pool = getPool();
    await pool.query("DELETE FROM data_sources WHERE origin = 'mini'");
    for (const x of rows) {
      await pool.query(
        "INSERT INTO data_sources(cat,name,status,detail,cnt,last_seen,origin,probed_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,'mini',now()) ON CONFLICT (cat,name) DO UPDATE SET " +
        "status=EXCLUDED.status, detail=EXCLUDED.detail, cnt=EXCLUDED.cnt, " +
        "last_seen=EXCLUDED.last_seen, origin='mini', probed_at=now()",
        [x.cat || "other", x.name || "?", x.status || "unknown", x.detail || "",
         String(x.cnt == null ? "" : x.cnt), String(x.last || "")]);
    }
    res.json({ success: true, ingested: rows.length });
  } catch (e) { res.json({ success: false, error: String(e.message || e) }); }
});

// -- front 4 blocks: questions / yesterday / my notes --
const _b64 = (x) => "encode(COALESCE(" + x + ",'')::bytea,'base64')";

router.get("/api/console/questions", async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS damon_questions(
      id serial PRIMARY KEY, task_id text, asker text, question text, context text,
      status text DEFAULT 'open', answer text, asked_at timestamptz DEFAULT now(),
      answered_at timestamptz)`);
    const q = await pool.query(
      "SELECT q.id, q.task_id, q.asker, " + _b64("q.question") + " AS question_b64, " +
      _b64("q.context") + " AS context_b64, q.asked_at, " +
      _b64("t.title") + " AS task_title_b64, t.serial_no " +
      "FROM damon_questions q LEFT JOIN tasks t ON t.id = q.task_id " +
      "WHERE q.status = 'open' ORDER BY q.asked_at DESC LIMIT 50");
    const bl = await pool.query(
      "SELECT id, serial_no, " + _b64("title") + " AS title_b64, " +
      _b64("failure_point") + " AS reason_b64, current_holder, updated_at " +
      "FROM tasks WHERE status IN ('open','doing') AND COALESCE(failure_point,'') <> '' " +
      "ORDER BY updated_at DESC LIMIT 30");
    res.json({ success: true, questions: q.rows, blocked: bl.rows });
  } catch (e) { res.json({ success: false, error: String(e.message || e), questions: [], blocked: [] }); }
});

router.post("/api/console/questions/:id/answer", require("express").json(), async (req, res) => {
  try {
    const ans = String((req.body && req.body.answer) || "").slice(0, 4000);
    if (!ans.trim()) return res.json({ success: false, error: "答案为空" });
    const b = Buffer.from(ans, "utf8").toString("base64");
    const pool = getPool();
    const r = await pool.query(
      "UPDATE damon_questions SET status='answered', answered_at=now(), " +
      "answer=convert_from(decode($1,'base64'),'UTF8') WHERE id=$2 AND status='open' RETURNING task_id",
      [b, parseInt(req.params.id, 10)]);
    if (r.rows.length && r.rows[0].task_id) {
      await pool.query(
        "INSERT INTO task_events(task_id, actor, actor_type, event_type, note, created_at) " +
        "VALUES ($1,'Damon','human','answer',convert_from(decode($2,'base64'),'UTF8'),now())",
        [r.rows[0].task_id, b]).catch(() => {});
    }
    res.json({ success: true, updated: r.rows.length });
  } catch (e) { res.json({ success: false, error: String(e.message || e) }); }
});

router.get("/api/console/yesterday", async (req, res) => {
  try {
    const pool = getPool();
    const rep = await pool.query(
      "SELECT day, " + _b64("body") + " AS body_b64, facts FROM daily_report " +
      "WHERE day <= CURRENT_DATE ORDER BY day DESC LIMIT 1");
    const dec = await pool.query(
      "SELECT " + _b64("t.title") + " AS title_b64, t.serial_no, t.status, t.updated_at " +
      "FROM tasks t WHERE t.status IN ('done','cancelled') " +
      "AND COALESCE(t.closed_at,t.updated_at)::date >= CURRENT_DATE - 1 " +
      "ORDER BY t.updated_at DESC LIMIT 40");
    const feed = await pool.query(
      "SELECT kind, " + _b64("title") + " AS title_b64, ts FROM ops_feed " +
      "WHERE ts > now() - interval '36 hours' ORDER BY ts DESC LIMIT 40");
    res.json({ success: true, report: rep.rows[0] || null, decided: dec.rows, feed: feed.rows });
  } catch (e) { res.json({ success: false, error: String(e.message || e), decided: [], feed: [] }); }
});

router.get("/api/console/my-notes", async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS damon_notes(
      id serial PRIMARY KEY, day date, body text, source text DEFAULT 'web',
      created_at timestamptz DEFAULT now())`);
    const q = await pool.query(
      "SELECT id, day, " + _b64("body") + " AS body_b64, source, created_at " +
      "FROM damon_notes ORDER BY created_at DESC LIMIT 30");
    res.json({ success: true, rows: q.rows });
  } catch (e) { res.json({ success: false, error: String(e.message || e), rows: [] }); }
});

router.post("/api/console/my-notes", require("express").json(), async (req, res) => {
  try {
    const body = String((req.body && req.body.body) || "").slice(0, 8000);
    if (!body.trim()) return res.json({ success: false, error: "内容为空" });
    const b = Buffer.from(body, "utf8").toString("base64");
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS damon_notes(
      id serial PRIMARY KEY, day date, body text, source text DEFAULT 'web',
      created_at timestamptz DEFAULT now())`);
    await pool.query(
      "INSERT INTO damon_notes(day, body, source) VALUES " +
      "(CURRENT_DATE, convert_from(decode($1,'base64'),'UTF8'), $2)",
      [b, String((req.body && req.body.source) || "web").slice(0, 20)]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: String(e.message || e) }); }
});

router.post("/api/console/blocked/answer", require("express").json(), async (req, res) => {
  try {
    const tid = String((req.body && req.body.task_id) || "");
    const ans = String((req.body && req.body.answer) || "").slice(0, 4000);
    if (!tid || !ans.trim()) return res.json({ success: false, error: "缺 task_id 或答案" });
    const b = Buffer.from(ans, "utf8").toString("base64");
    const pool = getPool();
    await pool.query(
      "INSERT INTO task_events(task_id, actor, actor_type, event_type, note, created_at) " +
      "VALUES (\,'Damon','human','unblock',convert_from(decode(\,'base64'),'UTF8'),now())", [tid, b]);
    const r = await pool.query(
      "UPDATE tasks SET failure_point=NULL, damon_feedback=convert_from(decode(\,'base64'),'UTF8'), " +
      "updated_at=now() WHERE id=\ AND status IN ('open','doing') RETURNING id", [b, tid]);
    res.json({ success: true, updated: r.rows.length });
  } catch (e) { res.json({ success: false, error: String(e.message || e) }); }
});

// -- 微信短码入口: /c/<code> → 302 到真页面。微信里永不出现私链 key --
const SHORT = { a7: "/one", c3: "/center", s9: "/sources", d5: "/one", h4: "/finance/history.html" };
router.get("/g/:code", async (req, res) => {
  const t = SHORT[String(req.params.code || "").slice(0, 8)];
  if (!t) return res.status(404).type("html").send("<h3>链接不存在或已作废</h3>");
  res.redirect(302, t + "?k=06zume");
});

// -- 闸门挡单:mini 回传 + 作战实验室查看 --
router.post("/api/console/held/ingest", require("express").json(), async (req, res) => {
  try {
    if ((req.body && req.body.token) !== "06zume-src") return res.status(403).json({ success: false });
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS push_held(
      id serial PRIMARY KEY, day date, reason text, msg text, held_at timestamptz,
      suppressed int DEFAULT 0, created_at timestamptz DEFAULT now())`);
    await pool.query("DELETE FROM push_held WHERE day = CURRENT_DATE");
    const rows = (req.body && req.body.rows) || [];
    for (const x of rows) {
      const b = Buffer.from(String(x.msg || ""), "utf8").toString("base64");
      await pool.query(
        "INSERT INTO push_held(day, reason, msg, held_at, suppressed) VALUES " +
        "(CURRENT_DATE, $1, convert_from(decode($2,'base64'),'UTF8'), $3, $4)",
        [String(x.reason || "?"), b, x.ts || null, 0]);
    }
    if (req.body.suppressed) {
      await pool.query("INSERT INTO push_held(day, reason, msg, suppressed) VALUES " +
        "(CURRENT_DATE, 'duplicate', convert_from(decode($1,'base64'),'UTF8'), $2)",
        [Buffer.from("同一件事重复上报,已压下", "utf8").toString("base64"), req.body.suppressed]);
    }
    res.json({ success: true, ingested: rows.length });
  } catch (e) { res.json({ success: false, error: String(e.message || e) }); }
});

router.get("/api/console/held", async (req, res) => {
  try {
    const pool = getPool();
    const q = await pool.query(
      "SELECT reason, encode(COALESCE(msg,'')::bytea,'base64') AS msg_b64, held_at, suppressed " +
      "FROM push_held WHERE day >= CURRENT_DATE - 1 ORDER BY held_at DESC NULLS LAST LIMIT 80");
    res.json({ success: true, rows: q.rows });
  } catch (e) { res.json({ success: false, error: String(e.message || e), rows: [] }); }
});

router.get("/api/console/tasks", async (req, res) => {
  try {
    const status = cleanText(req.query.status);
    const prefix = cleanText(req.query.prefix || req.query.domain);
    const q = cleanText(req.query.q);
    const includeDone = cleanText(req.query.include_done) === "1" || status === "done";
    const limit = cleanLimit(req.query.limit);
    const result = await getPool().query(
      `SELECT v.*, tk.task_type
         FROM task_center_v v LEFT JOIN tasks tk ON tk.id = v.id
        WHERE ($1::text IS NULL OR v.status = $1)
          AND ($2::text IS NULL OR v.task_prefix = $2)
          AND ($3::boolean OR COALESCE(v.status, '') <> 'done')
          AND (
            $4::text IS NULL
            OR v.display_task_code ILIKE '%' || $4 || '%'
            OR v.related_biz_no ILIKE '%' || $4 || '%'
            OR v.id::text ILIKE '%' || $4 || '%'
            OR v.title ILIKE '%' || $4 || '%'
          )
        ORDER BY (v.risk_color='red') DESC, v.updated_at DESC
        LIMIT $5`,
      [status, prefix, includeDone, q, limit]
    );
    return res.status(200).json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/domain-counts", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT
         COALESCE(task_prefix, 'UNKNOWN') AS task_prefix,
         COALESCE(domain_label, '未知') AS domain_label,
         COUNT(*) FILTER (WHERE status IN ('open','doing'))::int AS total_count,
         COUNT(*) FILTER (
           WHERE status IN ('open','doing') AND risk_color = 'red'
         )::int AS stuck_count,
         COUNT(*) FILTER (WHERE level = 'L4' AND status = 'open')::int AS decision_count
       FROM task_center_v
      GROUP BY task_prefix, domain_label
      HAVING COUNT(*) FILTER (WHERE status IN ('open','doing')) > 0
      ORDER BY
        CASE COALESCE(task_prefix, 'UNKNOWN')
          WHEN 'FS' THEN 1 WHEN 'CY' THEN 2 WHEN 'CAW' THEN 3
          WHEN 'FIN' THEN 4 WHEN 'OPS' THEN 5 WHEN 'D' THEN 6 ELSE 9
        END,
        task_prefix ASC`
    );
    try {
      const oc = await getPool().query("SELECT COUNT(*)::int AS c FROM task_center_v WHERE current_holder = 'Ocean' AND status <> 'done'");
      result.rows.push({ task_prefix: '__OCEAN__', domain_label: 'Ocean代码', total_count: oc.rows[0].c, stuck_count: 0, decision_count: 0 });
    } catch (e) { /* ocean count optional */ }
    return res.status(200).json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/tasks-summary", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')::int AS open,
         COUNT(*) FILTER (WHERE status = 'doing')::int AS doing,
         COUNT(*) FILTER (
           WHERE status = 'done'
             AND updated_at >= (((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai')
             AND updated_at < ((((now() AT TIME ZONE 'Asia/Shanghai')::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai')
         )::int AS done_today,
         COUNT(*) FILTER (
           WHERE status = 'doing'
             AND (updated_at < now() - interval '48 hours' OR NULLIF(failure_point, '') IS NOT NULL)
         )::int AS stuck,
         COUNT(*) FILTER (
           WHERE created_at >= (((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai')
             AND created_at < ((((now() AT TIME ZONE 'Asia/Shanghai')::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai')
         )::int AS today_new
       FROM tasks`
    );
    return res.status(200).json({ success: true, ...result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/staff", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT staff_no, name_cn, name_en, skill_keys, domain, duty, status,
              escalates_to, heartbeat_at, today_note, seat_no
         FROM ai_staff
        ORDER BY seat_no NULLS LAST, staff_no ASC`
    );
    return res.status(200).json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/api/console/push-log-summary", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || "7", 10) || 7, 1), 60);
    const result = await getPool().query(
      `SELECT (pushed_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
              audience,
              COUNT(*)::int AS count
         FROM push_log
        WHERE pushed_at >= now() - ($1::int * interval '1 day')
        GROUP BY day, audience
        ORDER BY day DESC, audience ASC`,
      [days]
    );
    return res.status(200).json({ success: true, days, data: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


// —— 待Damon拍板的决策列表(腾讯富化任务:实情+A/B/C) ——
router.get("/api/console/decisions", async (req, res) => {
  try {
    const result = await getPool().query(
      `SELECT id, title, COALESCE(domain,'') AS domain, COALESCE(level,'') AS level,
              COALESCE(current_holder,'') AS current_holder, steps
         FROM tasks
        WHERE status IN ('open','doing')
          AND COALESCE(damon_feedback,'') = '' AND (level='L4' OR current_holder='Damon' OR (steps ? 'options'))
        ORDER BY (steps ? 'options') DESC, (level='L4') DESC, updated_at DESC
        LIMIT 50`);
    return res.status(200).json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

// —— Damon拍板回写 ——
router.post("/api/console/tasks/:id/decide", require("express").json(), async (req, res) => {
  try {
    const id = req.params.id;
    const choice = String((req.body && req.body.choice) || "").slice(0, 500);
    const note = String((req.body && req.body.note) || "").slice(0, 1000);
    if (req.body && req.body.revoke) {
      const p2 = getPool();
      await p2.query("UPDATE tasks SET damon_feedback=NULL, next_action='待拍板', " +
        "status='open', closed_at=NULL, current_holder='Damon', updated_at=now() WHERE id=$1", [id]);
      await p2.query("INSERT INTO task_events(task_id,event_type,actor_type,actor_id,note) VALUES($1,'damon_decision_revoked','damon','damon','revoked by Damon')", [id]);
      return res.status(200).json({ success: true, revoked: true });
    }
    if (!id || !choice) return res.status(400).json({ success: false, error: "缺 choice" });
    const _t = (await getPool().query(
      "SELECT domain, task_type FROM tasks WHERE id=$1", [id])).rows[0] || {};
    const _oc = decideOutcome(choice, _t);
    const pool = getPool();
    await pool.query(
      "INSERT INTO task_events(task_id,event_type,actor_type,actor_id,note) VALUES($1,'damon_decision','damon','damon',$2)",
      [id, "拍板:" + choice + (note ? " | 备注:" + note : "")]);
    await pool.query(
      "UPDATE tasks SET damon_feedback=$2, next_action=$3, status=$4::text, " +
      "closed_at=CASE WHEN $4::text='done' THEN now() ELSE closed_at END, " +
      "current_holder=$5, current_holder_role=$6, updated_at=now() WHERE id=$1",
      [id, choice,
       (_oc.kind === "done" ? "已拍板:" : "已拍板:") + choice +
         (_oc.kind === "assign" ? "(交" + _oc.holder + "执行)" : ""),
       _oc.kind === "done" ? "done" : "open",
       _oc.holder, _oc.kind === "assign" ? "execute" : null]);
    return res.status(200).json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});


// —— 给diary日记页的最小只读摘要(GPT设计#4):CORS只放diary域,只GET,不带凭据 ——
router.get("/api/damon/today-summary", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "https://diary.sanlyn.cn");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  if ((req.query.k || "") !== "06zume") return res.status(403).json({ success: false });
  try {
    const d = await getPool().query(
      `SELECT id, title, COALESCE(level,'') AS level, COALESCE(domain,'') AS domain
         FROM tasks WHERE status IN ('open','doing') AND COALESCE(damon_feedback,'') = '' AND (level='L4' OR current_holder='Damon')
        ORDER BY (steps ? 'options') DESC, updated_at DESC LIMIT 5`);
    const c = await getPool().query(
      `SELECT COUNT(*) FILTER (WHERE status='done' AND COALESCE(closed_at,updated_at)::date=CURRENT_DATE)::int AS done_today,
              COUNT(*) FILTER (WHERE status IN ('open','doing'))::int AS active,
              COUNT(*) FILTER (WHERE status IN ('open','doing') AND COALESCE(damon_feedback,'') = '' AND (level='L4' OR current_holder='Damon'))::int AS pending_damon
         FROM tasks`);
    return res.status(200).json({ success: true, counts: c.rows[0], top: d.rows,
      link: "https://damon.sanlyn.cn/center" });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});


// —— 批量处理(Damon要:勾选多条一键办) ——
router.post("/api/console/tasks/bulk", require("express").json(), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 100).map(String) : [];
    const action = String((req.body && req.body.action) || "");
    const holder = String((req.body && req.body.holder) || "").slice(0, 20);
    if (!ids.length) return res.status(400).json({ success: false, error: "缺ids" });
    const pool = getPool();
    let n = 0;
    if (action === "done" || action === "cancel") {
      const st = action === "done" ? "done" : "cancelled";
      const r = await pool.query(
        "UPDATE tasks SET status=$2, closed_at=now(), next_action='Damon批量'||$2 WHERE id = ANY($1) AND status IN ('open','doing')",
        [ids, st]);
      n = r.rowCount;
      await pool.query(
        "INSERT INTO task_events(task_id,event_type,actor_type,actor_id,note) SELECT unnest($1::varchar[]),'damon_bulk','damon','damon','批量'||$2", [ids, st]);
    } else if (action === "assign" && holder) {
      const r = await pool.query(
        "UPDATE tasks SET current_holder=$2, relay_path=$2||'·批量转派', updated_at=now() WHERE id = ANY($1) AND status IN ('open','doing')",
        [ids, holder]);
      n = r.rowCount;
      await pool.query(
        "INSERT INTO task_events(task_id,event_type,actor_type,actor_id,note) SELECT unnest($1::varchar[]),'damon_bulk','damon','damon','批量转派→'||$2", [ids, holder]);
    } else return res.status(400).json({ success: false, error: "action须done/cancel/assign" });
    return res.status(200).json({ success: true, updated: n });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});




// —— 单任务历史(点击才拉,过滤skill/engine噪音) ——
router.get("/api/console/task-history", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ success: false, error: "need id" });
    const r = await getPool().query(
      `SELECT to_char(created_at,'MM-DD HH24:MI') AS t,
              COALESCE(event_type,'') AS kind, COALESCE(actor_id,'') AS who,
              COALESCE(left(note,90),'') AS note
         FROM task_events
        WHERE task_id = $1 AND COALESCE(actor_type,'') NOT IN ('skill','engine')
        ORDER BY created_at DESC LIMIT 15`, [id]);
    return res.status(200).json({ success: true, events: r.rows });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

// —— 已拍板(历史tab) ——
router.get("/api/console/decided", async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT id, COALESCE(serial_no,0) AS serial_no, COALESCE(title,'') AS title,
              COALESCE(damon_feedback,'') AS choice,
              to_char(updated_at,'MM-DD HH24:MI') AS decided_at, COALESCE(status,'') AS status
         FROM tasks WHERE COALESCE(damon_feedback,'') <> ''
        ORDER BY updated_at DESC LIMIT 40`);
    return res.status(200).json({ success: true, total: r.rowCount, rows: r.rows });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

// —— 动态流(动态tab) ——
router.get("/api/console/feed", async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT to_char(ts,'MM-DD HH24:MI') AS t, COALESCE(kind,'') AS kind,
              COALESCE(left(title,80),'') AS title, amount, COALESCE(actor,'') AS actor
         FROM ops_feed ORDER BY ts DESC LIMIT 40`);
    return res.status(200).json({ success: true, total: r.rowCount, rows: r.rows });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});


// —— 单任务完整详情(base64绕SQL_ASCII编码坑,前端解码) ——
router.get("/api/console/task-detail", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ success: false, error: "need id" });
    const t = await getPool().query(
      `SELECT id, COALESCE(serial_no,0) AS serial_no,
              encode(COALESCE(title,'')::bytea,'base64') AS title_b64,
              encode(COALESCE(reason,'')::bytea,'base64') AS reason_b64,
              encode(COALESCE(next_action,'')::bytea,'base64') AS next_action_b64,
              COALESCE(task_type,'') AS task_type, COALESCE(level,'') AS level,
              COALESCE(current_holder,'') AS holder, COALESCE(source,'') AS source,
              COALESCE(domain,'') AS domain, COALESCE(task_prefix,'') AS task_prefix,
              COALESCE(related_order_no,'') AS order_no, COALESCE(related_biz_no,'') AS biz_no,
              COALESCE(related_po_no,'') AS po_no, steps,
              to_char(created_at,'YYYY-MM-DD HH24:MI') AS created,
              round(EXTRACT(EPOCH FROM (now()-updated_at))/86400)::int AS idle_days,
              encode(COALESCE(damon_feedback,'')::bytea,'base64') AS feedback_b64
         FROM tasks WHERE id = $1`, [id]);
    if (!t.rowCount) return res.status(404).json({ success: false, error: "not found" });
    const ev = await getPool().query(
      `SELECT to_char(created_at,'MM-DD HH24:MI') AS t, COALESCE(event_type,'') AS kind,
              COALESCE(actor_id,'') AS who, encode(COALESCE(note,'')::bytea,'base64') AS note_b64
         FROM task_events WHERE task_id = $1 AND COALESCE(actor_type,'') NOT IN ('skill','engine')
        ORDER BY created_at DESC LIMIT 20`, [id]);
    return res.status(200).json({ success: true, task: t.rows[0], events: ev.rows });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});



// —— 一屏一任务(已@P验证版:纯COALESCE不转码, WHERE用ASCII) ——
router.get("/api/console/onecard", async (req, res) => {
  try {
    const r = await getPool().query(`
      SELECT t.id, COALESCE(t.serial_no,0) AS serial_no,
             COALESCE(t.title,'') AS title,
             length(COALESCE(t.reason,'')) AS reason_len,
             COALESCE(t.domain,'') AS domain, COALESCE(t.task_prefix,'') AS task_prefix,
             COALESCE(t.task_type,'') AS task_type, COALESCE(t.level,'') AS level,
             COALESCE(t.current_holder,'') AS holder, COALESCE(t.source,'') AS source,
             COALESCE(t.related_order_no,'') AS order_no, COALESCE(t.related_biz_no,'') AS biz_no,
             COALESCE(t.related_po_no,'') AS po_no, t.steps,
             to_char(t.created_at,'MM-DD HH24:MI') AS created,
             round(EXTRACT(EPOCH FROM (now()-t.updated_at))/86400)::int AS idle_days
        FROM tasks t
       WHERE t.status IN ('open','doing') AND COALESCE(t.damon_feedback,'') = '' AND (t.level='L4' OR t.current_holder='Damon')
         AND COALESCE(t.task_type,'') NOT LIKE 'Damon%'
       ORDER BY (t.steps ? 'options') DESC, t.serial_no ASC`);
    return res.status(200).json({ success: true, total: r.rowCount, cards: r.rows });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});


// —— 懂Damon的聊天:喂DNA规则+任务上下文+经验库,再问MiniMax ——
router.post("/api/console/ask", require("express").json(), async (req, res) => {
  try {
    const q = String((req.body && req.body.q) || "").slice(0, 800);
    const taskId = String((req.body && req.body.task_id) || "");
    if (!q) return res.status(400).json({ success: false, error: "need q" });
    const pool = getPool();

    // 1) Damon 的决策DNA(他的性格)
    const dna = await pool.query(
      "SELECT domain, scene, rule_text FROM decision_rules WHERE active AND COALESCE(status,'active')='active' ORDER BY priority ASC LIMIT 30");
    const dnaTxt = dna.rows.map(r => `- [${r.domain}/${r.scene}] ${r.rule_text}`).join("\n");

    // 2) 当前任务上下文(如果在问某条)
    let taskTxt = "";
    if (taskId) {
      const t = await pool.query(
        `SELECT COALESCE(serial_no,0) AS n, encode(COALESCE(title,'')::bytea,'base64') AS tb,
                encode(COALESCE(reason,'')::bytea,'base64') AS rb,
                encode(COALESCE(next_action,'')::bytea,'base64') AS nb,
                COALESCE(task_type,'') AS tt, COALESCE(domain,'') AS dm,
                COALESCE(current_holder,'') AS hd, COALESCE(source,'') AS src,
                COALESCE(related_order_no,'') AS ord, COALESCE(related_biz_no,'') AS biz
           FROM tasks WHERE id = $1`, [taskId]);
      if (t.rowCount) {
        const r = t.rows[0];
        const dec = b => { try { return Buffer.from(b || "", "base64").toString("utf8"); } catch (e) { return ""; } };
        taskTxt = `\n【当前在问这条任务】\n工单#${r.n} 类型:${r.tt} 域:${r.dm} 归:${r.hd} 来源:${r.src}` +
          (r.ord ? ` 订单:${r.ord}` : "") + (r.biz ? ` 业务号:${r.biz}` : "") +
          `\n标题:${dec(r.tb)}\n背景:${dec(r.rb).slice(0, 1200)}\n建议下一步:${dec(r.nb).slice(0, 400)}\n`;
      }
    }

    // 3) 相关经验(避免重复踩坑)
    const lr = await pool.query(
      "SELECT root_cause, solution FROM learnings ORDER BY applied_count DESC LIMIT 8");
    const lrTxt = lr.rows.map(r => `- 坑:${r.root_cause.slice(0,80)} → 解:${r.solution.slice(0,80)}`).join("\n");

    const sys = `你是Lyn,Damon(外贸海运+宠物店老板)的AI秘书。你很懂他,说人话、直接、不客套。
【他的决策规则(他的性格,回答必须符合)】
${dnaTxt}
【历史踩过的坑(别再建议踩)】
${lrTxt}
【铁律】只有涉钱/高风险才需要他拍板;数据缺就说缺不猜;有实证才下结论;回答控制在150字内,能一句说完就一句。${taskTxt}`;

    const key = process.env.MINIMAX_API_KEY || "";
    if (!key) return res.status(200).json({ success: true, answer: "(MiniMax key 未配置,先给你上下文)", context_only: true, dna_count: dna.rowCount });
    const rsp = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.MINIMAX_MODEL || "MiniMax-M2.7-highspeed", max_tokens: 700,
        system: sys, messages: [{ role: "user", content: q }] }),
    });
    const d = await rsp.json();
    const answer = (d.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim()
      || (d.content || []).map(x => x.text || "").join("\n").trim() || "(没拿到回答)";
    try {
      await pool.query("INSERT INTO ops_feed(domain,actor,kind,title,ref_code) VALUES('chat','katherine','ask',$1,$2)",
        [q.slice(0, 70), taskId || null]);
    } catch (e) {}
    return res.status(200).json({ success: true, answer, dna_used: dna.rowCount, has_task_ctx: !!taskTxt });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});


// —— 今日报告(Lyn写的)+DNA快照 ——
router.get("/api/console/daily", async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query("SELECT day, encode(body::bytea,'base64') AS body_b64, facts FROM daily_report ORDER BY day DESC LIMIT 1");
    const dna = await pool.query("SELECT COUNT(*)::int AS n, MAX(created_at) AS latest FROM decision_rules WHERE active");
    const rules = await pool.query("SELECT encode((domain||' / '||scene||': '||rule_text)::bytea,'base64') AS r_b64 FROM decision_rules WHERE active ORDER BY priority ASC LIMIT 30");
    return res.status(200).json({ success: true, report: r.rows[0] || null, dna_count: dna.rows[0].n, dna_latest: dna.rows[0].latest, rules: rules.rows.map(x => x.r_b64) });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

// —— 报警面板真数据(无title避编码坑;title点击时另拉) ——
router.get("/api/console/alerts", async (req, res) => {
  try {
    const pool = getPool();
    const stale = "GREATEST(t.created_at, COALESCE((SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id=t.id AND e.actor_type NOT IN ('skill','engine')), t.created_at))";
    const q = async (where) => (await pool.query(
      `SELECT t.id, COALESCE(t.serial_no,0) AS serial_no, COALESCE(t.current_holder,'') AS holder,
              COALESCE(t.task_type,'') AS task_type, round(EXTRACT(EPOCH FROM (now()-${stale}))/3600)::int AS idle_h
         FROM tasks t WHERE t.status IN ('open','doing') AND (${where}) ORDER BY idle_h DESC LIMIT 20`)).rows;
    const fault = await q("t.risk_color='red' OR t.id IN (SELECT task_id FROM task_events WHERE event_type IN ('skill_error','forge_stuck'))");
    const decision = await q("(t.level='L4' OR t.current_holder='Damon') AND COALESCE(t.task_type,'')<>'Damon规划池'");
    const zombie = await q(`${stale} < now()-interval '720 hours'`);
    const overdue = await q(`${stale} < now()-interval '48 hours' AND (t.current_holder='Ocean' OR t.risk_color='red')`);
    return res.status(200).json({ success: true,
      fault: { count: fault.length, tasks: fault }, decision: { count: decision.length, tasks: decision },
      zombie: { count: zombie.length, tasks: zombie }, overdue: { count: overdue.length, tasks: overdue } });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
