import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getPool, setCors } from "../db.js";
import { checkRateLimit, recordFailure } from "../portal/login-ratelimit.js";

function sha256(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function clean(v, max = 4096) {
  return String(v || "").trim().slice(0, max);
}

function ipOf(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
}

function tokenRateKey(req, tokenHash) {
  return `ip:username:${ipOf(req)}:${tokenHash || "blank-token"}`;
}

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return {}; }
  }
  return meta;
}

async function loadToken(pool, tokenHash, lock = false) {
  const sql =
    `SELECT token_hash, meta, used_at, revoked_at, expires_at
       FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'customer_set_password'
      LIMIT 1` + (lock ? " FOR UPDATE" : "");
  const { rows } = await pool.query(sql, [tokenHash]);
  return rows[0] || null;
}

function tokenIsValid(row) {
  return !!row && !row.used_at && !row.revoked_at && new Date(row.expires_at).getTime() > Date.now();
}

async function handleValidate(req, res, pool) {
  const token = clean(req.query?.token, 256);
  if (!token) return res.status(200).json({ valid: false });
  const row = await loadToken(pool, sha256(token));
  return res.status(200).json({ valid: tokenIsValid(row) });
}

function invalidTokenResponse(row, res) {
  if (!row) return res.status(400).json({ ok: false, error: "invalid_link" });
  return res.status(410).json({ ok: false, error: "expired_or_used_link" });
}

async function handleSetPassword(req, res, pool) {
  const token = clean(req.body?.token, 256);
  const password = String(req.body?.password || "");
  const tokenHash = token ? sha256(token) : "";
  const ipKey = `ip:${ipOf(req)}`;
  const tokenKey = tokenRateKey(req, tokenHash);
  if (checkRateLimit(ipKey) || checkRateLimit(tokenKey)) {
    recordFailure(ipKey);
    recordFailure(tokenKey);
    return res.status(429).json({ ok: false, error: "too_many_attempts" });
  }
  recordFailure(ipKey);
  recordFailure(tokenKey);

  if (!token) return res.status(400).json({ ok: false, error: "token_required" });
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: "password_too_short" });
  }

  const current = await loadToken(pool, tokenHash);
  if (!tokenIsValid(current)) return invalidTokenResponse(current, res);

  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await loadToken(client, tokenHash, true);
    if (!tokenIsValid(row)) {
      await client.query("ROLLBACK");
      return invalidTokenResponse(row, res);
    }

    const meta = parseMeta(row.meta);
    if (!meta.account_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "invalid_link" });
    }

    const upd = await client.query(
      `UPDATE accounts
          SET password = $1,
              is_active = true,
              token_version = COALESCE(token_version, 1) + 1,
              raw = COALESCE(raw, '{}'::jsonb) - 'must_reset_password'
        WHERE id = $2`,
      [passwordHash, meta.account_id]
    );
    if (upd.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "invalid_link" });
    }

    await client.query(
      `UPDATE magic_links
          SET used_at = NOW()
        WHERE token_hash = $1
          AND recipient_role = 'customer_set_password'
          AND used_at IS NULL`,
      [tokenHash]
    );
    await client.query("COMMIT");
    return res.status(200).json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  if (req.method === "GET") return handleValidate(req, res, pool);
  if (req.method === "POST") return handleSetPassword(req, res, pool);
  return res.status(405).json({ ok: false, error: "method_not_allowed" });
}
