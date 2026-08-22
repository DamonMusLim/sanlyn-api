import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { issueDocNo, loadPortChargeIssue } from "./lib/portcharge-close-loop.js";

function stripCompanyPrefix(s) {
  return String(s || "").replace(/^\d+-/, "");
}

function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) || {}; } catch (_) { return {}; }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function numOrNull(v) {
  return hasValue(v) ? num(v) : null;
}

function planCartons(p) {
  return numOrNull(p.total_cartons) ?? numOrNull(p.total_qty);
}

function splitList(v, re = /[,/]\s*/) {
  return String(v || "").split(re).map(s => s.trim()).filter(Boolean);
}

function parseContainersDetail(v) {
  const parsed = parseRaw(v);
  const list = Array.isArray(parsed) ? parsed : [];
  return list
    .filter(x => x && (x.container_no || x.seal_no || x.order_no))
    .sort((a, b) => num(a.seq) - num(b.seq));
}

async function loadOrdersByPo(pool, poList) {
  const keys = [...new Set(poList.map(stripCompanyPrefix).filter(Boolean))];
  if (!keys.length) return {};
  try {
    const r = await pool.query(
      `SELECT customer_po, COALESCE(total_cartons, total_qty) AS cartons, gross_weight, total_cbm
       FROM orders WHERE customer_po = ANY($1)`,
      [keys]
    );
    return r.rows.reduce((a, x) => {
      a[x.customer_po] = x;
      return a;
    }, {});
  } catch (_) {
    return {};
  }
}

async function loadPlanOrderCargo(pool, planId) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS order_count,
              COALESCE(SUM(COALESCE(total_cartons, total_qty)),0) AS cartons,
              SUM(gross_weight) AS gw,
              SUM(total_cbm) AS cbm
         FROM orders
        WHERE shipping_plan_id = $1`,
      [planId]
    );
    const row = r.rows[0] || {};
    if (!num(row.order_count)) return { cartons: null, gw: null, cbm: null };
    return {
      cartons: numOrNull(row.cartons),
      gw: numOrNull(row.gw),
      cbm: numOrNull(row.cbm),
    };
  } catch (_) {
    return { cartons: null, gw: null, cbm: null };
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function loadPlan(pool, id) {
  const r = await pool.query(
    "SELECT * FROM shipping_plans WHERE _id = $1 OR shipment_no = $1 OR id::text = $1 OR bl_no = $1 LIMIT 1",
    [String(id || "")]
  );
  return r.rows[0] || null;
}

async function loadCustomer(pool, p) {
  const name = p.customer_en || p.customer_cn || p.customer || "";
  if (!name) return null;
  try {
    const r = await pool.query(
      "SELECT * FROM customers WHERE name_en ILIKE $1 OR name_cn ILIKE $1 LIMIT 1",
      ["%" + String(name).trim() + "%"]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function loadFactory(pool, code) {
  if (!code) return null;
  try {
    const r = await pool.query(
      "SELECT code, name_cn, tax_id, address FROM companies WHERE code = $1 LIMIT 1",
      [code]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function latestFx(pool) {
  try {
    const r = await pool.query(
      "SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1"
    );
    return Math.round((num(r.rows[0]?.rate || 7.0) + 0.1) * 10000) / 10000;
  } catch (_) {
    return 7.1;
  }
}

async function loadContainers(pool, p) {
  const raw = parseRaw(p.raw);
  const details = parseContainersDetail(p.containers_detail);
  const ctnNos = splitList(p.container_no);
  const sealNos = splitList(raw.sealNo, /[,/;]\s*/);
  const orderNo = raw.customerPO || "—";
  const scNo = p.contract_no || "—";
  let bookings = [];
  try {
    const r = await pool.query(
      `SELECT container_no, seal_no, contract_no, cargo_weight_kg::numeric AS gross_weight_kg, container_type
       FROM container_bookings WHERE shipping_plan_id = $1 ORDER BY id`,
      [p.id]
    );
    bookings = r.rows;
  } catch (_) {}

  const orderCargo = await loadPlanOrderCargo(pool, p.id);
  let rows = [];
  // Freight invoice container source priority: containers_detail(EIR) > bookings > legacy container_no > qty placeholder.
  if (details.length) {
    const orderData = await loadOrdersByPo(pool, details.map(x => x.order_no));
    const perDetailCartons = orderCargo.cartons !== null ? Math.round(orderCargo.cartons / details.length) : null;
    const perDetailGw = orderCargo.gw !== null ? Number((orderCargo.gw / details.length).toFixed(3)) : null;
    const perDetailCbm = orderCargo.cbm !== null ? Number((orderCargo.cbm / details.length).toFixed(3)) : null;
    rows = details.map(x => {
      const poFromDetail = stripCompanyPrefix(x.order_no);
      const ord = orderData[poFromDetail] || {};
      return {
        no: String(x.container_no || "").trim(),
        seal: String(x.seal_no || "").trim() || "—",
        po: poFromDetail || ord.customer_po || scNo,
        ctn: numOrNull(ord.cartons) ?? perDetailCartons,
        gw: numOrNull(ord.gross_weight) ?? perDetailGw,
        cbm: numOrNull(ord.total_cbm) ?? perDetailCbm,
      };
    });
  } else if (bookings.length) {
    const totalCartons = planCartons(p) ?? orderCargo.cartons;
    const perCtnCartons = totalCartons !== null ? Math.round(totalCartons / bookings.length) : null;
    const perCtnGw = orderCargo.gw !== null ? Number((orderCargo.gw / bookings.length).toFixed(3)) : null;
    const totalCbm = hasValue(p.total_cbm) ? num(p.total_cbm) : orderCargo.cbm;
    const perCtnCBM = totalCbm !== null ? totalCbm / bookings.length : null;
    rows = bookings.map(cb => ({
      no: String(cb.container_no || "").trim(),
      seal: String(cb.seal_no || "").trim() || "—",
      po: stripCompanyPrefix(cb.contract_no) || orderNo || scNo,
      ctn: perCtnCartons,
      gw: numOrNull(cb.gross_weight_kg) ?? perCtnGw,
      cbm: perCtnCBM !== null ? Number(perCtnCBM.toFixed(3)) : null,
    }));
  } else {
    const poList = orderNo !== "—" ? splitList(orderNo, /[,\s]+/) : [];
    const orderData = await loadOrdersByPo(pool, poList);
    const placeholderQty = Math.max(parseInt(p.container_qty, 10) || 1, 1);
    const sourceNos = ctnNos.length ? ctnNos : Array.from({ length: placeholderQty }, () => "");
    const fallbackCartons = planCartons(p) ?? orderCargo.cartons;
    const fallbackGw = numOrNull(p.gross_weight_kg) ?? orderCargo.gw;
    const fallbackCbm = numOrNull(p.total_cbm) ?? orderCargo.cbm;
    const perLegacyCartons = fallbackCartons !== null ? Math.round(fallbackCartons / sourceNos.length) : null;
    const perLegacyGw = fallbackGw !== null ? Number((fallbackGw / sourceNos.length).toFixed(3)) : null;
    const perLegacyCbm = fallbackCbm !== null ? Number((fallbackCbm / sourceNos.length).toFixed(3)) : null;
    rows = sourceNos.map((no, i) => {
      const po = stripCompanyPrefix(poList[i]) || (orderNo !== "—" ? stripCompanyPrefix(orderNo) : scNo) || "—";
      const ord = orderData[po] || {};
      const single = sourceNos.length <= 1;
      return {
        no,
        seal: sealNos[i] || "—",
        po,
        ctn: numOrNull(ord.cartons) ?? (single ? fallbackCartons : perLegacyCartons),
        gw: numOrNull(ord.gross_weight) ?? (single ? fallbackGw : perLegacyGw),
        cbm: numOrNull(ord.total_cbm) ?? (single ? fallbackCbm : perLegacyCbm),
      };
    });
  }
  const totals = rows.reduce((a, r) => {
    a.cartons += num(r.ctn); a.gw += num(r.gw); a.cbm += num(r.cbm); return a;
  }, { cartons: 0, gw: 0, cbm: 0 });
  return {
    rows,
    totals: {
      cartons: totals.cartons || planCartons(p) || orderCargo.cartons,
      gw: totals.gw || numOrNull(p.gross_weight_kg) || orderCargo.gw,
      cbm: totals.cbm || numOrNull(p.total_cbm) || orderCargo.cbm,
    },
    qty: details.length || bookings.length || ctnNos.length || num(p.container_qty) || 1,
    type: p.container_type || "40HQ",
    freight_term: "PREPAID",
  };
}

export async function buildShippingPlanDocData(pool, id, page, actor = null, query = {}) {
  const p = await loadPlan(pool, id);
  if (!p) return null;
  const raw = parseRaw(p.raw);
  const genDate = today();
  const containers = await loadContainers(pool, p);
  const common = {
    id: p.id, shipment_no: p.shipment_no, bl_no: p.bl_no || "—", sc_no: p.contract_no || "—",
    order_no: raw.customerPO || "—", vessel: [p.vessel, p.voyage].filter(Boolean).join(" / ") || "—",
    etd: p.etd, pol: p.pol || "—", pod: p.pod || "—", gen_date: genDate,
  };
  if (page === "portcharge") {
    const pc = await loadPortChargeIssue(pool, p, { containerQty: containers.qty, payerCode: query.payer_company_code });
    if (pc.needs_payer_selection) return { page, needs_payer_selection: true, payers: pc.payers, shipment: common };
    const factory = await loadFactory(pool, pc.factoryCode);
    const totalCny = pc.totalCny;
    const data = {
      page, shipment: common, factory, containers, charges: pc.rows,
      used_fallback_card: pc.usedFallbackCard,
      needs_terms: pc.needs_terms,
      warning: pc.warning,
      warnings: pc.warnings || [],
      totals: { cny: Number(totalCny.toFixed(2)) },
      pdf_type: "fob_portcharge",
    };
    data.doc_no = await issueDocNo(pool, {
      prefix: "PC", seed: p.bl_no || p.shipment_no || p.id, blNo: p.bl_no,
      docType: "fob_portcharge", totalCny, generatedBy: actor,
      snapshot: { shipment: common, factory_code: pc.factoryCode, charges: pc.rows, used_fallback_card: pc.usedFallbackCard, warnings: pc.warnings || [] },
    });
    return data;
  }
  const customer = await loadCustomer(pool, p);
  const fxRate = await latestFx(pool);
  const totalUsd = num(p.freight_sale_usd);
  const unitPrice = containers.qty > 0 ? totalUsd / containers.qty : totalUsd;
  const plannedQty = num(p.container_qty);
  const warnings = plannedQty && plannedQty !== containers.qty
    ? [`container_qty(${plannedQty}) 与实际柜明细(${containers.qty})不一致, 已按实际柜数计算单价`]
    : [];
  const data = {
    page: "freight", shipment: common, customer, containers,
    charges: [{ cost_category: "海运费 Ocean Freight", charge_basis: "Per Container / 箱", currency: "USD", qty: containers.qty, unit_price: unitPrice, amount: totalUsd }],
    totals: { usd: Number(totalUsd.toFixed(2)), cny: Number((totalUsd * fxRate).toFixed(2)), fx_rate: fxRate },
    pdf_type: "fob_invoice",
    warnings,
  };
  data.doc_no = await issueDocNo(pool, {
    prefix: "FI", seed: p.shipment_no || p.bl_no || p.id, blNo: p.bl_no,
    docType: "fob_invoice", totalUsd, totalCny: data.totals.cny, generatedBy: actor,
    snapshot: { shipment: common, containers, charges: data.charges, warnings },
  });
  return data;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;
  const id = req.query.id || req.query.shipment_id;
  if (!id) return res.status(400).json({ error: "Missing id" });
  const page = String(req.query.page || "freight").toLowerCase() === "portcharge" ? "portcharge" : "freight";
  try {
    const actor = req.user?.email || req.user?.username || req.user?.name || req.user?.role || null;
    const data = await buildShippingPlanDocData(getPool(), id, page, actor, req.query || {});
    if (!data) return res.status(404).json({ error: "Shipment not found" });
    if (data.needs_payer_selection) return res.status(409).json({ success: false, error: "multiple_payers", data });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
