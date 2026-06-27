// GET  /api/db/doc-column-config?type=pl   → 返回该类型所有列定义（按 sort_order）
// PUT  /api/db/doc-column-config           → body: [{doc_type,col_key,label,visible,col_width,col_align}]

import { getPool } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;   // 登录即可查；PUT 额外要求 admin
  const pool = getPool();
  const { type } = req.query;

  if (req.method === "GET") {
    if (!type) return res.status(400).json({ error: "type required" });
    const r = await pool.query(
      "SELECT col_key, label, visible, col_width, col_align, sort_order FROM doc_column_config WHERE doc_type=$1 ORDER BY sort_order, id",
      [type]
    );
    return res.json({ doc_type: type, columns: r.rows });
  }

  if (req.method === "PUT") {
    if (!requireRole(req, res, ["admin"])) return;
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "body must be array" });
    for (const row of rows) {
      const { doc_type, col_key, label, visible, col_width, col_align, sort_order } = row;
      if (!doc_type || !col_key) continue;
      await pool.query(
        `INSERT INTO doc_column_config (doc_type, col_key, label, visible, col_width, col_align, sort_order, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (doc_type, col_key) DO UPDATE SET
           label=EXCLUDED.label, visible=EXCLUDED.visible,
           col_width=EXCLUDED.col_width, col_align=EXCLUDED.col_align,
           sort_order=EXCLUDED.sort_order, updated_at=NOW()`,
        [doc_type, col_key, label ?? col_key, visible ?? true, col_width ?? null, col_align ?? "", sort_order ?? 0]
      );
    }
    // Invalidate in-process cache on next document render (documents.js will re-fetch)
    return res.json({ ok: true, updated: rows.length });
  }

  res.status(405).json({ error: "method not allowed" });
}
