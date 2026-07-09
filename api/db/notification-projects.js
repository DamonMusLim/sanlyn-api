// api/db/notification-projects.js — 通知项目中心：可复用的通知规则(发给谁/用什么模版/走什么渠道)
// GET    /api/db/notification-projects              → 列表
// GET    /api/db/notification-projects?key=xxx      → 单条
// POST   /api/db/notification-projects              → 新增
// PATCH  /api/db/notification-projects               → 改(含软停用 is_active:false)
// DELETE /api/db/notification-projects?id=           → 硬删(仅无执行记录时允许)
// GET    /api/db/notification-projects?runs=1&project_key=xxx  → 执行记录列表
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function ensureNotificationProjects(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_projects (
      id BIGSERIAL PRIMARY KEY,
      project_key TEXT UNIQUE,
      name TEXT, description TEXT,
      trigger_type TEXT DEFAULT 'manual_button',
      trigger_event TEXT, source_module TEXT,
      category TEXT DEFAULT 'other',
      recipient_config JSONB DEFAULT '{}'::jsonb,
      template_id INTEGER, tpl_key TEXT,
      sender_key TEXT,
      channels TEXT[] DEFAULT '{email}',
      context_schema JSONB DEFAULT '[]'::jsonb,
      dedupe_pattern TEXT,
      is_active BOOLEAN DEFAULT true,
      created_by TEXT, updated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
      raw JSONB DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS notification_project_runs (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT, project_key TEXT,
      trigger_type TEXT, trigger_source TEXT, triggered_by TEXT,
      context JSONB DEFAULT '{}'::jsonb,
      resolved_recipients JSONB DEFAULT '[]'::jsonb,
      resolved_template JSONB DEFAULT '{}'::jsonb,
      channels TEXT[] DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      dedupe_key TEXT,
      result JSONB DEFAULT '{}'::jsonb,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_npr_project ON notification_project_runs(project_key, created_at DESC);
  `).catch(() => {});
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensureNotificationProjects(pool);
    const user = (req.user && (req.user.username || req.user.name)) || "admin";

    if (req.method === "GET" && (req.query.runs === "1" || req.query.runs === "true")) {
      const key = req.query.project_key;
      const r = await pool.query(
        `SELECT * FROM notification_project_runs ${key ? "WHERE project_key=$1" : ""}
          ORDER BY created_at DESC LIMIT 200`, key ? [key] : []);
      return res.json({ success: true, data: r.rows });
    }

    if (req.method === "GET") {
      if (req.query.key) {
        const r = await pool.query(`SELECT * FROM notification_projects WHERE project_key=$1`, [req.query.key]);
        return res.json({ success: true, data: r.rows[0] || null });
      }
      const r = await pool.query(`SELECT * FROM notification_projects ORDER BY id ASC`);
      return res.json({ success: true, data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      let key = (b.project_key || "").trim();
      if (!key) key = "proj_" + Date.now();
      if (!/^[a-z0-9_]+$/i.test(key)) return res.status(400).json({ error: "project_key 只能用字母数字下划线" });
      const r = await pool.query(
        `INSERT INTO notification_projects
           (project_key,name,description,trigger_type,trigger_event,source_module,category,
            recipient_config,template_id,tpl_key,sender_key,channels,context_schema,dedupe_pattern,
            is_active,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         ON CONFLICT (project_key) DO NOTHING RETURNING *`,
        [key, b.name || key, b.description || "", b.trigger_type || "manual_button",
         b.trigger_event || null, b.source_module || null, b.category || "other",
         JSON.stringify(b.recipient_config || {}), b.template_id || null, b.tpl_key || null,
         b.sender_key || null, b.channels || ["email"], JSON.stringify(b.context_schema || []),
         b.dedupe_pattern || null, b.is_active !== false, user]);
      if (!r.rows[0]) return res.status(409).json({ error: "project_key 已存在" });
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id 必填" });
      const fields = ["name","description","trigger_type","trigger_event","source_module","category",
        "template_id","tpl_key","sender_key","channels","dedupe_pattern","is_active"];
      const sets = [], vals = [];
      fields.forEach(f => { if (b[f] !== undefined) { vals.push(b[f]); sets.push(`${f}=$${vals.length}`); } });
      if (b.recipient_config !== undefined) { vals.push(JSON.stringify(b.recipient_config)); sets.push(`recipient_config=$${vals.length}`); }
      if (b.context_schema !== undefined) { vals.push(JSON.stringify(b.context_schema)); sets.push(`context_schema=$${vals.length}`); }
      vals.push(user); sets.push(`updated_by=$${vals.length}`);
      sets.push(`updated_at=now()`);
      vals.push(b.id);
      const r = await pool.query(`UPDATE notification_projects SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id 必填" });
      const proj = await pool.query(`SELECT project_key FROM notification_projects WHERE id=$1`, [id]);
      if (proj.rows[0]) {
        const used = await pool.query(`SELECT count(*)::int AS n FROM notification_project_runs WHERE project_key=$1`, [proj.rows[0].project_key]);
        if (used.rows[0].n > 0) return res.status(409).json({ error: `该项目已有 ${used.rows[0].n} 条执行记录，建议改为停用而非删除` });
      }
      await pool.query(`DELETE FROM notification_projects WHERE id=$1`, [id]);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[notification-projects]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
