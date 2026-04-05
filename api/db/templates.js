// ══════════════════════════════════════════════════════════
// /api/db/templates — S98: 模板资源管理 CRUD
// GET    → 获取所有模板
// POST   → 创建新模板
// PATCH  → 更新模板（重命名/改分类）
// DELETE → 删除模板
// ══════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(256) NOT NULL,
  category VARCHAR(64) DEFAULT 'other',
  file_name VARCHAR(512),
  file_url TEXT NOT NULL,
  file_size BIGINT DEFAULT 0,
  uploaded_by VARCHAR(64) DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
`;

let inited = false;
async function ensureTable(pool) {
  if (inited) return;
  try { await pool.query(INIT_SQL); inited = true; } catch (e) { console.warn("[templates] init:", e.message); inited = true; }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  await ensureTable(pool);

  try {
    // ── GET: list all active templates ──
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT * FROM templates WHERE is_active = TRUE ORDER BY created_at DESC"
      );
      return res.json({ success: true, templates: rows });
    }

    // ── POST: create new template ──
    if (req.method === "POST") {
      const { name, category, file_name, file_url, file_size, uploaded_by } = req.body || {};
      if (!file_url) return res.status(400).json({ success: false, error: "file_url required" });

      const { rows } = await pool.query(
        `INSERT INTO templates (name, category, file_name, file_url, file_size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name || file_name || "Untitled", category || "other", file_name || "", file_url, file_size || 0, uploaded_by || ""]
      );
      return res.json({ success: true, template: rows[0] });
    }

    // ── PATCH: update template (rename / re-categorize) ──
    if (req.method === "PATCH") {
      const { id, name, category } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: "id required" });

      const sets = [];
      const vals = [];
      let idx = 1;
      if (name !== undefined) { sets.push("name = $" + idx); vals.push(name); idx++; }
      if (category !== undefined) { sets.push("category = $" + idx); vals.push(category); idx++; }
      sets.push("updated_at = NOW()");

      if (sets.length <= 1) return res.json({ success: true, message: "nothing to update" });

      vals.push(id);
      const sql = "UPDATE templates SET " + sets.join(", ") + " WHERE id = $" + idx;
      await pool.query(sql, vals);
      return res.json({ success: true });
    }

    // ── DELETE: soft-delete template ──
    if (req.method === "DELETE") {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: "id required" });

      await pool.query("UPDATE templates SET is_active = FALSE, updated_at = NOW() WHERE id = $1", [id]);
      return res.json({ success: true });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[templates]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
