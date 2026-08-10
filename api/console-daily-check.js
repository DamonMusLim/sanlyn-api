// api/console-daily-check.js - loopback-only watchdog status for mini.
import { getPool, setCors } from "./db.js";

const MAX_DAYS = 14;

function firstForwardedFor(req) {
  return String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
}

function remoteAddress(req) {
  return String(req.socket?.remoteAddress || req.ip || "").trim();
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "";
}

function allowLoopbackOnly(req) {
  const forwarded = firstForwardedFor(req);
  return forwarded ? isLoopback(forwarded) : isLoopback(remoteAddress(req));
}

function yyyyMmDdInShanghai(value) {
  const d = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function normalizeState(status) {
  const s = String(status || "ok").toLowerCase();
  return s === "crit" || s === "warn" || s === "idle" ? s : "ok";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "method not allowed" });
  if (!allowLoopbackOnly(req)) return res.status(403).json({ success: false, error: "loopback only" });

  const rawDays = Number.parseInt(String(req.query?.days || "3"), 10);
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 3, 1), MAX_DAYS);
  const pool = getPool();

  try {
    const { rows } = await pool.query(
      `SELECT job_key, name, machine, schedule, category, status, message,
              last_run, updated_at
         FROM automation_heartbeats
        WHERE COALESCE(last_run, updated_at) >= now() - ($1::int * interval '1 day')
        ORDER BY COALESCE(last_run, updated_at) DESC, job_key`,
      [days]
    );

    const latest = rows.map((r) => ({
      job_key: r.job_key,
      name: r.name || r.job_key,
      machine: r.machine || "",
      schedule: r.schedule || "",
      category: r.category || "",
      state: normalizeState(r.status),
      status: r.status || "ok",
      message: r.message || "",
      last_run: r.last_run || r.updated_at,
    }));

    const byDay = {};
    for (const row of latest) {
      const day = yyyyMmDdInShanghai(row.last_run);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(row);
    }

    return res.status(200).json({
      success: true,
      today: yyyyMmDdInShanghai(new Date()),
      days,
      latest,
      by_day: byDay,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
