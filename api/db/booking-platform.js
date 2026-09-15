// 订舱平台 · read-only lens over shipping_plans.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { DOC_LINK_FIELDS, docCoverage, docsForRows, rowDocs, downloadableDocs } from "./booking-platform-docs.js";
import { trialReadiness } from "./booking-platform-trial.js";
import { PLATFORM_FIELDS, notConnectedCoverage, platformStatus } from "./booking-platform-access.js";

const VERSION = "v2026.09.15-1";
const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const CORE_FIELDS = [
  ["shipment_no", "CY号"], ["booking_no", "订舱号"], ["forwarder_booking_no", "货代订舱号"],
  ["so_no", "SO号"], ["bl_no", "提单号"], ["carrier_code", "船公司"], ["forwarder_cn", "货代"],
  ["pol", "起运港"], ["pod", "目的港"], ["vessel", "船名"], ["voyage", "航次"],
  ["etd", "ETD"], ["eta", "ETA"], ["container_qty", "柜量"], ["container_type", "柜型"],
  ["cutoff_time", "截关时间"], ["cy_cutoff", "截港时间"], ["si_cutoff", "SI截止"],
  ["flow_status", "流程状态"], ["status", "系统状态"], ["customer", "客户"],
];
const CHANNEL_FIELDS = [
  ["booking_channel_status", "订舱通道状态"],
  ["booking_channel_sent_at", "发送时间"],
  ["booking_channel_receipt_no", "订舱回执号"],
];
const REF_FIELDS = ["contract_no", "order_contract_nos", "order_nos", "contract_nos"];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function canRead(user) {
  return READ_ROLES.has(user?.role);
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function hasValue(v) {
  if (Array.isArray(v)) return v.some(hasValue);
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function listValue(v) {
  if (Array.isArray(v)) return v.map((x) => clean(x)).filter(Boolean);
  const s = clean(v, 1000);
  if (!s) return [];
  return s.replace(/^[{\[]|[}\]]$/g, "").split(/[,\s/]+/).map((x) => clean(x)).filter(Boolean);
}

function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}

function fillText(filled, total) {
  if (!total) return "未接入";
  if (!filled) return "未接入";
  return `${filled}/${total} (${pct(filled, total)}%)`;
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}

async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function coverage(rows, fields, colSet, table = "shipping_plans") {
  const total = rows.length;
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, table, state: "not_connected", filled: null, total, fill_rate: null, fill_text: "未接入" };
    if (!total) return { name, label, table, state: "not_connected", filled: null, total, fill_rate: null, fill_text: "未接入" };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, table, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total), fill_text: fillText(filled, total) };
  });
}

function missingFor(row, fields, colSet) {
  return fields
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
}

function missingColumns(fields, colSet) {
  return fields
    .filter(([name]) => !colSet.has(name))
    .map(([name, label]) => ({ name, label }));
}

function documentMissingFields(docStatus) {
  if (docStatus.connected) return docStatus.missing;
  return DOC_LINK_FIELDS.flatMap(([name, label]) => [
    { name, label, table: "document_files" },
    { name, label, table: "ocean_doc_intake" },
  ]);
}

function stateOf(row, colSet) {
  if (!colSet.has("booking_no") && !colSet.has("forwarder_booking_no") && !colSet.has("so_no")) return "not_connected";
  if (!hasValue(row.booking_no) && !hasValue(row.forwarder_booking_no) && !hasValue(row.so_no)) return "missing_booking";
  if (!hasValue(row.vessel) || !hasValue(row.voyage) || !hasValue(row.etd)) return "missing_schedule";
  if (!hasValue(row.forwarder_cn)) return "missing_forwarder";
  return "ready";
}

function colExpr(name, colSet) {
  return colSet.has(name) ? `s.${name}` : `NULL::text AS ${name}`;
}

function searchConds(colSet, params, q) {
  const search = clean(q.q || q.search, 100);
  if (!search) return [];
  params.push(`%${search}%`);
  const n = params.length;
  const cols = ["shipment_no", "booking_no", "forwarder_booking_no", "so_no", "bl_no", "customer", "forwarder_cn"]
    .filter((name) => colSet.has(name))
    .map((name) => `s.${name}::text ILIKE $${n}`);
  return cols.length ? [`(${cols.join(" OR ")})`] : [];
}

function bookingRefSql(colSet) {
  const refs = ["booking_no", "forwarder_booking_no", "so_no"]
    .filter((name) => colSet.has(name))
    .map((name) => `NULLIF(BTRIM(s.${name}::text), '')`);
  return refs.length ? `COALESCE(${refs.join(", ")})` : null;
}

function stateConds(colSet, params, q) {
  const state = clean(q.state, 40);
  if (!state) return [];
  const refSql = bookingRefSql(colSet);
  if (state === "ready" && refSql) return [`${refSql} IS NOT NULL`];
  if (state === "missing_booking" && refSql) return [`${refSql} IS NULL`];
  params.push(state);
  return ["$" + params.length + " = 'not_connected'"];
}

async function listRows(pool, colSet, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 100, 200);
  const nextOnly = clean(q.next, 4) === "1";
  const params = [];
  const conds = [];
  if (colSet.has("deleted_at")) conds.push("s.deleted_at IS NULL");
  if (nextOnly && colSet.has("etd")) conds.push("s.etd::date >= CURRENT_DATE");
  conds.push(...searchConds(colSet, params, q));
  conds.push(...stateConds(colSet, params, q));
  params.push(limit);
  const fields = CORE_FIELDS.concat(CHANNEL_FIELDS).map(([name]) => colExpr(name, colSet)).concat(REF_FIELDS.map((name) => colExpr(name, colSet))).join(", ");
  const id = colSet.has("id") ? "s.id" : "NULL::int AS id";
  const sid = colSet.has("_id") ? "s._id" : "NULL::text AS _id";
  const order = colSet.has("etd")
    ? (nextOnly ? "s.etd ASC NULLS LAST" : "s.etd DESC NULLS LAST")
    : (colSet.has("updated_at") ? "s.updated_at DESC NULLS LAST" : "1");
  const r = await pool.query(
    `SELECT ${id}, ${sid}, ${fields}
       FROM shipping_plans s
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

function rowOut(row, colSet, docs) {
  const missing = missingFor(row, CORE_FIELDS, colSet);
  const readyDocs = downloadableDocs(docs);
  return {
    id: row.id,
    plan_id: row._id,
    shipment_no: row.shipment_no,
    booking_no: row.booking_no,
    forwarder_booking_no: row.forwarder_booking_no,
    so_no: row.so_no,
    bl_no: row.bl_no,
    contract_no: row.contract_no,
    order_nos: listValue(row.order_nos),
    contract_nos: [...new Set(listValue(row.order_contract_nos).concat(listValue(row.contract_nos)))],
    carrier_code: row.carrier_code,
    forwarder_cn: row.forwarder_cn,
    pol: row.pol,
    pod: row.pod,
    vessel: row.vessel,
    voyage: row.voyage,
    etd: row.etd,
    eta: row.eta,
    container_qty: row.container_qty,
    container_type: row.container_type,
    cutoff_time: row.cutoff_time,
    cy_cutoff: row.cy_cutoff,
    si_cutoff: row.si_cutoff,
    customer: row.customer,
    status: row.flow_status || row.status,
    docs,
    doc_ready: readyDocs.length > 0,
    doc_ready_count: readyDocs.length,
    state: stateOf(row, colSet),
    missing_count: missing.length,
    missing,
  };
}

function trialSort(data, nextOnly) {
  if (!nextOnly) return data;
  return data.slice().sort((a, b) => {
    const ad = a.doc_ready ? 0 : 1;
    const bd = b.doc_ready ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a.etd || "9999-12-31").localeCompare(String(b.etd || "9999-12-31"));
  });
}

function selectedRow(data, q) {
  const selected = clean(q?.selected || q?.ticket, 160);
  if (!selected) return data[0] || null;
  return data.find((r) => [r.id, r.plan_id, r.shipment_no, r.booking_no, r.forwarder_booking_no, r.so_no, r.bl_no]
    .some((v) => clean(v, 160) === selected)) || data[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canRead(req.user)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "GET required");

  try {
    const pool = getPool();
    if (!(await tableExists(pool, "shipping_plans"))) {
      return res.status(200).json({
        success: true,
        version: VERSION,
        generated_at: new Date().toISOString(),
        data: [],
        selected: null,
        coverage: {
          total_rows: 0,
          fields: coverage([], CORE_FIELDS, new Set()),
          channel_fields: coverage([], CHANNEL_FIELDS, new Set()),
          document_fields: docCoverage([], { connected: false, urlCol: null, typeCol: null }),
          platform_fields: notConnectedCoverage("booking_platform_integrations", [], PLATFORM_FIELDS),
        },
        documents: {
          state: "not_connected",
          missing_fields: DOC_LINK_FIELDS.map(([name, label]) => ({ name, label, table: "document_files/ocean_doc_intake" })),
          note: "缺 shipping_plans 真源表，无法定位 document_files/ocean_doc_intake 资料。",
        },
        trial: {
          state: "not_connected",
          can_download: false,
          can_trial: false,
          can_platform_download: false,
          platform_entry_count: 0,
          missing_fields: [{ name: "shipping_plans", label: "订舱记录", table: "shipping_plans", fill_text: "未接入" }],
          note: "缺 shipping_plans 真源表，不能定位下一票。",
        },
        booking_channel: {
          state: "not_connected",
          missing_fields: CHANNEL_FIELDS.map(([name, label]) => ({ name, label })),
          note: "缺 shipping_plans 真源表；当前填充率 未接入。",
        },
        platform_access: {
          state: "not_connected",
          entries: [],
          missing_fields: PLATFORM_FIELDS.map(([name, label]) => ({ name, label, table: "booking_platform_integrations" })),
          required_fields: PLATFORM_FIELDS.map(([name, label]) => ({ name, label, table: "booking_platform_integrations", fill_text: "未接入" })),
          note: "缺海管家账号、登录入口、下载入口和下载回执落库；本页只读取系统已有资料。",
        },
      });
    }
    const colSet = await columns(pool, "shipping_plans");
    const rows = await listRows(pool, colSet, req.query || {});
    const nextOnly = clean(req.query?.next, 4) === "1";
    const docStatus = await docsForRows(pool, rows);
    const data = trialSort(rows.map((r) => rowOut(r, colSet, rowDocs(r, docStatus.docsByKey))), nextOnly)
      .map((r, i) => ({
        ...r,
        trial_order: nextOnly ? i + 1 : null,
        is_next_ticket: nextOnly && i === 0,
      }));
    const selected = selectedRow(data, req.query || {});
    const platform = await platformStatus(pool, selected);
    const cov = {
      total_rows: rows.length,
      fields: coverage(rows, CORE_FIELDS, colSet),
      channel_fields: coverage(rows, CHANNEL_FIELDS, colSet),
      document_fields: docCoverage(data, docStatus),
      platform_fields: platform.coverage,
    };
    const trialCoverage = { ...cov, platform_access: platform };
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      data,
      selected,
      trial: trialReadiness(selected, selected?.docs || [], trialCoverage),
      coverage: cov,
      documents: {
        state: docStatus.connected && docStatus.urlCol ? "ready" : "not_connected",
        missing_fields: documentMissingFields(docStatus),
        note: "只读展示 document_files/ocean_doc_intake 中已上传的提单/签单资料；缺 URL 时不生成下载入口。",
      },
      booking_channel: {
        state: "not_connected",
        missing_fields: missingColumns(CHANNEL_FIELDS, colSet),
        note: "缺订舱外部发送接口、通道凭证和回执落库；本页只读，不向货代或船公司发送订舱。",
      },
      platform_access: {
        state: platform.state,
        total_rows: platform.total_rows,
        entries: platform.entries,
        missing_fields: platform.missing_fields,
        required_fields: platform.required_fields,
        note: platform.note,
      },
    });
  } catch (err) {
    console.error("[booking-platform]", err);
    return fail(res, 500, err.message);
  }
}
