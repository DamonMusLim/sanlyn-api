// /api/db/auth-login.js — Login endpoint, returns JWT token
// POST { email, password } → { token, user }
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

    // Refresh token with latest account data
    try {
      var acct = await pool.query(
        "SELECT _id, email, name, role, company_code, company_codes, company_name_cn, company_name_en, status FROM accounts WHERE _id = $1 OR email = $2 LIMIT 1",
        [req.user.uid, req.user.email]
      );
      if (!acct.rows[0]) return res.status(401).json({ error: "Account not found" });
      var u = acct.rows[0];
      if (u.status !== "active") return res.status(403).json({ error: "账号已停用" });
      var companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : null;
      if (!companyCodes && u.company_code) {
        try {
          var custRow2 = await pool.query("SELECT company_codes FROM customers WHERE company_code = $1 LIMIT 1", [u.company_code]);
          var cc2 = custRow2.rows[0]?.company_codes;
          companyCodes = (cc2 && cc2.length) ? cc2 : [u.company_code];
        } catch(e) { companyCodes = [u.company_code]; }
      }
      if (!companyCodes) companyCodes = [];

      var newToken = generateToken({
        uid: u._id, email: u.email, name: u.name, role: u.role,
        companyCode: u.company_code, companyCodes: companyCodes, companyNameCN: u.company_name_cn, companyNameEN: u.company_name_en
      });

      return res.status(200).json({ success: true, token: newToken, user: {
        uid: u._id, email: u.email, name: u.name, role: u.role,
        companyCode: u.company_code, companyCodes: companyCodes, companyNameCN: u.company_name_cn
      }});
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: login ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "邮箱和密码必填" });

    // Find account by email or username
    var loginVal = email.toLowerCase().trim();
    var result = await pool.query(
      "SELECT _id, email, name, role, password, company_code, company_codes, company_name_cn, company_name_en, status FROM accounts WHERE email = $1 OR username = $1 LIMIT 1",
      [loginVal]
    );

    if (!result.rows[0]) return res.status(401).json({ error: "账号不存在" });
    var u = result.rows[0];
    if (u.status !== "active") return res.status(403).json({ error: "账号已停用" });

    // Simple password check (plaintext for now — upgrade to bcrypt later)
    if (u.password !== password) return res.status(401).json({ error: "密码错误" });

    // If account has no company_codes, look up from customers table
    var companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : null;
    if (!companyCodes && u.company_code) {
      try {
        var custRow = await pool.query("SELECT company_codes FROM customers WHERE company_code = $1 LIMIT 1", [u.company_code]);
        var cc = custRow.rows[0]?.company_codes;
        companyCodes = (cc && cc.length) ? cc : [u.company_code];
      } catch(e) { companyCodes = [u.company_code]; }
    }
    if (!companyCodes) companyCodes = [];

    // Generate token
    var token = generateToken({
      uid: u._id, email: u.email, name: u.name, role: u.role,
      companyCode: u.company_code, companyCodes: companyCodes, companyNameCN: u.company_name_cn, companyNameEN: u.company_name_en
    });

    return res.status(200).json({
      success: true, token: token,
      user: {
        uid: u._id, email: u.email, name: u.name, role: u.role,
        companyCode: u.company_code, companyCodes: companyCodes, companyNameCN: u.company_name_cn
      }
    });
  } catch (err) {
    console.error("[auth-login]", err);
    return res.status(500).json({ error: err.message });
  }
}
