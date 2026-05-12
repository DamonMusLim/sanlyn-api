// /api/db/auth-login.js — Login endpoint, returns JWT token
// POST { username, password } → { token, user }
// GET with valid token → { user } (token verify/refresh)
import { getPool, setCors } from "../db.js";
import { generateToken, extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";
import bcrypt from "bcryptjs";

// ── compat: supports both legacy plaintext and bcrypt hashed passwords ──
// If stored value starts with "$2b$" it is a bcrypt hash → use bcrypt.compare
// Otherwise fall back to plain equality and auto-upgrade the stored value on success
// Returns { ok: boolean, upgraded: boolean }
async function verifyPassword(pool, userId, inputPlain, storedValue) {
  if (storedValue && (storedValue.startsWith("$2b$") || storedValue.startsWith("$2a$"))) {
    const ok = await bcrypt.compare(inputPlain, storedValue);
    return { ok, upgraded: false };
  }
  // plaintext path — auto-upgrade to bcrypt on first successful login
  if (inputPlain !== storedValue) return { ok: false, upgraded: false };
  const hash = await bcrypt.hash(inputPlain, 12);
  await pool.query(
    "UPDATE accounts SET password = $1, updated_at = NOW() WHERE id = $2",
    [hash, userId]
  );
  return { ok: true, upgraded: true };
}

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
        "SELECT id, username, role, company, supplier_role, company_code, company_codes, raw FROM accounts WHERE id = $1 OR username = $2 LIMIT 1",
        [req.user.uid, req.user.username]
      );
      if (!acct.rows[0]) return res.status(401).json({ error: "Account not found" });
      var u = acct.rows[0];
      var companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : (u.company_code ? [u.company_code] : []);
      var rawObj = u.raw || {};
      if (typeof rawObj === "string") { try { rawObj = JSON.parse(rawObj); } catch { rawObj = {}; } }
      var access = Array.isArray(rawObj.access) ? rawObj.access : [];

      var newToken = generateToken({
        uid: u.id, username: u.username, role: u.role,
        company: u.company, supplierRole: u.supplier_role,
        companyCode: u.company_code, companyCodes: companyCodes,
        access: access
      });

      return res.status(200).json({ success: true, token: newToken, user: {
        uid: u.id, username: u.username, role: u.role,
        company: u.company, supplierRole: u.supplier_role,
        companyCode: u.company_code, companyCodes: companyCodes,
        access: access
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
      "SELECT id, username, password, role, company, supplier_role, company_code, company_codes, raw FROM accounts WHERE username = $1 LIMIT 1",
      [username.trim()]
    );

    if (!result.rows[0]) return res.status(401).json({ error: "账号不存在" });
    var u = result.rows[0];

    const { ok: passwordOk, upgraded } = await verifyPassword(pool, u.id, password, u.password);

    if (!passwordOk) {
      // 登录失败审计
      writeAudit(pool, req, {
        action: "account.login_failed",
        entity_type: "account",
        entity_id: u.id,
        diff_summary: `login failed for username=${u.username}`,
        detail: { username: u.username, role: u.role },
      }).catch(() => {});
      return res.status(401).json({ error: "密码错误" });
    }

    // 明文→bcrypt 自动升级日志
    if (upgraded) {
      writeAudit(pool, req, {
        action: "account.password_auto_upgraded",
        entity_type: "account",
        entity_id: u.id,
        diff_summary: "plaintext password auto-upgraded to bcrypt on login",
        detail: { username: u.username, note: "legacy plaintext → bcrypt hash" },
      }).catch(() => {});
    }

    var companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : (u.company_code ? [u.company_code] : []);
    // access list lives in accounts.raw.access (JSONB). Used for fine-grained
    // permission checks like Pay Balance button visibility.
    var rawObj = u.raw || {};
    if (typeof rawObj === "string") { try { rawObj = JSON.parse(rawObj); } catch { rawObj = {}; } }
    var access = Array.isArray(rawObj.access) ? rawObj.access : [];

    var token = generateToken({
      uid: u.id, username: u.username, role: u.role,
      company: u.company, supplierRole: u.supplier_role,
      companyCode: u.company_code, companyCodes: companyCodes,
      access: access
    });

    // 登录成功审计
    writeAudit(pool, req, {
      action: "account.login",
      entity_type: "account",
      entity_id: u.id,
      diff_summary: `login success: ${u.username} (${u.role})`,
      detail: { username: u.username, role: u.role, company: u.company },
    }).catch(() => {});

    return res.status(200).json({
      success: true, token: token,
      user: {
        uid: u.id, username: u.username, role: u.role,
        company: u.company, supplierRole: u.supplier_role,
        companyCode: u.company_code, companyCodes: companyCodes,
        access: access
      }
    });
  } catch (err) {
    console.error("[auth-login]", err);
    return res.status(500).json({ error: err.message });
  }
}
