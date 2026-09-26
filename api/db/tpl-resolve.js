// /api/db/tpl-resolve - read-only placeholder value resolver
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const LIST_PREFIX = { "batch.": "batch", "accruedFee:": "accruedFee", "receivableFee:": "receivableFee", "boxInfos:": "boxInfos" };

function clean(v) { return v == null ? null : String(v).trim() || null; }
function num(v) { return v == null || v === "" ? null : Number(v); }
function first(...vals) { for (const v of vals) { const c = clean(v); if (c != null) return c; } return null; }
function lines(...vals) { const a = vals.map(clean).filter(Boolean); return a.length ? a.join("\n") : null; }
function dateOnly(v) { return v == null ? null : String(v).slice(0, 10); }
function sum(rows, field) { let hit = false, total = 0; for (const r of rows) { if (r[field] != null) { hit = true; total += Number(r[field]); } } return hit ? total : null; }
function mul(a, b) { return a == null || b == null ? null : Number(a) * Number(b); }
function port(ctx, v) { const c = clean(v); return c ? ctx.ports.get(c) || c : null; }
function boxCounts(rows) {
  const m = new Map();
  for (const r of rows) { const t = clean(r.container_type); if (t) m.set(t, (m.get(t) || 0) + 1); }
  return Array.from(m.entries()).map(([t, n]) => `${n}x${t}`).join(", ") || null;
}
function feeRows(ctx, dir) {
  return ctx.fees.filter(f => dir === "in" ? !["out", "refund"].includes(clean(f.direction) || "") : ["out", "refund"].includes(clean(f.direction) || ""));
}
function party(row, nameKey, addrKey) { return lines(row?.[nameKey], row?.[addrKey]); }
function valueFrom(row, keys) { for (const k of keys) if (row && row[k] != null && clean(row[k]) !== null) return row[k]; return null; }
function feeTotal(rows) { return sum(rows, "total_price") ?? sum(rows, "amount"); }
function feeList(rows) {
  return rows.map((r, i) => ({
    serialNumber: i + 1,
    feeName: first(r.fee_name, r.charge_name),
    feeCurrency: first(r.currency, r.currency_norm),
    currencyUnit: first(r.settle_currency, r.currency, r.currency_norm),
    unitPrice: num(r.unit_price),
    number: num(r.qty),
    totalPrice: num(r.total_price ?? r.amount),
    remark: first(r.remark, r.remarks),
    settlementHeadName: first(r.settlement_company, r.settlement_head_name),
    feeType: first(r.fee_type, r.direction),
  }));
}
function boxList(rows) {
  return rows.map(r => ({
    boxType: first(r.container_type),
    weight: num(r.vgm_weight_kg ?? r.weight_kg ?? r.gross_weight_kg),
    titleNo: first(r.seal_no),
    boxNo: first(r.container_no),
  }));
}
function batchList(ctx) {
  return ctx.lines.map(r => ({
    number: num(r.qty_ctn),
    volume: mul(r.cbm_ctn, r.qty_ctn),
    grossWeight: mul(r.gw_ctn, r.qty_ctn),
    transportRemark: first(r.bl_description, r.transport_remark, r.remark),
    teamName: first(r.contract_no, r.order_no),
    boxSizeNumber: first(r.container_type, r.box_size_number),
  }));
}

async function loadMap(pool) {
  const r = await pool.query(
    `SELECT ph_key, our_source, our_note, data_kind, status FROM hgj_placeholder_map ORDER BY ph_key`
  );
  return r.rows;
}
async function loadPlan(pool, id) {
  const r = await pool.query(
    `SELECT sp.*, ic.name_en AS issuing_company_en, ic.name AS issuing_company_name,
            cc.name AS customer_company_name, cc.name_en AS customer_company_en, cc.address_en AS customer_address_en
     FROM shipping_plans sp
     LEFT JOIN companies ic ON ic.code = sp.issuing_company
     LEFT JOIN companies cc ON cc.code = sp.company_code
     WHERE sp.id = $1 OR sp._id = $1
     LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}
async function loadBl(pool, id) {
  const r = await pool.query(
    `SELECT * FROM bill_of_ladings
     WHERE shipping_plan_id = $1 AND bl_kind = 'HBL'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1`,
    [id]
  );
  return r.rows[0] || {};
}
async function loadPorts(pool, sp) {
  const codes = [sp.pol, sp.pod, sp.discharge_port, sp.place_of_delivery, sp.place_of_receipt, sp.barge_port, sp.port_transit].map(clean).filter(Boolean);
  if (!codes.length) return new Map();
  const r = await pool.query(`SELECT code, unlocode, name_en FROM ports WHERE code = ANY($1::text[]) OR unlocode = ANY($1::text[])`, [codes]);
  const m = new Map();
  for (const row of r.rows) { if (row.code && row.name_en) m.set(clean(row.code), row.name_en); if (row.unlocode && row.name_en) m.set(clean(row.unlocode), row.name_en); }
  return m;
}
async function loadContainers(pool, id) {
  const r = await pool.query(`SELECT * FROM container_bookings WHERE shipping_plan_id = $1 ORDER BY container_no NULLS LAST`, [id]);
  return r.rows;
}
async function loadLines(pool, id) {
  const r = await pool.query(
    `SELECT oli.*, o.order_no, o.contract_no, o.marks AS order_marks, l."关联方式" AS link_via
     FROM v_plan_order_link l
     JOIN order_line_items oli ON oli.order_id = l.order_id
     LEFT JOIN orders o ON o.id = l.order_id
     WHERE l.shipping_plan_id = $1
     ORDER BY o.contract_no NULLS LAST, o.order_no NULLS LAST, oli.id`,
    [id]
  );
  return r.rows;
}
async function loadFees(pool, id) {
  const r = await pool.query(`SELECT * FROM freight_supplier_bills WHERE shipping_plan_id = $1 ORDER BY id`, [id]);
  return r.rows;
}
async function buildCtx(pool, id) {
  const sp = await loadPlan(pool, id);
  if (!sp) return null;
  const [bl, containers, lines, fees, ports] = await Promise.all([loadBl(pool, id), loadContainers(pool, id), loadLines(pool, id), loadFees(pool, id), loadPorts(pool, sp)]);
  return { sp, bl, containers, lines, fees, ports };
}

const S = k => ctx => valueFrom(ctx.sp, Array.isArray(k) ? k : [k]);
const B = k => ctx => valueFrom(ctx.bl, Array.isArray(k) ? k : [k]);
const R = {
  portStart: c => port(c, c.sp.pol), portArrive: c => port(c, c.sp.pod), portUnloading: c => port(c, first(c.sp.discharge_port, c.sp.pod)),
  portTransit: c => port(c, c.sp.port_transit), destination: c => port(c, first(c.sp.place_of_delivery, c.sp.final_destination, c.sp.pod)),
  bargeHarbor: c => port(c, first(c.sp.barge_port, c.sp.place_of_receipt)), vesselName: S("vessel"), voyage: S("voyage"),
  date: c => dateOnly(first(c.sp.created_at, c.sp.etd)), etd: c => dateOnly(c.sp.etd), estimatedTimeDeparture: c => dateOnly(c.sp.etd), estimatedTimeArrival: c => dateOnly(c.sp.eta),
  outerOrderNo: S(["shipment_no", "so_no", "sinotrans_no"]), bookingOuterOrderNo: S(["booking_no", "so_no", "sinotrans_no"]),
  primaryBillNo: c => first(c.bl.mbl_no, c.sp.mbl_no, c.sp.bl_no), divisionBillNoOrHbl: c => first(c.bl.hbl_no, c.bl.bl_no, c.sp.hbl_no),
  divisionBillNos: c => first(c.bl.hbl_no, c.sp.hbl_no), relatedMbls: c => first(c.bl.mbl_no, c.sp.mbl_no), billNos: c => first(c.bl.bl_no, c.bl.hbl_no, c.sp.bl_no, c.sp.hbl_no),
  companyEnName: c => first(c.sp.issuing_company_en, c.sp.company_en_name), "companyEnName#2": c => first(c.sp.issuing_company_en, c.sp.company_en_name),
  companyName: c => first(c.sp.issuing_company_name, c.sp.issuing_company), customerName: c => first(c.sp.customer, c.sp.customer_company_name), "customer.customerName": c => first(c.sp.customer, c.sp.customer_company_name),
  "customer.addressEn": c => first(c.sp.customer_address_en, c.sp.customer_company_en), userName: S(["created_by", "op_staff"]), teamName: S(["sales_staff", "op_staff"]), teamPerson: S(["op_staff", "cs_staff"]),
  bussType: S("business_type"), shippingCompany: S(["carrier", "shipping_company"]), wharf: S(["wharf", "depot"]), payWay: c => first(c.bl.payment_method, c.sp.payment_method, c.sp.freight_payment),
  payWayFreightCollect: c => first(c.bl.payment_method, c.sp.payment_method) === "collect" ? "collect" : null,
  payWayFreightPrepaid: c => first(c.bl.payment_method, c.sp.payment_method) === "prepaid" ? "prepaid" : null,
  goodsName: c => first(c.bl.cargo_name_en, c.sp.cargo_description, c.lines[0]?.declaration_name_en), chGoodsName: c => first(c.bl.cargo_name_cn, c.lines[0]?.declaration_name),
  volume: c => num(first(c.bl.cbm, c.sp.actual_cbm, c.sp.total_cbm)), grossWeight: c => num(first(c.bl.gross_weight_kg, c.sp.actual_gross_weight_kg, c.sp.gross_weight_kg)),
  number: c => num(first(c.bl.pkgs, c.sp.actual_pkgs, c.sp.total_cartons)), unitOfWeight: () => "KGS", transportItems: S("transport_terms"),
  customerBussNo: S(["contract_no", "primary_contract_no"]), remark: c => first(c.bl.bl_remarks, c.sp.bl_remarks, c.sp.booking_remarks, c.sp.op_remarks), marks: c => first(c.bl.marks, c.lines[0]?.order_marks),
  "actual.grossWeight": c => num(c.sp.actual_gross_weight_kg), "actual.unitNumber": c => num(c.sp.actual_pkgs), "actual.numberUnit": S("actual_pkg_unit"), "actual.volume": c => num(c.sp.actual_cbm),
  overseasDeliveryAddress: B("overseas_delivery_address"), totalAmount: S(["total_amount", "freight_sale_usd"]), billForm: c => first(c.bl.bl_form, c.sp.bl_type, c.sp.release_type), billFormEn: c => first(c.bl.bl_form, c.sp.bl_type),
  bookingProxyName: S(["forwarder", "booking_proxy_name"]), issuedDate: c => dateOnly(c.bl.issue_date), issuedAddress: c => first(c.bl.issue_place, c.sp.place_of_issue),
  paymentAddress: c => first(c.bl.payment_address, c.sp.payment_place), shptMode: S(["shipping_mode", "transport_terms"]), feeRemark: c => first(c.sp.fee_remark, c.fees[0]?.remark),
  debitNoteTitle: c => first(c.sp.debit_note_title, c.sp.customer, c.sp.customer_company_name), stowageRemark: S(["allocation_remarks", "booking_remarks"]),
  receivableFeeSum: c => feeTotal(feeRows(c, "in")), accruedFeeSum: c => feeTotal(feeRows(c, "out")), grossProfitAllRMB: c => { const a = feeTotal(feeRows(c, "in")), b = feeTotal(feeRows(c, "out")); return a == null || b == null ? null : a - b; },
  grossProfitCNY: c => R.grossProfitAllRMB(c), grossProfitMargin: c => { const a = feeTotal(feeRows(c, "in")), p = R.grossProfitAllRMB(c); return !a ? null : p / a; },
  total: c => feeTotal(feeRows(c, "in")), asTheOrderTime: c => dateOnly(c.sp.order_received_at),
  consigneeInfo: c => party(c.bl, "consignee_name", "consignee_address"), shipperInfo: c => party(c.bl, "shipper_name", "shipper_address"),
  notifierInfo: c => party(c.bl, "notify_name", "notify_address"), accountInfoText: S(["account_info_text", "payment_place"]),
  boxSizeNumber: c => boxCounts(c.containers), onlyBoxSizeNumber: c => boxCounts(c.containers), boxSizeNumberTitle: c => boxCounts(c.containers),
  boxNoStr: c => c.containers.map(r => clean(r.container_no)).filter(Boolean).join(", ") || null, boxSizeStr: c => c.containers.map(r => clean(r.container_type)).filter(Boolean).join(", ") || null,
  boxSizeNumberEn: c => boxCounts(c.containers),
};
for (const k of ["batch.number", "batch.volume", "batch.grossWeight", "batch.transportRemark", "batch.teamName", "batch.boxSizeNumber"]) R[k] = c => batchList(c);
for (const k of ["accruedFee:number", "accruedFee:feeCurrency", "accruedFee:currencyUnit", "accruedFee:remark", "accruedFee:totalPrice", "accruedFee:unitPrice", "accruedFee:feeName", "accruedFee:serialNumber", "accruedFee:settlementHeadName", "accruedFee:feeType"]) R[k] = c => feeList(feeRows(c, "out"));
for (const k of ["receivableFee:currencyUnit", "receivableFee:feeCurrency", "receivableFee:unitPrice", "receivableFee:number", "receivableFee:totalPrice", "receivableFee:remark", "receivableFee:feeName", "receivableFee:feeType", "receivableFee:settlementHeadName", "receivableFee:serialNumber"]) R[k] = c => feeList(feeRows(c, "in"));
for (const k of ["boxInfos:boxType", "boxInfos:weight", "boxInfos:titleNo", "boxInfos:boxNo"]) R[k] = c => boxList(c.containers);
R.boxStrList = c => c.containers.map(r => [r.container_no, r.seal_no, r.container_type].map(clean).filter(Boolean).join(" / ")).filter(Boolean);

function putList(lists, key, value) {
  if (key === "boxStrList") { lists.boxStrList = value; return; }
  for (const p of Object.keys(LIST_PREFIX)) if (key.startsWith(p)) { lists[LIST_PREFIX[p]] = value; return; }
}
function isMissing(v) { return v == null || v === "" || (Array.isArray(v) && v.length === 0); }
function listFieldMissing(key, rows) {
  if (!Array.isArray(rows) || !rows.length) return true;
  if (key === "boxStrList") return rows.every(v => !clean(v));
  const cut = key.includes(":") ? key.split(":")[1] : key.split(".")[1];
  return rows.every(r => r == null || r[cut] == null || r[cut] === "");
}

async function resolve(pool, id) {
  const [mapRows, ctx] = await Promise.all([loadMap(pool), buildCtx(pool, id)]);
  if (!ctx) return null;
  const values = {}, lists = { batch: [], receivableFee: [], accruedFee: [], boxInfos: [], boxStrList: [] }, unresolved = [], skipped = [];
  for (const row of mapRows) {
    if (row.status !== "mapped") { skipped.push({ ph_key: row.ph_key, status: row.status, note: row.our_note || row.our_source || null }); continue; }
    const fn = R[row.ph_key];
    if (!fn) { unresolved.push({ ph_key: row.ph_key, reason: "渲染器未实现该取数逻辑" }); continue; }
    const value = fn(ctx);
    const isList = row.data_kind === "list" || row.ph_key === "boxStrList";
    if (isMissing(value) || (isList && listFieldMissing(row.ph_key, value))) { unresolved.push({ ph_key: row.ph_key, reason: row.ph_key === "notifierInfo" ? "通知人取不到值" : "映射源取不到值" }); continue; }
    if (isList) putList(lists, row.ph_key, value);
    else values[row.ph_key] = value;
  }
  return { values, lists, unresolved, skipped };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  const id = Number.parseInt(String(req.query?.shipping_plan_id || ""), 10);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== String(req.query?.shipping_plan_id)) {
    return res.status(400).json({ success: false, error: "shipping_plan_id must be a positive integer" });
  }
  try {
    const out = await resolve(getPool(), id);
    if (!out) return res.status(404).json({ success: false, shipping_plan_id: id, error: "shipping_plan not found" });
    return res.json({ success: true, shipping_plan_id: id, ...out });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
