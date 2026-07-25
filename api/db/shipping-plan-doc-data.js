import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

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
  const ctnNos = String(p.container_no || "").split(/[,/]\s*/).map(s => s.trim()).filter(Boolean);
  const sealNos = String(raw.sealNo || "").split(/[,/;]\s*/).map(s => s.trim()).filter(Boolean);
  const orderNo = raw.customerPO || "—";
  const scNo = p.contract_no || "—";
  let siblings = [];
  let bookings = [];
  try {
    const r = await pool.query(
      `SELECT id, container_no, COALESCE(raw->>'customerPO','') AS po,
              COALESCE(raw->>'sealNo','') AS seal, total_cartons, gross_weight_kg, total_cbm
       FROM shipping_plans WHERE bl_no = $1 AND id != $2 ORDER BY id`,
      [p.bl_no, p.id]
    );
    siblings = r.rows;
  } catch (_) {}
  try {
    const r = await pool.query(
      `SELECT container_no, seal_no, contract_no, cargo_weight_kg::numeric AS gross_weight_kg, container_type
       FROM container_bookings WHERE shipping_plan_id = $1 ORDER BY id`,
      [p.id]
    );
    bookings = r.rows;
  } catch (_) {}

  let rows = [];
  if (bookings.length > 1) {
    const perCtnCartons = p.total_cartons ? Math.round(num(p.total_cartons) / bookings.length) : null;
    const perCtnCBM = p.total_cbm ? num(p.total_cbm) / bookings.length : null;
    rows = bookings.map(cb => ({
      no: String(cb.container_no || "").trim(),
      seal: String(cb.seal_no || "").trim(),
      po: stripCompanyPrefix(cb.contract_no) || orderNo || scNo,
      ctn: perCtnCartons,
      gw: cb.gross_weight_kg ? num(cb.gross_weight_kg) : null,
      cbm: perCtnCBM ? Number(perCtnCBM.toFixed(3)) : null,
    }));
  } else if (siblings.length) {
    rows = [
      { container_no: ctnNos[0] || "", po: orderNo !== "—" ? orderNo : scNo, seal: sealNos[0] || "", total_cartons: p.total_cartons, gross_weight_kg: p.gross_weight_kg, total_cbm: p.total_cbm },
      ...siblings,
    ].map(pl => ({
      no: String(pl.container_no || "").trim(),
      seal: String(pl.seal || "").trim(),
      po: pl.po || "—",
      ctn: pl.total_cartons ? num(pl.total_cartons) : null,
      gw: pl.gross_weight_kg ? num(pl.gross_weight_kg) : null,
      cbm: pl.total_cbm ? num(pl.total_cbm) : null,
    }));
  } else {
    const poList = orderNo !== "—" ? String(orderNo).split(/[,\s]+/).map(s => s.trim()).filter(Boolean) : [];
    let orderData = {};
    if (poList.length > 1) {
      try {
        const r = await pool.query(
          "SELECT customer_po, total_cartons, gross_weight, total_cbm FROM orders WHERE customer_po = ANY($1)",
          [poList]
        );
        r.rows.forEach(x => { orderData[x.customer_po] = x; });
      } catch (_) {}
    }
    rows = (ctnNos.length ? ctnNos : [""]).map((no, i) => {
      const po = poList[i] || (orderNo !== "—" ? orderNo : scNo) || "—";
      const ord = orderData[po] || {};
      const single = ctnNos.length <= 1;
      return {
        no,
        seal: sealNos[i] || "—",
        po,
        ctn: ord.total_cartons ? num(ord.total_cartons) : (single && p.total_cartons ? num(p.total_cartons) : null),
        gw: ord.gross_weight ? num(ord.gross_weight) : (single && p.gross_weight_kg ? num(p.gross_weight_kg) : null),
        cbm: ord.total_cbm ? num(ord.total_cbm) : (single && p.total_cbm ? num(p.total_cbm) : null),
      };
    });
  }
  const totals = rows.reduce((a, r) => {
    a.cartons += num(r.ctn); a.gw += num(r.gw); a.cbm += num(r.cbm); return a;
  }, { cartons: 0, gw: 0, cbm: 0 });
  return {
    rows,
    totals: {
      cartons: totals.cartons || (p.total_cartons ? num(p.total_cartons) : null),
      gw: totals.gw || (p.gross_weight_kg ? num(p.gross_weight_kg) : null),
      cbm: totals.cbm || (p.total_cbm ? num(p.total_cbm) : null),
    },
    qty: rows.length || ctnNos.length || num(p.container_qty) || 1,
    type: p.container_type || "40HQ",
    freight_term: "PREPAID",
  };
}

async function portCharges(pool, p) {
  const blNo = p.bl_no || "—";
  let factoryCode = "";
  try {
    const r = await pool.query(
      `SELECT DISTINCT payer_company_code
       FROM active_freight_supplier_bills
       WHERE (bl_no = $1 OR link_plan_id = $2)
         AND (cost_category !~* '海运|ocean|freight')
         AND COALESCE(amount,0) > 0 AND COALESCE(payer_company_code,'') <> ''
       LIMIT 1`,
      [blNo, String(p.id)]
    );
    factoryCode = r.rows[0]?.payer_company_code || "";
  } catch (_) {}
  let rows = [];
  if (factoryCode) {
    try {
      const r = await pool.query(
        `SELECT cost_category, amount, currency, qty, unit_price, charge_basis
         FROM active_freight_supplier_bills
         WHERE (bl_no = $1 OR link_plan_id = $3) AND payer_company_code = $2
           AND (cost_category !~* '海运|ocean|freight')
           AND UPPER(COALESCE(currency,'CNY')) = 'CNY' AND COALESCE(amount,0) > 0
         ORDER BY id`,
        [blNo, factoryCode, String(p.id)]
      );
      rows = r.rows;
    } catch (_) {}
  }
  let usedFallbackCard = false;
  if (!rows.length) {
    usedFallbackCard = true;
    const qty = parseInt(p.container_qty, 10) || 1;
    rows = [
      ["舱单费", "整票", 100, false], ["码头操作费(THC)", "每柜", 1100, true],
      ["铅封费", "每柜", 55, true], ["单证费", "整票", 400, false],
      ["港杂费", "每柜", 50, true], ["提箱费", "每柜", 307, true],
      ["电放费", "整票", 450, false], ["设备交接单费", "每柜", 50, true],
      ["燃油附加费", "每柜", 50, true], ["订舱费", "整票", 100, false],
      ["码头信息服务费", "每柜", 7, true], ["EDI", "每柜", 3.9, true],
      ["场站费用", "每柜", 400, true],
    ].map(([name, basis, price, perCtn]) => {
      const q = perCtn ? qty : 1;
      return { cost_category: name, charge_basis: basis, currency: "CNY", qty: q, unit_price: price, amount: Number((price * q).toFixed(2)) };
    });
  }
  return { factoryCode, rows, usedFallbackCard };
}

export async function buildShippingPlanDocData(pool, id, page) {
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
    const pc = await portCharges(pool, p);
    const factory = await loadFactory(pool, pc.factoryCode);
    const totalCny = pc.rows.reduce((s, r) => s + num(r.amount), 0);
    return {
      page, shipment: common, factory, containers, charges: pc.rows,
      used_fallback_card: pc.usedFallbackCard,
      totals: { cny: Number(totalCny.toFixed(2)) },
      doc_no: "PC-" + String(p.bl_no || p.shipment_no || p.id).replace(/[^A-Z0-9]/gi, "").toUpperCase() + "-" + genDate.replace(/-/g, ""),
      pdf_type: "fob_portcharge",
    };
  }
  const customer = await loadCustomer(pool, p);
  const fxRate = await latestFx(pool);
  const totalUsd = num(p.freight_sale_usd);
  const unitPrice = containers.qty > 0 ? totalUsd / containers.qty : totalUsd;
  return {
    page: "freight", shipment: common, customer, containers,
    charges: [{ cost_category: "海运费 Ocean Freight", charge_basis: "Per Container / 箱", currency: "USD", qty: containers.qty, unit_price: unitPrice, amount: totalUsd }],
    totals: { usd: Number(totalUsd.toFixed(2)), cny: Number((totalUsd * fxRate).toFixed(2)), fx_rate: fxRate },
    doc_no: "FI-" + (p.shipment_no || String(p.id)) + "-" + genDate.replace(/-/g, ""),
    pdf_type: "fob_invoice",
  };
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
    const data = await buildShippingPlanDocData(getPool(), id, page);
    if (!data) return res.status(404).json({ error: "Shipment not found" });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
