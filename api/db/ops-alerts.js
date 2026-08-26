// GET/POST/DELETE /api/db/ops-alerts — 操作预警面板数据源 + 忽略留痕
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// fill_rate is a percentage, e.g. 97.4 means 97.4%.
const MIN_FILL_RATE = 80;
const IGNORE_CODE = "ALERT_IGNORED";
const IGNORE_TABLE = "ops_alerts";
const NODES = [
  ["booking", "待订舱", "booking_sent_at", "订舱发送时间有人写入后，此处自动生效。"],
  ["allocation", "待配舱", "booking_no", "订舱号稳定写入后，此处自动生效。"],
  ["signing", "待签单", "bl_no", "BL 号缺失即待签单。"],
  ["customs", "待报关", "so_no", "SO 号稳定写入后，此处自动生效。"],
  ["transport", "待运输", "factory_dispatch_confirmed_at", "工厂发运确认时间有人写入后，此处自动生效。"],
  ["release", "待换单", "telex_released_at", "电放/换单释放时间有人写入后，此处自动生效。"],
];

function pct(filled, total) {
  if (!total) return null;
  return Math.round((Number(filled || 0) * 1000) / Number(total)) / 10;
}

function basis(field, filled, total, note) {
  return { field, filled: Number(filled || 0), total: Number(total || 0), fill_rate: pct(filled, total), note };
}

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function actorFrom(req) {
  const u = req.user || {};
  return clean(u.employee_code || u.staff_no || u.username || u.account || u.email || u.uid || u.id || u.sub || u.name || "unknown", 120);
}

function targetId(key, id) {
  return clean(key, 80) + ":" + clean(id, 160);
}

async function ignoredTargets(pool) {
  const r = await pool.query(
    `SELECT target_id FROM operation_todos
      WHERE check_code=$1 AND target_table=$2 AND status='resolved'`,
    [IGNORE_CODE, IGNORE_TABLE]
  );
  return new Set(r.rows.map((x) => String(x.target_id || "")));
}

function makeNode(meta, stats, rows, ignored = new Set()) {
  const [key, title, field, note] = meta;
  const filled = stats[field] || 0;
  const b = basis(field, filled, stats.total, note);
  const ready = b.fill_rate !== null && b.fill_rate >= MIN_FILL_RATE;
  if (!ready) return { key, title, state: "no_data", count: null, rows: [], basis: b };
  const list = key === "signing" ? rows.filter((r) => !ignored.has(targetId(key, r.id || r.plan_id || r.order_no))) : [];
  return { key, title, state: "ready", count: list.length, rows: list, basis: b };
}

export async function loadOpsAlerts(pool, options = {}) {
  const sql = `
WITH active AS (
  SELECT s.id, s._id, s.shipment_no, s.order_nos, s.contract_nos,
    s.customer, s.customer_en, s.customer_cn, s.company_code, s.etd,
    s.booking_sent_at, s.booking_no, s.bl_no, s.so_no,
    s.factory_dispatch_confirmed_at, s.telex_released_at,
    COALESCE(c.name_cn, c.name_en, cu.name_cn, cu.name_en, s.customer_cn, s.customer_en, s.customer, s.company_code) AS customer_name
  FROM shipping_plans s
  LEFT JOIN companies c ON c.code = s.company_code
  LEFT JOIN customers cu ON cu.company_code = s.company_code
  WHERE s.deleted_at IS NULL
    AND COALESCE(s.bl_no, '') NOT ILIKE '%#merged%'
    AND COALESCE(s.bl_no, '') NOT ILIKE '%#void%'
    AND COALESCE(s.bl_no, '') NOT ILIKE '%#retired%'
    AND COALESCE(s.flow_status, '') NOT LIKE 'merged_to%'
    AND lower(COALESCE(s.status, '')) NOT IN ('cancelled', 'canceled', 'void', 'voided', 'retired')
    AND lower(COALESCE(s.flow_status, '')) NOT IN ('cancelled', 'canceled', 'void', 'voided', 'retired')
),
stats AS (
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE booking_sent_at IS NOT NULL)::int AS booking_sent_at,
    COUNT(*) FILTER (WHERE NULLIF(BTRIM(booking_no), '') IS NOT NULL)::int AS booking_no,
    COUNT(*) FILTER (WHERE NULLIF(BTRIM(bl_no), '') IS NOT NULL)::int AS bl_no,
    COUNT(*) FILTER (WHERE NULLIF(BTRIM(so_no), '') IS NOT NULL)::int AS so_no,
    COUNT(*) FILTER (WHERE factory_dispatch_confirmed_at IS NOT NULL)::int AS factory_dispatch_confirmed_at,
    COUNT(*) FILTER (WHERE telex_released_at IS NOT NULL)::int AS telex_released_at
  FROM active
),
sign_rows AS (
  SELECT COALESCE(json_agg(json_build_object(
    'id', id,
    'plan_id', _id,
    'order_no', COALESCE(NULLIF(array_to_string(order_nos, ', '), ''), NULLIF(array_to_string(contract_nos, ', '), ''), shipment_no, _id),
    'customer', customer_name,
    'shipment_no', shipment_no,
    'etd', to_char(etd, 'YYYY-MM-DD')
  ) ORDER BY etd NULLS LAST, id), '[]'::json) AS rows
  FROM active
  WHERE NULLIF(BTRIM(bl_no), '') IS NULL
)
SELECT stats.*, sign_rows.rows AS signing_rows FROM stats, sign_rows`;
  const r = await pool.query(sql);
  const row = r.rows[0] || {};
  const stats = {
    total: row.total || 0,
    booking_sent_at: row.booking_sent_at || 0,
    booking_no: row.booking_no || 0,
    bl_no: row.bl_no || 0,
    so_no: row.so_no || 0,
    factory_dispatch_confirmed_at: row.factory_dispatch_confirmed_at || 0,
    telex_released_at: row.telex_released_at || 0,
  };
  const signingRows = Array.isArray(row.signing_rows) ? row.signing_rows : [];
  const ignored = options.includeIgnored ? new Set() : await ignoredTargets(pool);
  return NODES.map((node) => makeNode(node, stats, signingRows, ignored));
}

async function assertReadyRow(pool, key, id) {
  const nodes = await loadOpsAlerts(pool, { includeIgnored: true });
  const node = nodes.find((n) => n.key === key);
  if (!node || node.state !== "ready") return { ok: false, status: 403, error: "no_data alert cannot be ignored" };
  const row = (node.rows || []).find((r) => String(r.id || r.plan_id || r.order_no) === String(id));
  if (!row) return { ok: false, status: 404, error: "alert row not found" };
  return { ok: true, node, row };
}

async function ignoreAlert(req, res, pool) {
  const key = clean(req.body?.key || req.body?.node, 80);
  const id = clean(req.body?.id, 160);
  if (!key || !id) return res.status(400).json({ success: false, error: "key and id required" });
  const found = await assertReadyRow(pool, key, id);
  if (!found.ok) return res.status(found.status).json({ success: false, error: found.error });
  const actor = actorFrom(req);
  const tid = targetId(key, id);
  const detail = JSON.stringify({ source: "ops-alerts", key, id, title: found.node.title });
  const note = clean(req.body?.notes || `ignored by ${actor}`, 2000);
  const existing = await pool.query(
    `SELECT id FROM operation_todos WHERE check_code=$1 AND target_table=$2 AND target_id=$3 ORDER BY id DESC LIMIT 1`,
    [IGNORE_CODE, IGNORE_TABLE, tid]
  );
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE operation_todos
          SET status='resolved', resolved_by=$2, resolved_at=NOW(), notes=$3, detail_json=$4::json, updated_at=NOW()
        WHERE id=$1`,
      [existing.rows[0].id, actor, note, detail]
    );
  } else {
    await pool.query(
      `INSERT INTO operation_todos
         (check_code,severity,target_table,target_id,description,detail_json,status,resolved_by,resolved_at,notes)
       VALUES ($1,'P3',$2,$3,$4,$5::json,'resolved',$6,NOW(),$7)`,
      [IGNORE_CODE, IGNORE_TABLE, tid, `${found.node.title} ignored: ${id}`, detail, actor, note]
    );
  }
  return res.status(200).json({ success: true, ignored: true, target_id: tid });
}

async function unignoreAlert(req, res, pool) {
  const key = clean(req.body?.key || req.query?.key || req.body?.node || req.query?.node, 80);
  const id = clean(req.body?.id || req.query?.id, 160);
  if (!key || !id) return res.status(400).json({ success: false, error: "key and id required" });
  const actor = actorFrom(req);
  await pool.query(
    `UPDATE operation_todos
        SET status='rejected', resolved_by=$4, resolved_at=NOW(), notes=$5, updated_at=NOW()
      WHERE check_code=$1 AND target_table=$2 AND target_id=$3 AND status='resolved'`,
    [IGNORE_CODE, IGNORE_TABLE, targetId(key, id), actor, `unignored by ${actor}`]
  );
  return res.status(200).json({ success: true, ignored: false });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (req.method === "POST") return ignoreAlert(req, res, pool);
    if (req.method === "DELETE") return unignoreAlert(req, res, pool);
    if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
    const nodes = await loadOpsAlerts(pool);
    res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: nodes });
  } catch (err) {
    console.error("[ops-alerts]", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
