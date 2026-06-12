// api/external/quote.js — Forwarder submits/updates a quote on an RFQ item
// POST /api/external/quote
// Body: { item_id, vessel, voyage, etd, usd_rate, transit_days, notes }
// Auth: token must be party_type='forwarder' AND own this rfq_item (forwarder_company_id)
import { externalAuth } from "./middleware.js";
import { getPool }      from "../db.js";

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const e = req.external;
  if (e.party_type !== "forwarder") {
    return res.status(403).json({ error: "Only forwarders can submit quotes" });
  }
  const { item_id, vessel, voyage, etd, usd_rate, transit_days, notes } = req.body || {};
  if (!item_id) return res.status(400).json({ error: "item_id required" });

  const pool = getPool();
  // Verify ownership
  const { rows: own } = await pool.query(`
    SELECT i.id, i.rfq_id, r.awarded_item_id
    FROM freight_rfq_items i JOIN freight_rfqs r ON r.id = i.rfq_id
    WHERE i.id = $1 AND i.forwarder_company_id = $2
  `, [item_id, e.company_id]);
  if (!own.length) {
    return res.status(403).json({ error: "Not your RFQ item" });
  }
  // Cannot submit if already awarded to someone else
  if (own[0].awarded_item_id && own[0].awarded_item_id !== item_id) {
    return res.status(403).json({ error: "RFQ has been awarded to another forwarder" });
  }

  await pool.query(`
    UPDATE freight_rfq_items
    SET vessel = $1, voyage = $2, etd = $3, usd_rate = $4,
        transit_days = $5, notes = $6,
        submitted_at = COALESCE(submitted_at, NOW())
    WHERE id = $7
  `, [
    vessel || null, voyage || null, etd || null,
    usd_rate ? Number(usd_rate) : null,
    transit_days ? Number(transit_days) : null,
    notes || null, item_id,
  ]);

  // Promote rfq status to 'quoted' if still 'open'
  await pool.query(`
    UPDATE freight_rfqs SET status = 'quoted', updated_at = NOW()
    WHERE id = $1 AND status = 'open'
  `, [own[0].rfq_id]);

  return res.status(200).json({ success: true });
}

export default async function (req, res) {
  await externalAuth(req, res, () => handler(req, res));
}
