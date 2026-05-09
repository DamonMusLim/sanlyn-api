// api/db/rfq-items.js
// GET    /api/db/rfq-items?rfq_id=N            — list items for one RFQ
// POST   /api/db/rfq-items                     — create item (auto-calculates total_usd)
// PATCH  /api/db/rfq-items                     — update item by id

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    // ── GET ──────────────────────────────────────────────────────
    if (req.method === "GET") {
      const { rfq_id, limit = 200 } = req.query || {};
      if (!rfq_id) return res.status(400).json({ error: "rfq_id required" });
      const r = await pool.query(
        `SELECT * FROM freight_rfq_items WHERE rfq_id = $1 ORDER BY created_at ASC LIMIT $2`,
        [parseInt(rfq_id), parseInt(limit)]
      );
      return res.json({ success: true, data: r.rows, count: r.rows.length });
    }

    // ── POST (create) ─────────────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.rfq_id) return res.status(400).json({ error: "rfq_id required" });
      const freight   = Number(b.freight_usd    || 0);
      const surcharge = Number(b.port_surcharge || 0);
      const thc       = Number(b.thc            || 0);
      const doc       = Number(b.doc_fee        || 0);
      const total     = freight + surcharge + thc + doc;
      const r = await pool.query(
        `INSERT INTO freight_rfq_items
           (rfq_id, forwarder_name, freight_usd, port_surcharge, thc, doc_fee,
            total_usd, transit_days, valid_until, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          parseInt(b.rfq_id),
          b.forwarder_name || null,
          freight || null, surcharge || null, thc || null, doc || null,
          total || null,
          b.transit_days ? parseInt(b.transit_days) : null,
          b.valid_until  || null,
          b.notes        || null,
        ]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    }

    // ── PATCH (update) ────────────────────────────────────────────
    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id required" });
      const ALLOWED = [
        "forwarder_name","freight_usd","port_surcharge","thc","doc_fee",
        "total_usd","transit_days","valid_until","notes",
      ];
      const sets = [], vals = [];
      for (const k of ALLOWED) {
        if (k in b) { vals.push(b[k]); sets.push(`${k} = $${vals.length}`); }
      }
      // Recalculate total if any cost field changed
      const costFields = ["freight_usd","port_surcharge","thc","doc_fee"];
      if (costFields.some(k => k in b)) {
        // Fetch current row to sum
        const cur = await pool.query("SELECT * FROM freight_rfq_items WHERE id=$1",[b.id]);
        if (cur.rows.length) {
          const row = cur.rows[0];
          const total = (Number(b.freight_usd    ?? row.freight_usd    ?? 0))
                      + (Number(b.port_surcharge ?? row.port_surcharge ?? 0))
                      + (Number(b.thc            ?? row.thc            ?? 0))
                      + (Number(b.doc_fee        ?? row.doc_fee        ?? 0));
          // Ensure total_usd is in the update
          if (!("total_usd" in b)) { vals.push(total); sets.push(`total_usd = $${vals.length}`); }
        }
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      vals.push(b.id);
      const r = await pool.query(
        `UPDATE freight_rfq_items SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (!r.rows.length) return res.status(404).json({ error: "not found" });
      return res.json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[rfq-items]", err);
    return res.status(500).json({ error: err.message });
  }
}
