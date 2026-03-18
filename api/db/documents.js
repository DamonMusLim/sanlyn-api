import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { contract_no, limit = 500 } = req.query;
    let query = "SELECT * FROM documents", params = [], conds = [];
    if (contract_no) { params.push(contract_no); conds.push(`contract_no = $${params.length}`); }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const result = await pool.query(query, params);
    return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    // 表不存在时从OSS fallback
    if (err.message.includes("does not exist")) {
      try {
        const r = await fetch("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/documents.json");
        const d = await r.json();
        const list = d.documents || d || [];
        return res.status(200).json({ success: true, data: list, count: list.length, source: "oss" });
      } catch(ossErr) {
        return res.status(200).json({ success: true, data: [], count: 0 });
      }
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}
