/**
 * api/portal/login-ratelimit.js — Portal 登录失败限流
 *
 * 内存滑动窗口仅作为第一层防线：进程重启会清零，多实例之间不共享。
 * 后续如需跨实例统一限流，可将本模块替换为 Redis 等集中式存储。
 */

const WINDOW_MS = 15 * 60 * 1000;
const IP_USERNAME_LIMIT = 6;
const IP_LIMIT = 50;
const MAX_KEYS = 50000;
const IP_USERNAME_PREFIX = 'ip:username:';

const failuresByKey = new Map();

function nowMs() {
  return Date.now();
}

function limitForKey(key) {
  return String(key).startsWith(IP_USERNAME_PREFIX) ? IP_USERNAME_LIMIT : IP_LIMIT;
}

function pruneTimestamps(timestamps, now) {
  const cutoff = now - WINDOW_MS;
  return timestamps.filter(ts => ts > cutoff);
}

function sweep() {
  const now = nowMs();
  for (const [key, timestamps] of failuresByKey) {
    const active = pruneTimestamps(timestamps, now);
    if (active.length === 0) {
      failuresByKey.delete(key);
    } else {
      failuresByKey.set(key, active);
    }
  }
}

const sweepInterval = setInterval(sweep, 5 * 60 * 1000);
sweepInterval.unref?.();

export function checkRateLimit(key) {
  const normalizedKey = String(key || '');
  if (!normalizedKey) return false;

  const now = nowMs();
  const current = failuresByKey.get(normalizedKey) || [];
  const active = pruneTimestamps(current, now);

  if (active.length === 0) {
    failuresByKey.delete(normalizedKey);
    return false;
  }

  failuresByKey.set(normalizedKey, active);
  return active.length >= limitForKey(normalizedKey);
}

export function recordFailure(key) {
  const normalizedKey = String(key || '');
  if (!normalizedKey) return;

  if (!failuresByKey.has(normalizedKey) && failuresByKey.size > MAX_KEYS) {
    sweep();
    // Memory protection tradeoff: fail open for brand-new keys once the cap is still exceeded.
    if (failuresByKey.size > MAX_KEYS) return;
  }

  const now = nowMs();
  const active = pruneTimestamps(failuresByKey.get(normalizedKey) || [], now);
  active.push(now);
  failuresByKey.set(normalizedKey, active);
}

export function resetKey(key) {
  const normalizedKey = String(key || '');
  if (!normalizedKey) return;
  failuresByKey.delete(normalizedKey);
}
