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

// P0根治配套(2026-07-18): 签 kp 链时自动 ensure forwarder_portal_tokens 行存在,
// secret 用 crypto 强生成(48hex/192bit),彻底不依赖表上那个弱 md5 DEFAULT,也免手动insert。
// code(slug)=纯URL标签,新货代给个短随机串即可(货代经 kp 跳转进门户,从不手打 slug)。
async function ensureForwarderToken(pool, companyId) {
  var existing = await pool.query(
    `SELECT code, secret FROM forwarder_portal_tokens
       WHERE company_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC LIMIT 1`, [companyId]);
  if (existing.rows.length && existing.rows[0].secret) return existing.rows[0];
  var secret = crypto.randomBytes(24).toString("hex");
  if (existing.rows.length) {
    // 旧行缺 secret → 补上(不动 slug)
    await pool.query(`UPDATE forwarder_portal_tokens SET secret=$1 WHERE code=$2`,
      [secret, existing.rows[0].code]);
    return { code: existing.rows[0].code, secret: secret };
  }
  // 建新行:slug 短随机(唯一,PK),撞了重试几次
  var co = await pool.query(`SELECT name_cn FROM companies WHERE id=$1 LIMIT 1`, [companyId]);
  var coName = (co.rows[0] && co.rows[0].name_cn) || ("company-" + companyId);
  for (var attempt = 0; attempt < 5; attempt++) {
    var slug = crypto.randomBytes(6).toString("hex"); // 12 hex 标签
    try {
      await pool.query(
        `INSERT INTO forwarder_portal_tokens (code, forwarder_co, company_id, secret, expires_at, created_at)
         VALUES ($1, $2, $3, $4, '2099-12-31'::timestamptz, NOW())`,
        [slug, coName, companyId, secret]);
      return { code: slug, secret: secret };
    } catch (e) {
      if (!/duplicate|unique/i.test(e.message || "")) throw e;
    }
  }
  throw new Error("ensureForwarderToken: slug 连续撞车");
}

async function issue(req, res, pool) {
  var companyId = Number(req.body && req.body.company_id);
  if (!Number.isInteger(companyId) || companyId <= 0) return bad(res, 400, "company_id_required");

  // 先确保该公司有 forwarder_portal_tokens 行(带强 secret),否则 kp 跳转会 410
  await ensureForwarderToken(pool, companyId);

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
