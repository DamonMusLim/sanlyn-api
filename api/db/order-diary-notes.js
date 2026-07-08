// api/db/order-diary-notes.js — 订单人工日记备注
// GET    /api/db/order-diary-notes?order_id=123          → 该订单备注列表(内部,含全部visibility)
// POST   /api/db/order-diary-notes { order_id, note_text, note_type, visibility }
// PATCH  /api/db/order-diary-notes/:id { note_text?, visibility?, note_type? }  → 编辑/软删经DELETE
// DELETE /api/db/order-diary-notes/:id  → 软删(deleted_at)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function ensureOrderDiaryNotes(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_diary_notes (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL,
      contract_no TEXT,
      note_text TEXT NOT NULL,
      note_type TEXT DEFAULT 'general',
      visibility TEXT DEFAULT 'internal',
      author_user_id TEXT, author_name TEXT, author_role TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      raw JSONB DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_odn_order ON order_diary_notes(order_id, created_at DESC);
  `).catch(() => {});
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    await ensureOrderDiaryNotes(pool);
    const user = req.user || {};
    const authorName = user.username || user.name || "admin";
    const noteId = req.params && req.params.id;

    if (req.method === "GET") {
      const orderId = req.query.order_id;
      if (!orderId) return res.status(400).json({ error: "order_id 必填" });
      const r = await pool.query(
        `SELECT * FROM order_diary_notes WHERE order_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`, [orderId]);
      return res.json({ success: true, data: r.rows });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.order_id || !b.note_text) return res.status(400).json({ error: "order_id 和 note_text 必填" });
      const r = await pool.query(
        `INSERT INTO order_diary_notes (order_id,contract_no,note_text,note_type,visibility,author_user_id,author_name,author_role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.order_id, b.contract_no || null, b.note_text, b.note_type || "general",
         b.visibility || "internal", user.uid || user.id || null, authorName, user.role || null]);
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      if (!noteId) return res.status(400).json({ error: "id 必填(路径参数)" });
      const b = req.body || {};
      const fields = ["note_text", "note_type", "visibility"];
      const sets = [], vals = [];
      fields.forEach(f => { if (b[f] !== undefined) { vals.push(b[f]); sets.push(`${f}=$${vals.length}`); } });
      if (!sets.length) return res.json({ success: true });
      sets.push(`updated_at=now()`);
      vals.push(noteId);
      const r = await pool.query(`UPDATE order_diary_notes SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
      return res.json({ success: true, data: r.rows[0] });
    }

    if (req.method === "DELETE") {
      if (!noteId) return res.status(400).json({ error: "id 必填(路径参数)" });
      await pool.query(`UPDATE order_diary_notes SET deleted_at=now() WHERE id=$1`, [noteId]);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("[order-diary-notes]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
