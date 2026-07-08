// brief-notes.js — 长文落库+登录后查看（"卡片+网页全文"模式的存储端）
// POST: 内部secret(TASK_INGEST_SECRET)写入全文 → 返回{id}
// GET ?id=: 需JWT(自行verify,本端点mount在authMiddleware之前)且admin角色 → 返回全文
import { getPool, setCors } from "./db.js";
import { extractUser } from "./auth.js";

function readSecret(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ") && auth.length > 100) return ""; // JWT走extractUser,不当secret
  return req.headers["x-task-ingest-secret"] || "";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Task-Ingest-Secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  if (req.method === "POST") {
    const expected = process.env.TASK_INGEST_SECRET;
    if (!expected || readSecret(req) !== expected) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    const { kind, title, content } = req.body || {};
    if (!content) return res.status(400).json({ success: false, error: "content required" });
    const r = await pool.query(
      "INSERT INTO brief_notes (kind, title, content) VALUES ($1, $2, $3) RETURNING id",
      [String(kind || "brief").slice(0, 40), String(title || "").slice(0, 200), String(content).slice(0, 20000)]
    );
    return res.status(200).json({ success: true, id: r.rows[0].id });
  }

  if (req.method === "GET") {
    const user = extractUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized", message: "请先登录" });
    if (user.role !== "admin") return res.status(403).json({ error: "Forbidden", message: "仅管理员可看" });
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ success: false, error: "id required" });
    const r = await pool.query("SELECT id, kind, title, content, created_at FROM brief_notes WHERE id=$1", [id]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, error: "not found" });
    return res.status(200).json({ success: true, note: r.rows[0] });
  }

  return res.status(405).json({ success: false, error: "GET/POST only" });
}
