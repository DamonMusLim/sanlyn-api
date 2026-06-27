// Internal-only endpoint: patch safe fields on shipping_plans
// Auth: X-Internal-Key header must match process.env.INTERNAL_SERVICE_KEY
import { getPool } from "../db.js";
import { timingSafeEqual } from "crypto";

const ALLOWED_FIELDS = new Set([
  "factory_company_id", "trucking_arrange", "trucking_company_id",
  "customs_broker_id", "customs_arrange"
]);

function checkKey(req) {
  const key = process.env.INTERNAL_SERVICE_KEY || "";
  if (!key) return false;
  const provided = String(req.headers["x-internal-key"] || "");
  if (provided.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(key));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!checkKey(req)) return res.status(403).json({ ok: false, error: "forbidden" });

  const { plan_id, fields } = req.body || {};
  if (!plan_id || typeof fields !== "object" || !fields) {
    return res.status(400).json({ ok: false, error: "需要 plan_id 和 fields 对象" });
  }

  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(k)) {
      return res.status(422).json({ ok: false, error: `字段 ${k} 不在许可列表` });
    }
    sets.push(`${k} = $${vals.length + 1}`);
    vals.push(v);
  }
  if (sets.length === 0) return res.status(400).json({ ok: false, error: "fields 为空" });

  sets.push(`updated_at = NOW()`);
  vals.push(plan_id);
  const sql = `UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id, _id`;

  try {
    const pool = getPool();
    const r = await pool.query(sql, vals);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: `plan id=${plan_id} 不存在` });
    return res.status(200).json({ ok: true, plan: r.rows[0], updated: Object.keys(fields) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
