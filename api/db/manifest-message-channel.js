// /api/db/manifest-message-channel — generate, validate, and persist manifest messages; never sends.
import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeCargoType } from "./lib/cargo-type-enum.js";

const ROLES = new Set(["admin", "logistics", "ops"]);
const OUTBOX = "manifest_message_outbox";
const REAL_CHANNEL = "shanghai_manifest";
const SIM_CHANNEL = `sim_${REAL_CHANNEL}`;
const HEADER_FIELDS = [
  ["shipment_no", "舱单编号"], ["carrier", "船公司"], ["vessel", "船名"], ["voyage", "航次"],
  ["bl_no", "提单号"], ["pol", "装港"], ["pod", "卸港"], ["shipper_name", "发货人"],
  ["shipper_address", "发货人地址"], ["consignee_name", "收货人"], ["consignee_address", "收货人地址"],
  ["notify_name", "通知人"], ["notify_address", "通知人地址"],
];
const LINE_FIELDS = [
  ["declaration_name", "申报品名"], ["hs_code", "HS编码"], ["ctns", "箱数"],
  ["gw_kg", "毛重"], ["amount", "逐项货值"],
];
const OUTBOX_FIELDS = [
  "id", "shipment_id", "channel", "message_type", "payload", "validation_errors",
  "status", "checksum", "created_by", "created_at", "updated_at",
];

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra });
}
function canUse(user) {
  return ROLES.has(user?.role);
}
function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}
function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}
function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}
async function tableExists(pool, table) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1`,
    [table]
  );
  return r.rowCount > 0;
}
async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
function missingCols(colSet, names) {
  return names.filter((n) => !colSet.has(n));
}
function coverage(rows, fields, colSet) {
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
  });
}
function missingValues(row, fields, colSet, scope) {
  return fields.filter(([name]) => !colSet.has(name) || !hasValue(row[name])).map(([name, label]) => ({
    scope, name, label, reason: colSet.has(name) ? "empty" : "not_connected",
  }));
}
function pick(row, fields) {
  const out = {};
  fields.forEach(([name]) => { out[name] = row[name] ?? null; });
  return out;
}
function checksum(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function actor(user) {
  return user?.username || user?.name || user?.sub || null;
}
function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}
function simulationPayload(message, status, extra = {}) {
  return {
    ...message.payload,
    channel: SIM_CHANNEL,
    __simulation: true,
    simulation_status: status,
    ...extra,
  };
}
function exportName(shipment, ext) {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const raw = clean(shipment?.shipment_no || shipment?.id || "shipment", 80) || "shipment";
  const safe = raw.replace(/[^\w.-]+/g, "_");
  return { raw: `manifest_${raw}_${ymd}.${ext}`, safe: `manifest_${safe}_${ymd}.${ext}` };
}
function setDownloadHeaders(res, shipment, ext, type) {
  const name = exportName(shipment, ext);
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${name.safe}"; filename*=UTF-8''${encodeURIComponent(name.raw)}`);
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(values) {
  return values.map(csvCell).join(",");
}
function errorText(e) {
  return `${e.scope || ""} ${e.label || e.name || ""} ${e.reason || ""}`.trim();
}
function renderCsv(message) {
  const rows = [
    csvRow(["舱单编号", "提单号", "行号", ...LINE_FIELDS.map(([, label]) => label)]),
    ...message.payload.lines.map((line, idx) => csvRow([
      message.payload.shipment.shipment_no, message.payload.shipment.bl_no, idx + 1,
      ...LINE_FIELDS.map(([name]) => line[name]),
    ])),
  ];
  if (message.errors.length) {
    rows.push("", csvRow(["校验未通过项"]), csvRow(["范围", "字段", "原因"]));
    rows.push(...message.errors.map((e) => csvRow([e.scope, e.label || e.name, e.reason])));
  }
  return "\ufeff" + rows.join("\r\n") + "\r\n";
}
function renderTxt(message) {
  const s = message.payload.shipment;
  const rows = HEADER_FIELDS.map(([name, label]) => `${label}: ${s[name] ?? ""}`);
  rows.push(`公司代码: ${s.company_code ?? ""}`, `货物属性枚举: ${s.cargo_type_enum ?? ""}`, "", "明细:");
  message.payload.lines.forEach((line, idx) => {
    rows.push(`第${idx + 1}行:`);
    LINE_FIELDS.forEach(([name, label]) => rows.push(`${label}: ${line[name] ?? ""}`));
  });
  if (message.errors.length) rows.push("", "校验未通过项:", ...message.errors.map((e) => `- ${errorText(e)}`));
  return rows.join("\n") + "\n";
}
function sendExport(res, format, shipment, message) {
  if (format === "json") {
    setDownloadHeaders(res, shipment, "json", "application/json; charset=utf-8");
    return res.status(200).send(JSON.stringify(message, null, 2));
  }
  if (format === "csv") {
    setDownloadHeaders(res, shipment, "csv", "text/csv; charset=utf-8");
    return res.status(200).send(renderCsv(message));
  }
  if (format === "txt") {
    setDownloadHeaders(res, shipment, "txt", "text/plain; charset=utf-8");
    return res.status(200).send(renderTxt(message));
  }
  return fail(res, 400, "unsupported_export_format");
}
async function listShipments(pool, shipmentCols, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 60, 120);
  const params = [], conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.shipment_no ILIKE $1 OR s.bl_no ILIKE $1 OR s.company_code ILIKE $1)`);
  }
  if (q.id) {
    params.push(parseInt(q.id, 10));
    conds.push(`s.id = $${params.length}`);
  }
  const names = HEADER_FIELDS.map(([n]) => n).concat(["cargo_type"]);
  const dynamic = names.filter((n) => shipmentCols.has(n)).map((n) => `s.${n}`).join(", ");
  params.push(limit);
  const r = await pool.query(`
    SELECT s.id, s.etd, s.status, s.company_code, ${dynamic || "s.shipment_no"},
      COALESCE(c.name_cn, c.name_en, s.company_code) AS company_name
    FROM customs_shipments s
    LEFT JOIN companies c ON c.code = s.company_code
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY s.created_at DESC, s.id DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}
async function loadLines(pool, lineCols, shipmentId) {
  const cols = LINE_FIELDS.filter(([n]) => lineCols.has(n)).map(([n]) => n).join(", ");
  const r = await pool.query(
    `SELECT id, ${cols || "shipment_id"} FROM customs_shipment_lines WHERE shipment_id = $1 ORDER BY id LIMIT 500`,
    [shipmentId]
  );
  return r.rows;
}
async function loadDrafts(pool, hasOutbox) {
  if (!hasOutbox) return [];
  const r = await pool.query(
    `SELECT id, shipment_id, channel, message_type, status, checksum, created_at, updated_at
     FROM manifest_message_outbox
     WHERE status IN ('blocked','pending_send')
     ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 20`
  );
  return r.rows;
}
function buildMessage(shipment, lines, shipmentCols, lineCols) {
  const lineMissing = [];
  lines.forEach((line, idx) => {
    lineMissing.push(...missingValues(line, LINE_FIELDS, lineCols, "line:" + (idx + 1)));
  });
  const cargo = normalizeCargoType(shipmentCols.has("cargo_type") ? shipment.cargo_type : null);
  const errors = missingValues(shipment, HEADER_FIELDS, shipmentCols, "header").concat(lineMissing);
  if (!lines.length) errors.push({ scope: "lines", name: "customs_shipment_lines", label: "舱单明细", reason: "not_connected" });
  if (shipmentCols.has("cargo_type") && cargo.state !== "ready") {
    errors.push({ scope: "header", name: "cargo_type", label: "货物属性内部枚举", reason: "unmapped" });
  }
  const payload = {
    schema: "sanlyn.manifest.message.v1",
    generated_at: new Date().toISOString(),
    channel: REAL_CHANNEL,
    message_type: "manifest_declaration",
    shipment: { id: shipment.id, company_code: shipment.company_code, cargo_type_enum: cargo.code, ...pick(shipment, HEADER_FIELDS) },
    lines: lines.map((line) => ({ id: line.id, ...pick(line, LINE_FIELDS) })),
  };
  return { payload, errors, checksum: checksum(payload), status: errors.length ? "blocked" : "pending_send" };
}
async function writeDraft(pool, message, shipmentId, user) {
  const existing = await pool.query(
    `SELECT id, shipment_id, channel, message_type, status, checksum, created_at, updated_at
     FROM manifest_message_outbox
     WHERE shipment_id = $1 AND checksum = $2 AND status IN ('blocked','pending_send')
     ORDER BY id DESC LIMIT 1`,
    [shipmentId, message.checksum]
  );
  if (existing.rows[0]) return existing.rows[0];
  const r = await pool.query(
    `INSERT INTO manifest_message_outbox
      (shipment_id, channel, message_type, payload, validation_errors, status, checksum, created_by, created_at, updated_at)
     VALUES ($1,'shanghai_manifest','manifest_declaration',$2::jsonb,$3::jsonb,$4,$5,$6,now(),now())
     RETURNING id, shipment_id, channel, message_type, status, checksum, created_at, updated_at`,
    [shipmentId, JSON.stringify(message.payload), JSON.stringify(message.errors), message.status, message.checksum, user?.username || user?.name || user?.sub || null]
  );
  return r.rows[0];
}
async function insertOutbox(pool, shipmentId, payload, errors, status, user) {
  const r = await pool.query(
    `INSERT INTO manifest_message_outbox
      (shipment_id, channel, message_type, payload, validation_errors, status, checksum, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,now(),now())
     RETURNING id, shipment_id, channel, message_type, status, checksum, created_at, updated_at`,
    [
      shipmentId,
      SIM_CHANNEL,
      "manifest_declaration",
      JSON.stringify(payload),
      JSON.stringify(errors),
      status,
      checksum(payload),
      actor(user),
    ]
  );
  return r.rows[0];
}
async function simulateSend(pool, message, shipmentId, user) {
  if (message.errors.length) {
    return { simulated: false, reason: "validation_failed", errors: message.errors };
  }
  await pool.query("BEGIN");
  try {
    const now = new Date();
    const queuedPayload = simulationPayload(message, "queued", { queued_at: now.toISOString() });
    const queued = await insertOutbox(pool, shipmentId, queuedPayload, [], "queued", user);
    const sentAt = new Date();
    const sentPayload = simulationPayload(message, "sent", { queued_id: queued.id, sent_at: sentAt.toISOString() });
    const sent = await insertOutbox(pool, shipmentId, sentPayload, [], "sent", user);
    const ackAt = new Date();
    const receipt = {
      receipt_no: `SIM-${SIM_CHANNEL}-${ymd(ackAt)}-${String(sent.id).padStart(6, "0").slice(-6)}`,
      acknowledged_at: ackAt.toISOString(),
      is_simulation: true,
    };
    const acknowledgedPayload = simulationPayload(message, "acknowledged", { sent_id: sent.id, receipt });
    const acknowledged = await insertOutbox(pool, shipmentId, acknowledgedPayload, [], "acknowledged", user);
    await pool.query("COMMIT");
    return { simulated: true, channel: SIM_CHANNEL, steps: { queued, sent, acknowledged }, receipt };
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canUse(req.user)) return fail(res, 403, "Forbidden");
  try {
    const pool = getPool();
    const hasShipments = await tableExists(pool, "customs_shipments");
    const hasLines = await tableExists(pool, "customs_shipment_lines");
    const hasOutbox = await tableExists(pool, OUTBOX);
    if (!hasShipments) return res.status(200).json({ success: true, data: [], drafts: [], state: "not_connected", missing: ["customs_shipments"] });
    const shipmentCols = await columns(pool, "customs_shipments");
    const lineCols = hasLines ? await columns(pool, "customs_shipment_lines") : new Set();
    const outboxCols = hasOutbox ? await columns(pool, OUTBOX) : new Set();
    const outboxMissing = hasOutbox ? missingCols(outboxCols, OUTBOX_FIELDS) : [OUTBOX];
    const params = req.method === "GET" ? { ...(req.query || {}) } : { ...(req.query || {}), ...(req.body || {}) };
    if (params.shipment_id && !params.id) params.id = params.shipment_id;
    const rows = await listShipments(pool, shipmentCols, params);
    const selected = rows[0] || null;
    if (req.method === "GET") {
      if (params.export) {
        if (!selected) return fail(res, 404, "shipment_not_found");
        const lines = hasLines ? await loadLines(pool, lineCols, selected.id) : [];
        return sendExport(res, String(params.export).toLowerCase(), selected, buildMessage(selected, lines, shipmentCols, lineCols));
      }
      return res.json({
        success: true, generated_at: new Date().toISOString(), data: rows, selected,
        coverage: { total_rows: rows.length, header_fields: coverage(rows, HEADER_FIELDS, shipmentCols), outbox_missing: outboxMissing },
        outbox: hasOutbox && !outboxMissing.length ? { state: "ready", drafts: await loadDrafts(pool, true) } : { state: "not_connected", drafts: [], missing_fields: outboxMissing },
      });
    }
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    if (!hasOutbox || outboxMissing.length) return fail(res, 409, "outbox_not_connected", { missing_fields: outboxMissing });
    if (!selected) return fail(res, 404, "shipment_not_found");
    const lines = hasLines ? await loadLines(pool, lineCols, selected.id) : [];
    const message = buildMessage(selected, lines, shipmentCols, lineCols);
    if ((req.body || {}).action === "validate") return res.json({ success: true, dry_run: true, message });
    if ((req.body || {}).action === "simulate") {
      return res.json({ success: true, ...(await simulateSend(pool, message, selected.id, req.user || {})), message });
    }
    const draft = await writeDraft(pool, message, selected.id, req.user || {});
    return res.json({ success: true, sent: false, draft, message });
  } catch (err) {
    console.error("[manifest-message-channel]", err);
    return fail(res, 500, err.message);
  }
}
