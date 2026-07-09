// 海运单据暂存索引人工确认入口：只确认归属，不写专属业务表。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MAX_BODY = 256 * 1024;

function str(v, max = 500) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : null;
}

function actorFromUser(user) {
  return user?.username || user?.email || user?.account || user?.uid || user?.id || user?.sub || "unknown";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

async function bodyJson(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  }
  return readBody(req);
}

async function confirm(pool, body, user) {
  const intakeId = Number(body.intake_id);
  const planId = body.matched_shipping_plan_id == null || body.matched_shipping_plan_id === ""
    ? null
    : Number(body.matched_shipping_plan_id);
  const orderNo = str(body.matched_order_no, 120);
  if (!intakeId) return { status: 400, json: { ok: false, error: "intake_id required" } };
  if (planId !== null && !Number.isInteger(planId)) return { status: 400, json: { ok: false, error: "matched_shipping_plan_id invalid" } };
  if (!planId && !orderNo) return { status: 400, json: { ok: false, error: "matched_shipping_plan_id or matched_order_no required" } };

  const r = await pool.query(
    `UPDATE ocean_doc_intake
        SET status='confirmed',
            matched_shipping_plan_id=$2,
            matched_order_no=$3,
            confirmed_note=$4,
            confirmed_by=$5,
            confirmed_at=now()
      WHERE id=$1 AND status='pending_review'
      RETURNING id`,
    [intakeId, planId, orderNo, str(body.note, 1000), actorFromUser(user)]
  );
  if (!r.rows.length) return { status: 404, json: { ok: false, error: "pending intake not found" } };
  return { status: 200, json: { ok: true, intake_id: intakeId, status: "confirmed" } };
}

async function reject(pool, body, user) {
  const intakeId = Number(body.intake_id);
  if (!intakeId) return { status: 400, json: { ok: false, error: "intake_id required" } };
  const note = str(body.reason || body.note, 1000);
  const r = await pool.query(
    `UPDATE ocean_doc_intake
        SET status='rejected',
            confirmed_note=$2,
            confirmed_by=$3,
            confirmed_at=now()
      WHERE id=$1 AND status='pending_review'
      RETURNING id`,
    [intakeId, note, actorFromUser(user)]
  );
  if (!r.rows.length) return { status: 404, json: { ok: false, error: "pending intake not found" } };
  return { status: 200, json: { ok: true, intake_id: intakeId, status: "rejected" } };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const action = req.query?.action || "";
  try {
    if (req.method === "GET" && action === "pending") {
      const r = await pool.query(
        `SELECT id, doc_type, confidence, extracted, match_candidates AS candidates,
                matched_shipping_plan_id, matched_order_no, file_url, uploader, created_at
           FROM ocean_doc_intake
          WHERE status='pending_review'
          ORDER BY created_at DESC
          LIMIT 50`
      );
      return res.json({ ok: true, rows: r.rows });
    }

    if (req.method === "POST" && action === "confirm") {
      const result = await confirm(pool, await bodyJson(req), req.user);
      return res.status(result.status).json(result.json);
    }

    if (req.method === "POST" && action === "reject") {
      const result = await reject(pool, await bodyJson(req), req.user);
      return res.status(result.status).json(result.json);
    }

    return res.status(405).json({ ok: false, error: "unsupported action" });
  } catch (e) {
    if (String(e.message).includes("bad json")) return res.status(400).json({ ok: false, error: "bad json" });
    if (String(e.message).includes("too large")) return res.status(413).json({ ok: false, error: "body too large" });
    console.error("[ocean-doc-review]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}
