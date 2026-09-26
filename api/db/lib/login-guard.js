// api/db/lib/login-guard.js — 登录防暴力破解（Damon 0926「我们防止网站被破解」）
// 三道闸，全部按「最近失败次数」算，不改 accounts 表、不需要人工解锁（时间到自动放开）：
//   ① 同一账号 + 同一 IP：15 分钟内错 5 次 → 锁 15 分钟        （挡单点猜密码）
//   ② 同一 IP：15 分钟内错 20 次（不管试哪个账号）→ 锁 15 分钟  （挡一个 IP 撞一堆账号）
//   ③ 同一账号：1 小时内从【陌生 IP】错 30 次 → 陌生 IP 锁 1 小时 （挡换 IP 分布式猜）
//      「陌生」= 30 天内没从这个 IP 成功登录过这个账号；常用 IP 不受③影响，免得别人故意输错把你锁在门外
// IP 只认 nginx 写的 X-Real-IP（=$remote_addr，客户端伪造不了）；⛔ 不用 X-Forwarded-For 第一段（客户端可以自己塞）。
// 拿不到真实 IP（直连 127.0.0.1）时只走 ① 的账号维度，不做 IP 维度，免得所有人共用一个 IP 被一起锁。

const WIN_MIN = 15, ACCT_IP_MAX = 5, IP_MAX = 20, ACCT_HOUR_MAX = 30, TRUST_DAYS = 30;

export function clientIp(req) {
  const ip = String(req?.headers?.["x-real-ip"] || "").trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) && ip !== "127.0.0.1" && ip !== "::1" ? ip : null;
}

let ensured = null;
function ensureTable(pool) {
  // 表不在就建（部署时也会跑迁移；这里兜底，防迁移漏跑时登录直接 500）
  ensured ||= pool.query(`
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      id bigserial PRIMARY KEY, username text NOT NULL, ip text, ok boolean NOT NULL, at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS auth_login_attempts_user_at ON auth_login_attempts (username, at DESC);
    CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_at   ON auth_login_attempts (ip, at DESC) WHERE ip IS NOT NULL;`)
    .catch((e) => { ensured = null; throw e; });
  return ensured;
}

// 返回 null = 放行；否则 { reason, retry_after_s }
// ⛔ 计数表出任何问题都【放行】（记日志）——防暴力破解坏了，不能变成谁都登不进去
export async function checkLoginLock(pool, username, ip) {
  try { return await checkLoginLockInner(pool, username, ip); }
  catch (e) { console.error("[login-guard] check failed, fail-open:", e.message); return null; }
}
async function checkLoginLockInner(pool, username, ip) {
  await ensureTable(pool);
  const u = String(username || "").trim().toLowerCase();
  const r = (await pool.query(`
    WITH last_ok AS (
      SELECT max(at) t FROM auth_login_attempts WHERE username=$1 AND ip IS NOT DISTINCT FROM $2 AND ok)
    SELECT
      (SELECT count(*) FROM auth_login_attempts a, last_ok
        WHERE a.username=$1 AND a.ip IS NOT DISTINCT FROM $2 AND NOT a.ok
          AND a.at > now() - make_interval(mins => $3) AND (last_ok.t IS NULL OR a.at > last_ok.t))::int AS acct_ip,
      (SELECT min(at) FROM (SELECT at FROM auth_login_attempts a, last_ok
        WHERE a.username=$1 AND a.ip IS NOT DISTINCT FROM $2 AND NOT a.ok
          AND a.at > now() - make_interval(mins => $3) AND (last_ok.t IS NULL OR a.at > last_ok.t)
        ORDER BY at DESC LIMIT $4) x) AS acct_ip_oldest,
      CASE WHEN $2::text IS NULL THEN 0 ELSE (SELECT count(*) FROM auth_login_attempts
        WHERE ip=$2 AND NOT ok AND at > now() - make_interval(mins => $3)) END::int AS ip_fails,
      CASE WHEN $2::text IS NULL THEN true ELSE EXISTS (SELECT 1 FROM auth_login_attempts
        WHERE username=$1 AND ip=$2 AND ok AND at > now() - make_interval(days => $5)) END AS trusted,
      (SELECT count(*) FROM auth_login_attempts
        WHERE username=$1 AND NOT ok AND at > now() - interval '1 hour')::int AS acct_hour`,
    [u, ip, WIN_MIN, ACCT_IP_MAX, TRUST_DAYS])).rows[0];
  const left = (oldest, mins) => Math.max(60, Math.ceil((new Date(oldest).getTime() + mins * 60000 - Date.now()) / 1000));
  if (r.acct_ip >= ACCT_IP_MAX) return { reason: "acct_ip", retry_after_s: left(r.acct_ip_oldest, WIN_MIN) };
  if (r.ip_fails >= IP_MAX) return { reason: "ip", retry_after_s: WIN_MIN * 60 };
  if (!r.trusted && r.acct_hour >= ACCT_HOUR_MAX) return { reason: "acct_untrusted_ip", retry_after_s: 3600 };
  return null;
}

export async function recordLoginAttempt(pool, username, ip, ok) {
  try {
    await ensureTable(pool);
    await pool.query(`INSERT INTO auth_login_attempts (username, ip, ok) VALUES ($1,$2,$3)`,
      [String(username || "").trim().toLowerCase().slice(0, 120), ip, !!ok]);
    // 顺手清 60 天前的记录（信任 IP 只看 30 天），约每 200 次登录清一次
    if (Math.random() < 0.005) await pool.query(`DELETE FROM auth_login_attempts WHERE at < now() - interval '60 days'`);
  } catch (e) { console.error("[login-guard] record failed:", e.message); }
}

export const LOGIN_GUARD_LIMITS = { WIN_MIN, ACCT_IP_MAX, IP_MAX, ACCT_HOUR_MAX, TRUST_DAYS };
