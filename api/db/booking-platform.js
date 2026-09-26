// 订舱平台 · read-only lens over shipping_plans.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

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
const DOC_LINK_FIELDS = [
  ["file_url", "资料下载URL"],
  ["doc_type", "资料类型"],
];

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
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}

function firstCol(colSet, names) {
  return names.find((name) => colSet.has(name)) || null;
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

function coverage(rows, fields, colSet) {
  const total = rows.length;
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function missingFor(row, fields, colSet) {
  return fields
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
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

function docExpr(name, col) {
  return col ? `d.${col}::text AS ${name}` : `NULL::text AS ${name}`;
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
  const fields = CORE_FIELDS.concat(CHANNEL_FIELDS).map(([name]) => colExpr(name, colSet)).join(", ");
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

function docKind(type, name) {
  const s = `${type || ""} ${name || ""}`.toLowerCase();
  if (/bl|b\/l|bill\s*of\s*lading|提单/.test(s)) return "bl";
  if (/sign|signed|seal|stamp|签|盖章|签单/.test(s)) return "signed";
  return "other";
}

function rememberDoc(docsByKey, key, doc) {
  const k = clean(key);
  if (!k) return;
  if (!docsByKey.has(k)) docsByKey.set(k, []);
  docsByKey.get(k).push(doc);
}

function docCoverage(rows, docStatus) {
  if (!docStatus.connected) {
    return DOC_LINK_FIELDS.map(([name, label]) => ({
      name, label, table: "document_files/ocean_doc_intake", state: "not_connected", filled: 0, total: rows.length, fill_rate: null,
    }));
  }
  return DOC_LINK_FIELDS.map(([name, label]) => {
    if (name === "file_url" && !docStatus.urlCol) {
      return { name, label, table: "document_files/ocean_doc_intake", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    }
    if (name === "doc_type" && !docStatus.typeCol) {
      return { name, label, table: "document_files/ocean_doc_intake", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    }
    const filled = rows.filter((r) => (r.docs || []).some((d) => name === "file_url" ? hasValue(d.url) : hasValue(d.type))).length;
    return { name, label, table: "document_files/ocean_doc_intake", state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
  });
}

async function docsForRows(pool, rows) {
  const docsByKey = new Map();
  const status = { connected: false, docsByKey, urlCol: null, typeCol: null, missing: [] };
  if (!rows.length) return status;
  const shipNos = [...new Set(rows.map((r) => clean(r.shipment_no)).filter(Boolean))];
  const planIds = [...new Set(rows.flatMap((r) => [r.id, r._id]).map((v) => clean(v)).filter(Boolean))];

  if (await tableExists(pool, "document_files")) {
    status.connected = true;
    const colSet = await columns(pool, "document_files");
    const urlCol = firstCol(colSet, ["file_url", "url", "oss_url", "path"]);
    const typeCol = firstCol(colSet, ["doc_type", "doc_kind", "type", "category"]);
    const nameCol = firstCol(colSet, ["display_name", "file_name", "filename", "name", "original_filename"]);
    const signedCol = firstCol(colSet, ["is_signed", "signed"]);
    const timeCol = firstCol(colSet, ["uploaded_at", "created_at", "updated_at"]);
    status.urlCol = status.urlCol || urlCol;
    status.typeCol = status.typeCol || typeCol;
    if (!urlCol) status.missing.push({ name: "file_url", label: "资料下载URL", table: "document_files" });
    if (!typeCol) status.missing.push({ name: "doc_type", label: "资料类型", table: "document_files" });
    const conds = [], params = [];
    if (colSet.has("shipment_no") && shipNos.length) {
      params.push(shipNos);
      conds.push("d.shipment_no = ANY($" + params.length + "::text[])");
    }
    if (colSet.has("bound_subject_type") && colSet.has("bound_subject_id") && planIds.length) {
      params.push(planIds);
      conds.push("(d.bound_subject_type = 'shipping_plan' AND d.bound_subject_id::text = ANY($" + params.length + "::text[]))");
    }
    if (conds.length) {
      const deleted = colSet.has("deleted_at") ? "AND d.deleted_at IS NULL" : "";
      const r = await pool.query(
        `SELECT ${docExpr("type", typeCol)}, ${docExpr("name", nameCol)}, ${docExpr("url", urlCol)},
                ${docExpr("signed", signedCol)}, ${docExpr("uploaded_at", timeCol)},
                ${colSet.has("shipment_no") ? "d.shipment_no::text" : "NULL::text"} AS shipment_no,
                ${colSet.has("bound_subject_id") ? "d.bound_subject_id::text" : "NULL::text"} AS bound_subject_id
           FROM document_files d
          WHERE (${conds.join(" OR ")}) ${deleted}
          ORDER BY ${timeCol ? `d.${timeCol} DESC NULLS LAST` : "1"}
          LIMIT 500`,
        params
      );
      for (const d of r.rows) {
        const doc = { type: d.type, name: d.name, url: d.url, signed: d.signed, uploaded_at: d.uploaded_at, kind: docKind(d.type, d.name), source: "document_files" };
        for (const key of [d.shipment_no, d.bound_subject_id]) rememberDoc(docsByKey, key, doc);
      }
    }
  }

  if (await tableExists(pool, "ocean_doc_intake")) {
    status.connected = true;
    const colSet = await columns(pool, "ocean_doc_intake");
    const urlCol = colSet.has("file_url") ? "file_url" : null;
    const typeCol = colSet.has("doc_type") ? "doc_type" : null;
    status.urlCol = status.urlCol || urlCol;
    status.typeCol = status.typeCol || typeCol;
    if (!urlCol) status.missing.push({ name: "file_url", label: "资料下载URL", table: "ocean_doc_intake" });
    if (!typeCol) status.missing.push({ name: "doc_type", label: "资料类型", table: "ocean_doc_intake" });
    if (urlCol && colSet.has("matched_shipping_plan_id") && planIds.length) {
      const typeExpr = typeCol ? "doc_type" : "NULL::text";
      const nameExpr = colSet.has("extracted") ? `COALESCE(extracted->>'filename', ${typeExpr})` : typeExpr;
      const timeExpr = colSet.has("created_at") ? "created_at" : "NULL::timestamptz";
      const r = await pool.query(
        `SELECT ${typeExpr} AS type, ${nameExpr} AS name, file_url AS url,
                ${timeExpr} AS uploaded_at, matched_shipping_plan_id::text AS plan_id
           FROM ocean_doc_intake
          WHERE matched_shipping_plan_id::text = ANY($1::text[])
            AND NULLIF(BTRIM(file_url), '') IS NOT NULL
          ORDER BY ${colSet.has("created_at") ? "created_at DESC NULLS LAST" : "1"}
          LIMIT 500`,
        [planIds]
      );
      for (const d of r.rows) {
        rememberDoc(docsByKey, d.plan_id, { type: d.type, name: d.name, url: d.url, uploaded_at: d.uploaded_at, kind: docKind(d.type, d.name), source: "ocean_doc_intake" });
      }
    }
  }
  return status;
}

function rowDocs(row, docsByKey) {
  const keys = [row.shipment_no, row.id, row._id].map((v) => clean(v)).filter(Boolean);
  const seen = new Set();
  return keys.flatMap((key) => docsByKey.get(key) || []).filter((d) => {
    const k = `${d.type}|${d.name}|${d.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function rowOut(row, colSet, docs) {
  const missing = missingFor(row, CORE_FIELDS, colSet);
  return {
    id: row.id,
    plan_id: row._id,
    shipment_no: row.shipment_no,
    booking_no: row.booking_no,
    forwarder_booking_no: row.forwarder_booking_no,
    so_no: row.so_no,
    bl_no: row.bl_no,
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
    doc_ready: docs.some((d) => hasValue(d.url) && (d.kind === "bl" || d.kind === "signed")),
    state: stateOf(row, colSet),
    missing_count: missing.length,
    missing,
  };
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
        generated_at: new Date().toISOString(),
        data: [],
        selected: null,
        coverage: {
          total_rows: 0,
          fields: coverage([], CORE_FIELDS, new Set()),
          channel_fields: coverage([], CHANNEL_FIELDS, new Set()),
          document_fields: docCoverage([], { connected: false, urlCol: null, typeCol: null }),
        },
        documents: {
          state: "not_connected",
          missing_fields: DOC_LINK_FIELDS.map(([name, label]) => ({ name, label, table: "document_files/ocean_doc_intake" })),
          note: "缺 shipping_plans 真源表，无法定位 document_files/ocean_doc_intake 资料。",
        },
        booking_channel: { state: "not_connected", missing_fields: CHANNEL_FIELDS.map(([name, label]) => ({ name, label })), note: "缺 shipping_plans 真源表；当前填充率 未接入。" },
      });
    }
    const colSet = await columns(pool, "shipping_plans");
    const rows = await listRows(pool, colSet, req.query || {});
    const docStatus = await docsForRows(pool, rows);
    const data = rows.map((r) => rowOut(r, colSet, rowDocs(r, docStatus.docsByKey)));
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      data,
      selected: data[0] || null,
      coverage: {
        total_rows: rows.length,
        fields: coverage(rows, CORE_FIELDS, colSet),
        channel_fields: coverage(rows, CHANNEL_FIELDS, colSet),
        document_fields: docCoverage(data, docStatus),
      },
      documents: {
        state: docStatus.connected && docStatus.urlCol ? "ready" : "not_connected",
        missing_fields: docStatus.missing,
        note: "只读展示 document_files/ocean_doc_intake 中已上传的提单/签单资料；缺 URL 时不生成下载入口。",
      },
      booking_channel: {
        state: "not_connected",
        missing_fields: CHANNEL_FIELDS.map(([name, label]) => ({ name, label })),
        note: "缺订舱外部发送通道、通道状态字段和回执字段；本页只读，不向货代或船公司发送订舱。",
      },
    });
  } catch (err) {
    console.error("[booking-platform]", err);
    return fail(res, 500, err.message);
  }
}
