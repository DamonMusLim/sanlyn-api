// /api/db/auth-login.js — Login endpoint, returns JWT token
// POST { username, password } → { token, user }
// GET with valid token → { user } (token verify/refresh)
import { getPool, setCors } from "../db.js";
import { generateToken, extractUser } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();

  // ── GET: verify/refresh token ──
  if (req.method === "GET") {
    extractUser(req);
    if (!req.user) return res.status(401).json({ error: "Invalid token" });

    try {
      var acct = await pool.query(
        "SELECT id, username, role, company_code, company_codes FROM accounts WHERE id = $1 OR username = $2 LIMIT 1",
        [req.user.uid, req.user.username]
      );
      if (!acct.rows[0]) return res.status(401).json({ error: "Account not found" });
      var u = acct.rows[0];
      var companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : (u.company_code ? [u.company_code] : []);

      var newToken = generateToken({
        uid: u.id, username: u.username, role: u.role,
        companyCode: u.company_code, companyCodes: companyCodes
      });

      return res.status(200).json({ success: true, token: newToken, user: {
        uid: u.id, username: u.username, role: u.role,
        companyCode: u.company_code, companyCodes: companyCodes
      }});
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: login ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username 和 password 必填" });

    var result = await pool.query(
      "SELECT id, username, password, role, company_code, company_codes FROM accounts WHERE username = $1 LIMIT 1",
      [username.trim()]
    );

    if (!result.rows[0]) return res.status(401).json({ error: "账号不存在" });
    var u = result.rows[0];

    if (u.password !== password) return res.status(401).json({ error: "密码错误" });

    var companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : (u.company_code ? [u.company_code] : []);

    var token = generateToken({
      uid: u.id, username: u.username, role: u.role,
      companyCode: u.company_code, companyCodes: companyCodes
    });

    return res.status(200).json({
      success: true, token: token,
      user: {
        uid: u.id, username: u.username, role: u.role,
        companyCode: u.company_code, companyCodes: companyCodes
      }
    });
  } catch (err) {
    console.error("[auth-login]", err);
    return res.status(500).json({ error: err.message });
  }
}
