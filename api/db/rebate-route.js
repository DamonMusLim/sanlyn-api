import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { handleCustomsImport } from "./rebate-customs-import.js";
import { handleMatch, previewRebateMatching } from "./rebate-matching.js";
import { handleGenerate } from "./rebate-export.js";

const ROLES = new Set(["admin", "finance"]);

function ym(v) {
  const s = String(v || "").replace(/[^0-9]/g, "");
  if (!/^\d{6}$/.test(s)) throw new Error("declare_ym must be YYYYMM");
  return s;
}

function batch(v) {
  return String(v || "001").replace(/[^0-9]/g, "").padStart(3, "0").slice(-3);
}

export function guard(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return null;
  }
  if (!requireAuth(req, res)) return null;
  if (!ROLES.has(req.user?.role)) {
    res.status(403).json({ error: "仅财务/管理员可操作" });
    return null;
  }
  return getPool();
}

export async function batches(req, res, pool) {
  if (req.method === "GET") {
    const declareYm = req.query.declare_ym ? ym(req.query.declare_ym) : null;
    const r = await pool.query(
      `SELECT * FROM rebate_batches
       ${declareYm ? "WHERE declare_ym=$1" : ""}
       ORDER BY declare_ym DESC, declare_batch DESC
       LIMIT 200`,
      declareYm ? [declareYm] : []
    );
    return res.json({ success: true, batches: r.rows });
  }
  if (req.method === "POST") {
    const r = await pool.query(
      `INSERT INTO rebate_batches(declare_ym,declare_batch,status,updated_at)
       VALUES ($1,$2,'draft',now())
       ON CONFLICT (declare_ym,declare_batch) DO UPDATE SET updated_at=now()
       RETURNING *`,
      [ym(req.body?.declare_ym), batch(req.body?.declare_batch)]
    );
    return res.json({ success: true, batch: r.rows[0] });
  }
  return res.status(405).json({ error: "GET/POST only" });
}

export async function customsImport(req, res, pool) {
  return handleCustomsImport(req, res, pool);
}

export async function match(req, res, pool) {
  return handleMatch(req, res, pool, req.query.id);
}

export async function preview(req, res, pool) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  return res.json(await previewRebateMatching(pool, req.query.id));
}

export async function generate(req, res, pool) {
  return handleGenerate(req, res, pool, req.query.id);
}

export function wrap(fn) {
  return async function handler(req, res) {
    const pool = guard(req, res);
    if (!pool) return;
    try {
      return await fn(req, res, pool);
    } catch (e) {
      console.error("[rebate]", e);
      return res.status(500).json({ error: e.message });
    }
  };
}

function rebatePath(req) {
  return String(req.path || "").replace(/^\/api\/db\/rebate\/?/, "/").replace(/\/+$/, "") || "/";
}

function setPathId(req, id) {
  req.query = { ...(req.query || {}), id };
}

export default async function rebateRouter(req, res) {
  const pool = guard(req, res);
  if (!pool) return;
  try {
    const p = rebatePath(req);
    if (p === "/batches") return batches(req, res, pool);
    if (p === "/customs-import") return customsImport(req, res, pool);

    const m = p.match(/^\/batches\/([^/]+)\/(match|preview|generate)$/);
    if (m) {
      setPathId(req, m[1]);
      if (m[2] === "match") return match(req, res, pool);
      if (m[2] === "preview") return preview(req, res, pool);
      return generate(req, res, pool);
    }

    if (p === "/match") return match(req, res, pool);
    if (p === "/preview") return preview(req, res, pool);
    if (p === "/generate") return generate(req, res, pool);
    return res.status(404).json({ error: "rebate route not found" });
  } catch (e) {
    console.error("[rebate]", e);
    return res.status(500).json({ error: e.message });
  }
}
