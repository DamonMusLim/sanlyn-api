// /api/db/customs-shipment-summary.js
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function canRead(user) {
  return READ_ROLES.has(user?.role);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, digits = 2) {
  return Number(num(v).toFixed(digits));
}

function lineOut(row) {
  return {
    id: row.id,
    declaration_name: row.declaration_name,
    hs_code: row.hs_code,
    declaration_elements: row.declaration_elements,
    ctns: round(row.ctns, 3),
    nw_kg: round(row.nw_kg),
    gw_kg: round(row.gw_kg),
    cbm: round(row.cbm, 4),
    amount: round(row.amount),
    currency: row.currency,
    requires_quarantine_cert: row.requires_quarantine_cert,
    contains_meat: row.contains_meat,
    is_dangerous_goods: row.is_dangerous_goods,
    un_no: row.un_no,
  };
}

function addTotals(target, row) {
  target.ctns += num(row.ctns);
  target.nw_kg += num(row.nw_kg);
  target.gw_kg += num(row.gw_kg);
  target.cbm += num(row.cbm);
  target.amount += num(row.amount);
}

function finishTotals(t) {
  return {
    ctns: round(t.ctns, 3),
    nw_kg: round(t.nw_kg),
    gw_kg: round(t.gw_kg),
    cbm: round(t.cbm, 4),
    amount: round(t.amount),
  };
}

async function findShipment(pool, q) {
  const conds = [], params = [];
  if (q.id) {
    params.push(parseInt(q.id, 10));
    conds.push(`id = $${params.length}`);
  }
  if (q.shipment_no) {
    params.push(String(q.shipment_no).trim());
    conds.push(`shipment_no = $${params.length}`);
  }
  if (q.bl_no) {
    params.push(String(q.bl_no).trim());
    conds.push(`bl_no = $${params.length}`);
  }
  if (!conds.length) return null;
  const r = await pool.query(`SELECT * FROM customs_shipments WHERE ${conds.join(" AND ")} LIMIT 1`, params);
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canRead(req.user)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");

  const pool = getPool();
  try {
    const shipment = await findShipment(pool, req.query || {});
    if (!shipment) return fail(res, 404, "shipment not found");

    const containers = await pool.query(
      `SELECT * FROM customs_shipment_containers
       WHERE shipment_id = $1 ORDER BY id ASC`,
      [shipment.id]
    );
    const lines = await pool.query(
      `SELECT * FROM customs_shipment_lines
       WHERE shipment_id = $1 ORDER BY sort_order ASC, id ASC`,
      [shipment.id]
    );

    const byName = new Map();
    const totals = { ctns: 0, nw_kg: 0, gw_kg: 0, cbm: 0, amount: 0 };
    for (const row of lines.rows) {
      const key = row.declaration_name;
      if (!byName.has(key)) {
        byName.set(key, {
          declaration_name: row.declaration_name,
          hs_code: row.hs_code,
          ctns: 0,
          nw_kg: 0,
          gw_kg: 0,
          cbm: 0,
          amount: 0,
        });
      }
      const acc = byName.get(key);
      if (!acc.hs_code && row.hs_code) acc.hs_code = row.hs_code;
      addTotals(acc, row);
      addTotals(totals, row);
    }

    const linesByContainer = new Map();
    for (const row of lines.rows) {
      const key = row.container_id || 0;
      if (!linesByContainer.has(key)) linesByContainer.set(key, []);
      linesByContainer.get(key).push(lineOut(row));
    }

    const byContainer = containers.rows.map(c => {
      const ownLines = linesByContainer.get(c.id) || [];
      const ownTotals = ownLines.reduce((acc, row) => {
        addTotals(acc, row);
        return acc;
      }, { ctns: 0, nw_kg: 0, gw_kg: 0, cbm: 0, amount: 0 });
      const tare = num(c.tare_kg);
      return {
        id: c.id,
        container_no: c.container_no,
        seal_no: c.seal_no,
        container_type: c.container_type,
        truck_no: c.truck_no,
        driver_name: c.driver_name,
        driver_tel: c.driver_tel,
        load_location: c.load_location,
        pickup_location: c.pickup_location,
        port_location: c.port_location,
        white_card_no: c.white_card_no,
        tare_kg: c.tare_kg == null ? null : round(c.tare_kg),
        vgm_kg: c.tare_kg == null ? null : round(tare + ownTotals.gw_kg),
        lines: ownLines,
        totals: finishTotals(ownTotals),
      };
    });

    const looseLines = linesByContainer.get(0) || [];
    if (looseLines.length) {
      byContainer.push({
        id: null,
        container_no: null,
        seal_no: null,
        truck_no: null,
        tare_kg: null,
        vgm_kg: null,
        lines: looseLines,
        totals: finishTotals(looseLines.reduce((acc, row) => {
          addTotals(acc, row);
          return acc;
        }, { ctns: 0, nw_kg: 0, gw_kg: 0, cbm: 0, amount: 0 })),
      });
    }

    return res.status(200).json({
      success: true,
      shipment,
      lines: Array.from(byName.values()).map(finishTotalsLine),
      by_container: byContainer,
      totals: finishTotals(totals),
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return fail(res, 500, err.message);
  }
}

function finishTotalsLine(row) {
  return {
    declaration_name: row.declaration_name,
    hs_code: row.hs_code,
    ctns: round(row.ctns, 3),
    nw_kg: round(row.nw_kg),
    gw_kg: round(row.gw_kg),
    cbm: round(row.cbm, 4),
    amount: round(row.amount),
  };
}
