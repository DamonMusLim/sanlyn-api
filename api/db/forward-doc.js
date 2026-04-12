// api/db/forward-doc.js — S94: 文件转发记录 API
//
// POST /api/db/forward-doc
//   { from, fromRole, to, documentKey, documentName, documentUrl, contractNo, note }
//   → 写入 doc_forwards 表
//
// GET /api/db/forward-doc
//   ?to=finance        → 查看转给某角色的记录
//   ?from=username     → 查看某人发出的记录
//   ?contract=xxx      → 按合同号
//   ?status=pending|done → 按处理状态

import { getPool, setCors } from "../db.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS doc_forwards (
    id SERIAL PRIMARY KEY,
    from_user VARCHAR(100),
    from_role VARCHAR(50),
    to_target VARCHAR(100),
    document_key VARCHAR(50),
    document_name VARCHAR(200),
    document_url TEXT,
    contract_no VARCHAR(100),
    note TEXT DEFAULT '',
    status VARCHAR(20) DEFAULT 'pending',
    handled_by VARCHAR(100),
    handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // 确保表存在
  try {
    await pool.query(CREATE_TABLE_SQL);
  } catch (e) {
    // 表已存在则忽略
  }

  // ═══ GET: 查询转发记录 ═══
  if (req.method === "GET") {
    try {
      const { to, from, contract, status } = req.query;
      let sql = "SELECT * FROM doc_forwards";
      const vals = [];
      const conds = [];

      if (to) { vals.push(to); conds.push("to_target = $" + vals.length); }
      if (from) { vals.push(from); conds.push("from_user = $" + vals.length); }
      if (contract) { vals.push(contract); conds.push("contract_no = $" + vals.length); }
      if (status) { vals.push(status); conds.push("status = $" + vals.length); }

      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      sql += " ORDER BY created_at DESC LIMIT 200";

      const result = await pool.query(sql, vals);
      return res.status(200).json({ success: true, data: result.rows, count: result.rows.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ═══ POST: 创建转发记录 / 标记已处理 ═══
  if (req.method === "POST") {
    try {
      const body = req.body || {};

      // 标记已处理
      if (body.action === "handle" && body.id) {
        const result = await pool.query(
          "UPDATE doc_forwards SET status = 'done', handled_by = $1, handled_at = NOW() WHERE id = $2 RETURNING *",
          [body.handled_by || "unknown", body.id]
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ success: false, error: "Record not found" });
        }
        return res.status(200).json({ success: true, data: result.rows[0] });
      }

      // 创建转发记录
      const { from, fromRole, to, documentKey, documentName, documentUrl, contractNo, note } = body;
      if (!to) {
        return res.status(400).json({ success: false, error: "to (target) required" });
      }

      const result = await pool.query(
        `INSERT INTO doc_forwards (from_user, from_role, to_target, document_key, document_name, document_url, contract_no, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [from || "unknown", fromRole || "unknown", to, documentKey || "", documentName || "", documentUrl || "", contractNo || "", note || ""]
      );

      return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
