// /api/db/manifest-compose - read-only manifest draft composer
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const clean = v => (v == null ? "" : String(v).trim());
const nval = v => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const gap = (gaps, field, reason) => gaps.push({ field, reason });
const missing = (gaps, field, source) => gap(gaps, field, `${source} 取不到`);

function valueFrom(row, fields) {
  for (const field of fields) {
    const value = clean(row?.[field]);
    if (value) return { value, source: `shipping_plans.${field}` };
  }
  return { value: null, source: "" };
}

function defaultParty(dp, type) {
  const nested = dp?.[type] || {};
  const name = clean(dp?.[`${type}_name`]) || clean(nested.name);
  if (!name) return null;
  return {
    name,
    address: clean(dp?.[`${type}_address`]) || clean(nested.address) || null,
    country_code: clean(dp?.[`${type}_country_code`]) || clean(nested.country_code) || null,
    aeo_code: clean(dp?.[`${type}_aeo_code`]) || clean(nested.aeo_code) || null,
    source: "default_parties",
  };
}

function fallbackParty(sp, type) {
  const fields = type === "shipper" ? ["shipper"] : ["customer_en", "customer"];
  const found = valueFrom(sp, fields);
  return found.value ? { name: found.value, address: null, country_code: null, aeo_code: null, source: "shipping_plans" } : null;
}

function buildParty(sp, dp, type, gaps) {
  const party = defaultParty(dp, type) || fallbackParty(sp, type);
  if (!party) {
    const source = type === "shipper" ? "default_parties/shipping_plans.shipper" : "default_parties/shipping_plans.customer_en/customer";
    missing(gaps, type, source);
    return { name: null, address: null, country_code: null, aeo_code: null, source: null };
  }
  for (const field of ["address", "country_code", "aeo_code"]) {
    if (!party[field]) missing(gaps, `${type}.${field}`, party.source);
  }
  return party;
}

async function loadShippingPlan(pool, id) {
  const result = await pool.query(
    `SELECT sp.*, c.default_parties
     FROM shipping_plans sp
     LEFT JOIN companies c ON c.code = sp.company_code
     WHERE sp.id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function loadPorts(pool, pol, pod) {
  const codes = [clean(pol), clean(pod)].filter(Boolean);
  if (!codes.length) return new Map();
  const result = await pool.query(
    `SELECT code, unlocode, name_en
     FROM ports
     WHERE code = ANY($1::text[]) OR unlocode = ANY($1::text[])`,
    [codes]
  );
  const ports = new Map();
  for (const row of result.rows) {
    if (row.code && row.name_en) ports.set(clean(row.code), row.name_en);
    if (row.unlocode && row.name_en) ports.set(clean(row.unlocode), row.name_en);
  }
  return ports;
}

async function loadContainers(pool, id) {
  const result = await pool.query(
    `SELECT container_no, seal_no, container_type, tare_kg, vgm_weight_kg
     FROM container_bookings
     WHERE shipping_plan_id = $1
     ORDER BY container_no`,
    [id]
  );
  return result.rows;
}

async function loadLines(pool, shippingPlanId) {
  const result = await pool.query(
    `SELECT oli.declaration_name_en, oli.declaration_name, oli.hs_code, oli.qty_ctn AS ctns,
            oli.unit AS pkg_unit,
            CASE WHEN oli.gw_ctn IS NULL OR oli.qty_ctn IS NULL THEN NULL ELSE oli.gw_ctn * oli.qty_ctn END AS gw_kg,
            CASE WHEN oli.nw_ctn IS NULL OR oli.qty_ctn IS NULL THEN NULL ELSE oli.nw_ctn * oli.qty_ctn END AS nw_kg,
            CASE WHEN oli.cbm_ctn IS NULL OR oli.qty_ctn IS NULL THEN NULL ELSE oli.cbm_ctn * oli.qty_ctn END AS cbm,
            oli.bl_description, oli.un_no, oli.is_dangerous_goods, o.marks, l."关联方式" AS link_via
     FROM v_plan_order_link l
     JOIN order_line_items oli ON oli.order_id = l.order_id
     JOIN orders o ON o.id = l.order_id
     WHERE l.shipping_plan_id = $1
     ORDER BY l.contract_no, l.order_no, oli.id`,
    [shippingPlanId]
  );
  return result.rows;
}

function buildHeader(sp, ports, gaps) {
  const port = v => {
    const key = clean(v);
    return key ? ports.get(key) || key : null;
  };
  const header = {
    vessel: clean(sp.vessel) || null,
    voyage: clean(sp.voyage) || null,
    pol: port(sp.pol),
    pod: port(sp.pod),
    bl_no: clean(sp.bl_no) || null,
    etd: sp.etd || null,
    sinotrans_no: clean(sp.sinotrans_no) || null,
  };
  for (const [field, value] of Object.entries(header)) {
    if (!value) missing(gaps, `header.${field}`, `shipping_plans.${field}`);
  }
  return header;
}

function buildContainers(rows, gaps) {
  return rows.map((row, index) => {
    const item = {
      container_no: clean(row.container_no) || null,
      seal_no: clean(row.seal_no) || null,
      container_type: clean(row.container_type) || null,
      tare_kg: nval(row.tare_kg),
      vgm_weight_kg: nval(row.vgm_weight_kg),
    };
    for (const [field, value] of Object.entries(item)) {
      if (value == null || value === "") missing(gaps, `containers[${index}].${field}`, `container_bookings.${field}`);
    }
    return item;
  });
}

function buildLines(rows, sp, gaps) {
  if (rows.length) gap(gaps, "lines.dg_class", "order_line_items 无危险品类别列,需报关环节补");
  return rows.map((row, index) => {
    const item = {
      declaration_name: clean(row.declaration_name_en) || clean(row.declaration_name) || null,
      hs_code: clean(row.hs_code) || null,
      ctns: nval(row.ctns),
      pkg_unit: clean(row.pkg_unit) || null,
      gw_kg: nval(row.gw_kg),
      nw_kg: nval(row.nw_kg),
      cbm: nval(row.cbm),
      bl_description: clean(row.bl_description) || null,
      marks: clean(row.marks) || null,
      un_no: clean(row.un_no) || null,
      is_dangerous_goods: row.is_dangerous_goods,
      dg_class: null,
      link_via: clean(row.link_via) || null,
    };
    for (const [field, value] of Object.entries(item)) {
      if (field === "dg_class") continue;
      if (field === "link_via") continue;
      if (field === "un_no" && !row.is_dangerous_goods) continue;
      if (value == null || value === "") missing(gaps, `lines[${index}].${field}`, field === "marks" ? "orders.marks" : "order_line_items/shipping_plans");
    }
    return item;
  });
}

function compareTotal(gaps, field, whole, lines) {
  if (whole != null && lines != null && Math.abs(Number(whole) - Number(lines)) > 0.0001) {
    gap(gaps, `totals.${field}`, `shipping_plans 整票值 ${whole} 与 lines 累加值 ${lines} 不一致`);
  }
}

function sumLines(lines, field) {
  let sum = 0;
  for (const row of lines) {
    const value = nval(row[field]);
    if (value == null) return null;
    sum += value;
  }
  return sum;
}

function buildTotals(sp, lines, containers, gaps) {
  const ctns = valueFrom(sp, ["actual_pkgs", "total_cartons"]);
  const gw = valueFrom(sp, ["actual_gross_weight_kg", "gross_weight_kg"]);
  const cbm = valueFrom(sp, ["actual_cbm", "total_cbm"]);
  const totals = { ctns: nval(ctns.value), gw_kg: nval(gw.value), cbm: nval(cbm.value), container_count: containers.length };
  const totalsFromLines = {
    ctns: sumLines(lines, "ctns"),
    gw_kg: sumLines(lines, "gw_kg"),
    cbm: sumLines(lines, "cbm"),
    container_count: containers.length,
  };
  if (totals.ctns == null) missing(gaps, "totals.ctns", "shipping_plans.actual_pkgs/total_cartons");
  if (totals.gw_kg == null) missing(gaps, "totals.gw_kg", "shipping_plans.actual_gross_weight_kg/gross_weight_kg");
  if (totals.cbm == null) missing(gaps, "totals.cbm", "shipping_plans.actual_cbm/total_cbm");
  compareTotal(gaps, "ctns", totals.ctns, totalsFromLines.ctns);
  compareTotal(gaps, "gw_kg", totals.gw_kg, totalsFromLines.gw_kg);
  compareTotal(gaps, "cbm", totals.cbm, totalsFromLines.cbm);
  return { totals, totalsFromLines, totalSources: { ctns: ctns.source, gw_kg: gw.source, cbm: cbm.source } };
}

function buildSources(sp, totalSources) {
  const partySource = fields => fields.find(field => clean(sp?.[field])) || fields[0];
  return {
    vessel: "shipping_plans.vessel",
    voyage: "shipping_plans.voyage",
    pol: "shipping_plans.pol; ports.name_en by code/unlocode when matched",
    pod: "shipping_plans.pod; ports.name_en by code/unlocode when matched",
    bl_no: "shipping_plans.bl_no",
    etd: "shipping_plans.etd",
    sinotrans_no: "shipping_plans.sinotrans_no",
    shipper: `shipping_plans.${partySource(["shipper"])} or companies.default_parties`,
    consignee: `shipping_plans.${partySource(["customer_en", "customer"])} or companies.default_parties`,
    notify: "none",
    containers: "container_bookings by shipping_plan_id",
    lines: "v_plan_order_link + order_line_items; marks from orders.marks",
    totals_ctns: totalSources.ctns,
    totals_gw_kg: totalSources.gw_kg,
    totals_cbm: totalSources.cbm,
  };
}

function contractNo(sp) {
  const single = clean(sp.contract_no);
  if (single) return single;
  return Array.isArray(sp.contract_nos) && sp.contract_nos.length ? sp.contract_nos.map(clean).filter(Boolean).join(",") || null : null;
}

function forcedGapNote(gaps) {
  if (!gaps.length) return null;
  return `⚠️ 带缺口落库,缺:${gaps.map(g => g.field).join(",")}`;
}

async function writeManifest(client, sp, header, parties, containers, lines, gaps) {
  const notes = forcedGapNote(gaps);
  const shipment = {
    shipment_no: clean(sp.shipment_no) || header.bl_no,
    company_code: clean(sp.company_code) || null,
    contract_no: contractNo(sp),
    bl_no: header.bl_no,
    vessel: header.vessel,
    voyage: header.voyage,
    pol: header.pol,
    pod: header.pod,
    forwarder: clean(sp.forwarder) || null,
    etd: header.etd,
    status: clean(sp.status) || null,
    notes,
    created_by: clean(sp.created_by) || null,
    carrier: clean(sp.carrier) || null,
    cargo_type: clean(sp.cargo_type) || null,
    transport_terms: clean(sp.transport_terms) || null,
    payment_method: clean(sp.payment_method) || null,
    bl_type: clean(sp.bl_type) || null,
    bl_copies: nval(sp.bl_copies),
    place_of_issue: clean(sp.place_of_issue) || null,
    payment_place: clean(sp.payment_place) || null,
    shipping_agent: clean(sp.shipping_agent) || clean(sp.carrier_agent) || null,
    shipper_name: parties.shipper.name,
    shipper_address: parties.shipper.address,
    shipper_country_code: parties.shipper.country_code,
    shipper_aeo_code: parties.shipper.aeo_code,
    consignee_name: parties.consignee.name,
    consignee_address: parties.consignee.address,
    consignee_country_code: parties.consignee.country_code,
    consignee_aeo_code: parties.consignee.aeo_code,
    notify_name: parties.notify?.name || null,
    notify_address: parties.notify?.address || null,
    notify_country_code: parties.notify?.country_code || null,
    notify_aeo_code: parties.notify?.aeo_code || null,
    place_of_receipt: clean(sp.place_of_receipt) || null,
    final_destination: clean(sp.place_of_delivery) || clean(sp.final_destination) || null,
    sinotrans_no: header.sinotrans_no,
  };
  const columns = Object.keys(shipment);
  const values = Object.values(shipment);
  const existing = await client.query(`SELECT id FROM customs_shipments WHERE bl_no = $1 LIMIT 1 FOR UPDATE`, [header.bl_no]);
  let shipmentId;
  if (existing.rows[0]) {
    const sets = columns.map((column, index) => `${column} = $${index + 1}`).join(", ");
    const result = await client.query(
      `UPDATE customs_shipments SET ${sets}, updated_at = NOW() WHERE id = $${columns.length + 1} RETURNING id`,
      [...values, existing.rows[0].id]
    );
    shipmentId = result.rows[0].id;
  } else {
    const params = columns.map((_, index) => `$${index + 1}`).join(", ");
    const result = await client.query(
      `INSERT INTO customs_shipments (${columns.join(", ")}) VALUES (${params}) RETURNING id`,
      values
    );
    shipmentId = result.rows[0].id;
  }
  await client.query(`DELETE FROM customs_shipment_containers WHERE shipment_id = $1`, [shipmentId]);
  await client.query(`DELETE FROM customs_shipment_lines WHERE shipment_id = $1`, [shipmentId]);
  for (const row of containers) {
    await client.query(
      `INSERT INTO customs_shipment_containers
       (shipment_id, container_no, seal_no, container_type, tare_kg, vgm_weight_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [shipmentId, row.container_no, row.seal_no, row.container_type, row.tare_kg, row.vgm_weight_kg == null ? null : "container_bookings.vgm_weight_kg"]
    );
  }
  for (const [index, row] of lines.entries()) {
    await client.query(
      `INSERT INTO customs_shipment_lines
       (shipment_id, declaration_name, hs_code, ctns, nw_kg, gw_kg, cbm, is_dangerous_goods, un_no, sort_order, pkg_unit, marks, dg_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [shipmentId, row.declaration_name, row.hs_code, row.ctns, row.nw_kg, row.gw_kg, row.cbm, row.is_dangerous_goods, row.un_no, index, row.pkg_unit, row.marks, row.dg_class]
    );
  }
  return shipmentId;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST required" });
  if (!requireAuth(req, res)) return;

  const shippingPlanId = Number(req.body?.shipping_plan_id);
  if (!Number.isInteger(shippingPlanId) || shippingPlanId <= 0) {
    return res.status(400).json({ success: false, error: "shipping_plan_id must be a positive integer" });
  }
  const commit = req.body?.commit === true;
  const force = req.body?.force === true;

  const pool = getPool();
  try {
    const sp = await loadShippingPlan(pool, shippingPlanId);
    if (!sp) return res.status(404).json({ success: false, error: "shipping_plan not found" });

    const gaps = [];
    const ports = await loadPorts(pool, sp.pol, sp.pod);
    const containerRows = await loadContainers(pool, shippingPlanId);
    const lineRows = await loadLines(pool, shippingPlanId);
    const header = buildHeader(sp, ports, gaps);
    const parties = {
      shipper: buildParty(sp, sp.default_parties || {}, "shipper", gaps),
      consignee: buildParty(sp, sp.default_parties || {}, "consignee", gaps),
      notify: null,
    };
    gap(gaps, "notify", "全库无通知人数据,需业务确认");
    const containers = buildContainers(containerRows, gaps);
    const lines = buildLines(lineRows, sp, gaps);
    if (!containers.length) missing(gaps, "containers", "container_bookings");
    if (!lines.length) missing(gaps, "lines", "orders/order_line_items");
    const { totals, totalsFromLines, totalSources } = buildTotals(sp, lines, containers, gaps);
    if (commit && gaps.length && !force) {
      return res.status(409).json({ success: false, dry_run: true, shipping_plan_id: shippingPlanId, gaps });
    }
    if (commit && !header.bl_no) {
      return res.status(409).json({ success: false, dry_run: true, shipping_plan_id: shippingPlanId, error: "bl_no required for idempotent commit", gaps });
    }
    if (commit) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const shipmentId = await writeManifest(client, sp, header, parties, containers, lines, gaps);
        await client.query("COMMIT");
        return res.json({
          success: true, dry_run: false, shipment_id: shipmentId,
          written: { header: 1, containers: containers.length, lines: lines.length }, gaps,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return res.json({
      success: true, dry_run: true, shipping_plan_id: shippingPlanId, header, parties,
      containers, lines, totals, totals_from_lines: totalsFromLines, gaps,
      sources: buildSources(sp, totalSources),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
