// GET/POST/PATCH /api/db/ops-todos — 操作待办与审核面板
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DONE = new Set(["approved", "rejected", "resolved", "done"]);
const LIVE = new Set(["open", "in_progress", "blocked"]);
const ALL_STATUS = new Set([...DONE, ...LIVE]);
const SEVERITY = new Set(["P1", "P2", "P3"]);
const AI_LOGIN_COLS = ["login_username", "username", "account", "account_id", "user_id", "employee_id"];
let aiStaffColumnsCache = null;

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function intVal(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function manualCode(v) {
  const raw = clean(v || "MANUAL", 60).toUpperCase();
  return raw.startsWith("MANUAL") ? raw : "MANUAL:" + raw;
}

async function aiStaffColumns(pool) {
  if (aiStaffColumnsCache) return aiStaffColumnsCache;
  try {
    const r = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='ai_staff'`
    );
    aiStaffColumnsCache = new Set(r.rows.map((x) => x.column_name));
  } catch (_) {
    aiStaffColumnsCache = new Set();
  }
  return aiStaffColumnsCache;
}

function aiNameExpr() {
  return "COALESCE(to_jsonb(ai_staff)->>'name_cn',to_jsonb(ai_staff)->>'name',to_jsonb(ai_staff)->>'name_en')";
}

async function actorFrom(req, pool) {
  const u = req.user || {};
  const out = {
    no: clean(u.staff_no || "", 80),
    name: clean(u.name || u.username || u.account || u.email || "", 120),
    aliases: new Set(),
    identityKnown: false,
  };
  [out.no, u.employee_code, u.staff_no, u.username, u.account, u.uid, u.id, u.sub, u.name].forEach((x) => {
    const s = clean(x, 80);
    if (s) out.aliases.add(s);
  });
  const cols = await aiStaffColumns(pool);
  const preds = [];
  const vals = [];
  if (cols.has("staff_no")) {
    [u.staff_no, u.employee_code].forEach((x) => {
      const s = clean(x, 80);
      if (s) { vals.push(s); preds.push(`staff_no = $${vals.length}`); }
    });
  }
  AI_LOGIN_COLS.filter((c) => cols.has(c)).forEach((c) => {
    [u.username, u.account, u.uid, u.id, u.sub, u.employee_id, u.employeeId].forEach((x) => {
      const s = clean(x, 120);
      if (s) { vals.push(s); preds.push(`lower(${c}::text) = lower($${vals.length})`); }
    });
  });
  if (cols.has("staff_no") && preds.length) {
    try {
      const r = await pool.query(
        `SELECT staff_no AS no,${aiNameExpr()} AS name
           FROM ai_staff
          WHERE ${preds.join(" OR ")}
          ORDER BY staff_no
          LIMIT 1`,
        vals
      );
      const a = r.rows[0];
      if (a && a.no) {
        out.no = clean(a.no, 80);
        out.identityKnown = true;
        out.aliases.add(out.no);
        if (a.name) { out.name = a.name; out.aliases.add(a.name); }
      }
    } catch (_) {}
  }
  if (u.employee_id || u.employeeId) {
    try {
      const r = await pool.query("SELECT employee_code,name FROM hr_employees WHERE id=$1", [u.employee_id || u.employeeId]);
      const e = r.rows[0];
      if (e) {
        if (!out.identityKnown && e.employee_code) { out.no = e.employee_code; out.aliases.add(e.employee_code); }
        if (e.name) { out.name = e.name; out.aliases.add(e.name); }
      }
    } catch (_) {}
  }
  if (!out.identityKnown) out.no = "unknown";
  return out;
}

async function displayMap(pool, codes) {
  const vals = [...new Set(codes.map((x) => clean(x, 80)).filter(Boolean))];
  const map = Object.fromEntries(vals.map((x) => [x, x]));
  if (!vals.length) return map;
  try {
    const r = await pool.query(
      "SELECT employee_code AS no,name FROM hr_employees WHERE employee_code = ANY($1)",
      [vals]
    );
    r.rows.forEach((x) => { if (x.no && x.name) map[x.no] = x.no + " " + x.name; });
  } catch (_) {}
  try {
    const cols = await aiStaffColumns(pool);
    if (!cols.has("staff_no")) throw new Error("ai_staff.staff_no missing");
    const r = await pool.query(
      `SELECT staff_no AS no,${aiNameExpr()} AS name
         FROM ai_staff WHERE staff_no = ANY($1)`,
      [vals]
    );
    r.rows.forEach((x) => { if (x.no && x.name) map[x.no] = x.no + " " + x.name; });
  } catch (_) {}
  return map;
}

function addFilters(q) {
  const vals = [];
  const where = [];
  const view = clean(q.view, 40);
  if (view === "pending_review") {
    where.push("status IN ('open','in_progress') AND NULLIF(BTRIM(reviewer_no),'') IS NOT NULL");
  } else if (view === "review_results") {
    where.push("status IN ('approved','rejected','resolved','done')");
  }
  if (q.from) { vals.push(clean(q.from, 20)); where.push(`created_at >= $${vals.length}::date`); }
  if (q.to) { vals.push(clean(q.to, 20)); where.push(`created_at < ($${vals.length}::date + interval '1 day')`); }
  if (q.severity && SEVERITY.has(clean(q.severity, 10).toUpperCase())) {
    vals.push(clean(q.severity, 10).toUpperCase()); where.push(`severity = $${vals.length}`);
  }
  if (q.status && ALL_STATUS.has(clean(q.status, 30))) {
    vals.push(clean(q.status, 30)); where.push(`status = $${vals.length}`);
  }
  return { vals, clause: where.length ? " WHERE " + where.join(" AND ") : "" };
}

function decorate(rows, names) {
  return rows.map((r) => ({
    ...r,
    is_manual: String(r.check_code || "").startsWith("MANUAL"),
    owner_label: r.owner_no ? names[r.owner_no] || r.owner_no : "",
    reviewer_label: r.reviewer_no ? names[r.reviewer_no] || r.reviewer_no : "",
    resolved_label: r.resolved_by ? names[r.resolved_by] || r.resolved_by : "",
  }));
}

async function listTodos(req, res, pool) {
  const f = addFilters(req.query || {});
  const limit = Math.min(Math.max(intVal(req.query.limit, 80), 1), 200);
  const offset = Math.max(intVal(req.query.offset, 0), 0);
  const sql = `
    SELECT id,check_code,severity,target_table,target_id,description,detail_json,status,
           to_char(created_at,'YYYY-MM-DD HH24:MI') AS created_at,
           to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at,
           to_char(resolved_at,'YYYY-MM-DD HH24:MI') AS resolved_at,
           resolved_by,notes,owner_no,reviewer_no
      FROM operation_todos${f.clause}
     ORDER BY created_at DESC,id DESC LIMIT $${f.vals.length + 1} OFFSET $${f.vals.length + 2}`;
  const rows = (await pool.query(sql, [...f.vals, limit, offset])).rows;
  const c = await pool.query(`SELECT COUNT(*)::int AS n FROM operation_todos${f.clause}`, f.vals);
  const s = await pool.query(`
    SELECT status,severity,COUNT(*)::int AS n
      FROM operation_todos${f.clause}
     GROUP BY status,severity`, f.vals);
  const names = await displayMap(pool, rows.flatMap((r) => [r.owner_no, r.reviewer_no, r.resolved_by]));
  return res.status(200).json({
    success: true,
    count: Number(c.rows[0]?.n || 0),
    data: decorate(rows, names),
    summary: s.rows,
    basis: "operation_todos.status / operation_todos.severity；人工项 = check_code 以 MANUAL 开头",
  });
}

async function createTodo(req, res, pool) {
  const b = req.body || {};
  const description = clean(b.description, 2000);
  if (!description) return res.status(400).json({ success: false, error: "description 必填" });
  const severity = SEVERITY.has(clean(b.severity, 10).toUpperCase()) ? clean(b.severity, 10).toUpperCase() : "P2";
  const r = await pool.query(
    `INSERT INTO operation_todos
       (check_code,severity,target_table,target_id,description,detail_json,status,owner_no,reviewer_no,notes)
     VALUES ($1,$2,$3,$4,$5,$6::json,'open',$7,$8,$9) RETURNING id`,
    [manualCode(b.check_code), severity, clean(b.target_table, 80) || null, clean(b.target_id, 120) || null,
     description, JSON.stringify({ source: "manual" }), clean(b.owner_no, 80) || null,
     clean(b.reviewer_no, 80) || null, clean(b.notes, 2000) || null]
  );
  return res.status(201).json({ success: true, id: r.rows[0].id });
}

async function reviewTodo(req, res, pool) {
  const b = req.body || {};
  const id = intVal(b.id || req.query.id, 0);
  const next = b.action === "reject" ? "rejected" : b.action === "approve" ? "approved" : "";
  if (!id || !next) return res.status(400).json({ success: false, error: "id 和 action=approve/reject 必填" });
  const actor = await actorFrom(req, pool);
  const cur = await pool.query("SELECT id,owner_no,status FROM operation_todos WHERE id=$1", [id]);
  if (!cur.rows.length) return res.status(404).json({ success: false, error: "待办不存在" });
  if (!actor.identityKnown || actor.no === "unknown") {
    return res.status(403).json({ success: false, error: "无法确认审核人身份，暂不能审批" });
  }
  if (cur.rows[0].owner_no && actor.aliases.has(cur.rows[0].owner_no)) {
    return res.status(403).json({ success: false, error: "执行人不能审核自己的待办" });
  }
  const r = await pool.query(
    `UPDATE operation_todos
        SET status=$2,resolved_by=$3,resolved_at=NOW(),notes=COALESCE($4,notes),updated_at=NOW()
      WHERE id=$1 RETURNING id,status,resolved_by`,
    [id, next, actor.no, clean(b.notes, 2000) || null]
  );
  return res.status(200).json({ success: true, data: r.rows[0] });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (req.method === "GET") return listTodos(req, res, pool);
    if (req.method === "POST") return createTodo(req, res, pool);
    if (req.method === "PATCH") return reviewTodo(req, res, pool);
    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[ops-todos]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
