// api/external/cards.js — Dashboard cards for this party
// GET /api/external/cards
// Returns: { success, party_type, cards: [...] }
//
// Forwarder cards: RFQ items where forwarder_company_id = my company
//   { kind: "rfq", id, pol, pod, ctnr_type, etd, my_status, my_rate, vessel, voyage }
//   my_status: pending | submitted | awarded | not_selected
//
// Factory cards: shipping_plans where factory_code = my company.code
//   { kind: "shipment", contract_no, status, ... }   (Phase 2 detail)
//
// Customer cards: orders where customer_code = my company.code
//   { kind: "order", order_no, status, etd, ... }    (Phase 2 detail)

import { externalAuth } from "./middleware.js";
import { getPool }      from "../db.js";

async function forwarderCards(pool, companyId) {
  const { rows } = await pool.query(`
    SELECT
      i.id, i.rfq_id, i.vessel, i.voyage, i.etd AS item_etd,
      i.usd_rate, i.transit_days, i.notes, i.submitted_at,
      r.pol, r.pod, r.ctnr_type, r.etd AS rfq_etd,
      r.status AS rfq_status, r.awarded_item_id, r.order_id,
      o.order_no, o.customer, o.contract_no
    FROM freight_rfq_items i
    JOIN freight_rfqs r ON r.id = i.rfq_id
    LEFT JOIN orders o ON o.id = r.order_id
    WHERE i.forwarder_company_id = $1
    ORDER BY COALESCE(r.etd, i.etd) ASC NULLS LAST, i.id DESC
  `, [companyId]);

  return rows.map(row => {
    const isAwarded   = row.awarded_item_id === row.id;
    const otherWon    = row.awarded_item_id && row.awarded_item_id !== row.id;
    const submitted   = !!row.submitted_at;
    let my_status;
    if (isAwarded)      my_status = "awarded";
    else if (otherWon)  my_status = "not_selected";
    else if (submitted) my_status = "submitted";
    else                my_status = "pending";

    return {
      kind: "rfq",
      id: row.id,
      rfq_id: row.rfq_id,
      contract_no: row.contract_no || null,
      pol: row.pol, pod: row.pod,
      ctnr_type: row.ctnr_type,
      etd: row.rfq_etd || row.item_etd,
      order_no: row.order_no,
      // forwarder never sees customer name (lens rule)
      // customer: row.customer,  // intentionally omitted
      my_status,
      // forwarder only sees own rate, not others
      my_rate: row.usd_rate ? Number(row.usd_rate) : null,
      vessel: row.vessel, voyage: row.voyage,
      transit_days: row.transit_days,
      notes: row.notes,
      submitted_at: row.submitted_at,
    };
  });
}

async function factoryCards(pool, companyCode) {
  if (!companyCode) return [];
  const { rows } = await pool.query(`
    SELECT lcs.id, lcs.order_no, lcs.contract_no, lcs.status, lcs.due_at,
           lcs.shipping_plan_id,
           sp.pol, sp.pod, sp.ctnr_type, sp.etd
    FROM loading_collab_sheets lcs
    LEFT JOIN shipping_plans sp ON sp.id = lcs.shipping_plan_id
    WHERE lcs.factory_code = $1
    ORDER BY lcs.due_at ASC NULLS LAST, lcs.id DESC
  `, [companyCode]);
  return rows.map(r => ({
    kind: "shipment",
    id: r.id,
    contract_no: r.contract_no,
    order_no: r.order_no,
    status: r.status,
    due_at: r.due_at,
    pol: r.pol, pod: r.pod,
    ctnr_type: r.ctnr_type,
    etd: r.etd,
  }));
}

async function customerCards(pool, companyCode) {
  if (!companyCode) return [];
  const { rows } = await pool.query(`
    SELECT id, order_no, contract_no, status, etd, eta, vessel, voyage,
           pol, pod
    FROM orders
    WHERE customer_code = $1
    ORDER BY etd ASC NULLS LAST, id DESC
    LIMIT 200
  `, [companyCode]);
  return rows.map(r => ({
    kind: "order",
    id: r.id,
    order_no: r.order_no,
    contract_no: r.contract_no,
    status: r.status,
    etd: r.etd, eta: r.eta,
    vessel: r.vessel, voyage: r.voyage,
    pol: r.pol, pod: r.pod,
  }));
}

async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const pool = getPool();
  const e = req.external;
  let cards = [];
  if (e.party_type === "forwarder") cards = await forwarderCards(pool, e.company_id);
  else if (e.party_type === "factory") cards = await factoryCards(pool, e.company_code);
  else if (e.party_type === "customer") cards = await customerCards(pool, e.company_code);
  return res.status(200).json({
    success: true,
    party_type: e.party_type,
    company_name: e.company_name,
    cards,
    count: cards.length,
  });
}

export default async function (req, res) {
  await externalAuth(req, res, () => handler(req, res));
}
