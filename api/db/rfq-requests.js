// api/db/rfq-requests.js
// GET    /api/db/rfq-requests                 — list (filter: status, order_no)
// POST   /api/db/rfq-requests                 — create (auto-generates rfq_no)
// PATCH  /api/db/rfq-requests                 — update by id

import { getPool, setCors } from "../db.js";

function genRfqNo(seq) {
  const now = new Date();
  const ym  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `RFQ-${ym}-${String(seq).padStart(3, "0")}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    // ── GET ──────────────────────────────────────────────────────
    if (req.method === "GET") {
      const { status, order_no, limit = 500, offset = 0 } = req.query || {};
      const conds = [], vals = [];
      if (status)   { vals.push(status);         conds.push(`status = $${vals.length}`); }
      if (order_no) { vals.push(`%${order_no}%`); conds.push(`order_no ILIKE $${vals.length}`); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      vals.push(parseInt(limit), parseInt(offset));
      const r = await pool.query(
        `SELECT * FROM freight_rfqs ${where}
         ORDER BY created_at DESC
         LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
        vals
      );
      return res.json({ success: true, data: r.rows, count: r.rows.length });
    }

    // ── POST (create) ─────────────────────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      // Auto-generate rfq_no
      const ym  = (() => {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      })();
      const cntR = await pool.query(
        `SELECT COUNT(*)::int AS n FROM freight_rfqs WHERE rfq_no LIKE $1`,
        [`RFQ-${ym}-%`]
      );
      const seq = (cntR.rows[0].n || 0) + 1;
      const rfq_no = genRfqNo(seq);

      const r = await pool.query(
        `INSERT INTO freight_rfqs
           (rfq_no, order_no, customer, pol, pod, container_type,
            cargo_weight, cargo_cbm, target_etd, status, markup_pct, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          rfq_no,
          b.order_no || null, b.customer || null,
          b.pol || null, b.pod || null,
          b.container_type || null,
          b.cargo_weight ? Number(b.cargo_weight) : null,
          b.cargo_cbm    ? Number(b.cargo_cbm)    : null,
          b.target_etd   || null,
          b.status || "draft",
          b.markup_pct != null ? Number(b.markup_pct) : 15,
          b.notes || null,
        ]
      );
      return res.status(201).json({ success: true, data: r.rows[0] });
    }

    // ── PATCH (update) ────────────────────────────────────────────
    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: "id required" });

      const ALLOWED = [
        "order_no","customer","pol","pod","container_type",
        "cargo_weight","cargo_cbm","target_etd","status",
        "markup_pct","selected_item_id","sanlyn_quote_usd","notes",
      ];
      const sets = [], vals = [];
      for (const k of ALLOWED) {
        if (k in b) { vals.push(b[k]); sets.push(`${k} = $${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      vals.push(b.id);
      const r = await pool.query(
        `UPDATE freight_rfqs SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (!r.rows.length) return res.status(404).json({ error: "not found" });
      return res.json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[rfq-requests]", err);
    return res.status(500).json({ error: err.message });
  }
}
