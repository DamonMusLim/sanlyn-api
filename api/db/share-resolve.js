// /api/db/share-resolve.js - 短码解析: /s/<code> (nginx rewrite→此) → 查share_links → 铸token → 302跳目标页
import { getPool } from "./db.js";
import { generateToken } from "../auth.js";

function companyCodes(row) {
  if (Array.isArray(row.company_codes) && row.company_codes.length) return row.company_codes;
  if (typeof row.company_codes === "string") { try { const p = JSON.parse(row.company_codes); if (Array.isArray(p) && p.length) return p; } catch {} }
  return row.company_code ? [row.company_code] : [];
}

export default async function handler(req, res) {
  const code = String(req.query?.code || "").trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return res.status(400).send("无效链接");
  const pool = getPool();
  try {
    const s = await pool.query(
      `SELECT sl.id, sl.account_id, sl.path, sl.revoked, sl.expires_at,
              a.username, a.role, a.company, a.company_code, a.company_codes, a.token_version, a.is_active
         FROM share_links sl JOIN accounts a ON a.id = sl.account_id
        WHERE sl.code = $1`, [code]);
    const row = s.rows[0];
    if (!row || row.revoked) return res.status(404).send("链接不存在或已停用");
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(410).send("链接已过期，请联系对接人重新生成");
    if (row.is_active === false) return res.status(403).send("账号已停用");
    const token = generateToken({
      uid: row.account_id, username: row.username, role: row.role, company: row.company,
      companyCode: row.company_code, companyCodes: companyCodes(row), tv: row.token_version || 1,
    });
    pool.query("UPDATE share_links SET hits = hits + 1, last_hit_at = NOW() WHERE id = $1", [row.id]).catch(() => {});
    res.writeHead(302, { Location: row.path + token });
    return res.end();
  } catch (e) {
    return res.status(500).send("解析失败");
  }
}
