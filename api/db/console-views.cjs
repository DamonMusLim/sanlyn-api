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

const router = express.Router();

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
          AND (level='L4' OR current_holder='Damon' OR (steps ? 'options'))
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
      await p2.query("UPDATE tasks SET damon_feedback=NULL, next_action='decision revoked' WHERE id=$1", [id]);
      await p2.query("INSERT INTO task_events(task_id,event_type,actor_type,actor_id,note) VALUES($1,'damon_decision_revoked','damon','damon','revoked by Damon')", [id]);
      return res.status(200).json({ success: true, revoked: true });
    }
    if (!id || !choice) return res.status(400).json({ success: false, error: "缺 choice" });
    const pool = getPool();
    await pool.query(
      "INSERT INTO task_events(task_id,event_type,actor_type,actor_id,note) VALUES($1,'damon_decision','damon','damon',$2)",
      [id, "拍板:" + choice + (note ? " | 备注:" + note : "")]);
    await pool.query(
      "UPDATE tasks SET damon_feedback=$2, next_action='已拍板:'||$2, updated_at=now() WHERE id=$1",
      [id, choice]);
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
         FROM tasks WHERE status IN ('open','doing') AND (level='L4' OR current_holder='Damon')
        ORDER BY (steps ? 'options') DESC, updated_at DESC LIMIT 5`);
    const c = await getPool().query(
      `SELECT COUNT(*) FILTER (WHERE status='done' AND COALESCE(closed_at,updated_at)::date=CURRENT_DATE)::int AS done_today,
              COUNT(*) FILTER (WHERE status IN ('open','doing'))::int AS active,
              COUNT(*) FILTER (WHERE status IN ('open','doing') AND (level='L4' OR current_holder='Damon'))::int AS pending_damon
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
       WHERE t.status IN ('open','doing') AND (t.level='L4' OR t.current_holder='Damon')
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
