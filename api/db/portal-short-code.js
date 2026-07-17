import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const BASE_URL = process.env.FWD_PORTAL_SHORT_BASE || "https://ai.sanlyn.cn/kp";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function genRaw() {
  var out = "";
  var bytes = crypto.randomBytes(16);
  for (var i = 0; out.length < 10; i++) {
    if (i >= bytes.length) bytes = crypto.randomBytes(16), i = 0;
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function actor(req) {
  return String((req.user && (req.user.username || req.user.email || req.user.uid || req.user.id)) || "system");
}

function bad(res, status, error) {
  return res.status(status).json({ ok:false, success:false, error:error });
}

async function issue(req, res, pool) {
  var companyId = Number(req.body && req.body.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) return bad(res, 400, "company_id_required");

  const raw = genRaw();
  const hash = rawToHash(raw);
  const meta = { company_id:companyId, purpose:"fwd_portal" };
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at, created_by)
     VALUES ($1, 'fwd_portal', $2::jsonb, '2099-12-31'::timestamptz, '[]'::jsonb, NOW(), $3)`,
    [hash, JSON.stringify(meta), actor(req)]
  );
  return res.status(201).json({
    ok:true,
    success:true,
    code:raw,
    url:BASE_URL + "?c=" + encodeURIComponent(raw),
  });
}

async function revoke(req, res, pool) {
  var body = req.body || {};
  var hash = body.code_hash ? String(body.code_hash).trim() : "";
  if (!hash && body.code) hash = rawToHash(body.code);
  var companyId = Number(body.company_id);
  var all = body.all === true || body.scope === "all";

  var sql;
  var params;
  if (hash) {
    sql = `WHERE token_hash = $1 AND recipient_role = 'fwd_portal'`;
    params = [hash];
  } else if (Number.isInteger(companyId) && companyId > 0 && all) {
    sql = `WHERE recipient_role = 'fwd_portal'
             AND (meta->>'company_id')::int = $1
             AND revoked_at IS NULL`;
    params = [companyId];
  } else {
    return bad(res, 400, "code_hash_or_company_id_all_required");
  }

  var result;
  try {
    result = await pool.query(
      `UPDATE magic_links SET revoked = TRUE, revoked_at = COALESCE(revoked_at, NOW()) ${sql}`,
      params
    );
  } catch (err) {
    if (!/column .*revoked/i.test(err.message || "")) throw err;
    result = await pool.query(
      `UPDATE magic_links SET revoked_at = COALESCE(revoked_at, NOW()) ${sql}`,
      params
    );
  }

  return res.status(200).json({ ok:true, success:true, revoked:result.rowCount || 0 });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return bad(res, 405, "method_not_allowed");
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  if (String(req.query && req.query.action || "").toLowerCase() === "revoke") {
    return revoke(req, res, pool);
  }
  return issue(req, res, pool);
}
