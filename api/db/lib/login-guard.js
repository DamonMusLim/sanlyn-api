// api/db/lib/login-guard.js — 登录防暴力破解（Damon 0926「我们防止网站被破解」）
// 三道闸都按 bucket 算：真实账号用 acct:id，不存在账号用 name:输入值，避免 email/username 分裂计数。
// 先插 pending 再检查锁：并发请求也会被看见；blocked 单独记，避免锁定请求自己续命。
// IP 只认 nginx 写的 X-Real-IP；⛔ 不用 X-Forwarded-For（客户端可以自己塞）。
// 表坏/没迁移时一律 fail-open：防暴力破解坏了，不能变成客户都登不进去。

const WIN_MIN = 15, ACCT_IP_MAX = 8, IP_MAX = 100, IP_BUCKET_MIN = 20, ACCT_HOUR_MAX = 100, TRUST_DAYS = 30;
let lastDisabledLogAt = 0;

export function clientIp(req) {
  const ip = String(req?.headers?.["x-real-ip"] || "").trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) && ip !== "127.0.0.1" && ip !== "::1" ? ip : null;
}

function failOpen(e) {
  const now = Date.now();
  const msg = e?.code ? `${e.code} ${e.message || ""}` : (e?.message || String(e));
  if (now - lastDisabledLogAt > 60000) {
    lastDisabledLogAt = now;
    console.error(`[login-guard] DISABLED: ${msg}`);
  }
  return { disabled: true, message: msg };
}

export function loginBucket(user, input) {
  if (user?.id !== undefined && user?.id !== null) return `acct:${user.id}`;
  return `name:${String(input || "").trim().toLowerCase().slice(0, 120)}`;
}

export async function beginLoginAttempt(pool, bucket, ip) {
  try {
    const r = await pool.query(
      `INSERT INTO auth_login_attempts (bucket, ip, outcome) VALUES ($1,$2,'pending') RETURNING id`,
      [bucket, ip]
    );
    return { id: r.rows[0].id };
  } catch (e) {
    return failOpen(e);
  }
}

export async function finishLoginAttempt(pool, attempt, outcome) {
  if (!attempt?.id) return null;
  try {
    await pool.query(
      `UPDATE auth_login_attempts SET outcome=$2 WHERE id=$1 AND outcome='pending'`,
      [attempt.id, outcome]
    );
    return null;
  } catch (e) {
    return failOpen(e);
  }
}

// 返回 null = 放行；{disabled:true}=防护坏了但放行；否则 { reason, retry_after_s }
export async function checkLoginLock(pool, bucket, ip, attemptId = null) {
  try {
    const r = (await pool.query(`
      WITH last_ok AS (
        SELECT max(at) t FROM auth_login_attempts
         WHERE bucket=$1 AND ip IS NOT DISTINCT FROM $2 AND outcome='ok'
	      ), acct_ip_rows AS (
	        SELECT a.at FROM auth_login_attempts a, last_ok
	         WHERE a.bucket=$1 AND a.ip IS NOT DISTINCT FROM $2
	           AND a.outcome IN ('pending','fail')
	           AND a.at > now() - make_interval(mins => $3)
	           AND (last_ok.t IS NULL OR a.at > last_ok.t)
	           AND ($8::bigint IS NULL OR a.id <> $8)
	         ORDER BY a.at DESC LIMIT $4
	      ), ip_rows AS (
	        SELECT at, bucket FROM auth_login_attempts
	         WHERE $2::text IS NOT NULL AND ip=$2 AND outcome IN ('pending','fail')
	           AND at > now() - make_interval(mins => $3)
	           AND ($8::bigint IS NULL OR id <> $8)
	         ORDER BY at DESC LIMIT $5
	      ), current_trust AS (
        SELECT $2::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM auth_login_attempts
           WHERE bucket=$1 AND ip=$2 AND outcome='ok'
             AND at > now() - make_interval(days => $6)
        ) trusted
	      ), acct_hour_rows AS (
	        SELECT a.at FROM auth_login_attempts a, current_trust ct
	         WHERE NOT ct.trusted AND a.bucket=$1 AND a.outcome IN ('pending','fail')
	           AND a.at > now() - interval '1 hour'
	           AND ($8::bigint IS NULL OR a.id <> $8)
	           AND NOT EXISTS (
	             SELECT 1 FROM auth_login_attempts ok
	              WHERE ok.bucket=a.bucket AND ok.ip IS NOT DISTINCT FROM a.ip AND ok.outcome='ok'
                AND ok.at > now() - make_interval(days => $6)
           )
         ORDER BY a.at DESC LIMIT $7
      )
      SELECT
        (SELECT count(*) FROM acct_ip_rows)::int AS acct_ip,
        (SELECT min(at) FROM acct_ip_rows) AS acct_ip_oldest,
        (SELECT count(*) FROM ip_rows)::int AS ip_fails,
        (SELECT count(DISTINCT bucket) FROM ip_rows)::int AS ip_buckets,
        (SELECT min(at) FROM ip_rows) AS ip_oldest,
        (SELECT trusted FROM current_trust) AS trusted,
        (SELECT count(*) FROM acct_hour_rows)::int AS acct_hour,
        (SELECT min(at) FROM acct_hour_rows) AS acct_hour_oldest`,
	      [bucket, ip, WIN_MIN, ACCT_IP_MAX, IP_MAX, TRUST_DAYS, ACCT_HOUR_MAX, attemptId])).rows[0];
    const left = (oldest, mins) => Math.max(60, Math.ceil((new Date(oldest).getTime() + mins * 60000 - Date.now()) / 1000));
    if (r.acct_ip >= ACCT_IP_MAX) return { reason: "acct_ip", retry_after_s: left(r.acct_ip_oldest, WIN_MIN) };
    if (r.ip_fails >= IP_MAX && r.ip_buckets >= IP_BUCKET_MIN) return { reason: "ip", retry_after_s: left(r.ip_oldest, WIN_MIN) };
    if (!r.trusted && r.acct_hour >= ACCT_HOUR_MAX) return { reason: "acct_untrusted_ip", retry_after_s: left(r.acct_hour_oldest, 60) };
    return null;
  } catch (e) {
    return failOpen(e);
  }
}

export const LOGIN_GUARD_LIMITS = { WIN_MIN, ACCT_IP_MAX, IP_MAX, IP_BUCKET_MIN, ACCT_HOUR_MAX, TRUST_DAYS };
