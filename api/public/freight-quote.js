import { getPool, setCors } from "../db.js";

// Public endpoint — no auth required.
// Token = freight_rfq_items.id (UUID, hard to guess).
//
// GET  /api/public/freight-quote/:itemId
//   Returns RFQ context for the forwarder to fill in.
//   If rfq.awarded_item_id is set and != this item → { awarded: false }
//   If this item is already awarded → { awarded: true }
//
// POST /api/public/freight-quote/:itemId
//   Body: { vessel, voyage, etd, usd_rate, transit_days, notes }
//   Saves quote, sets submitted_at.

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.end();

  const pool = getPool();
  let itemId = req.url.split("/").pop().split("?")[0];

  // 短码解析: 非 UUID 视为短码 → 查 freight_quote_shortlinks + 校验过期(一周)
  if (itemId && !/^[0-9a-f-]{36}$/i.test(itemId)) {
    const { rows: slRows } = await pool.query(
      "SELECT item_id, expires_at FROM freight_quote_shortlinks WHERE code = $1", [itemId]
    );
    if (!slRows.length) { res.writeHead(404); return res.end(JSON.stringify({ error: "Not found" })); }
    if (new Date(slRows[0].expires_at) < new Date()) {
      res.writeHead(410); return res.end(JSON.stringify({ error: "expired", message: "链接已过期" }));
    }
    itemId = slRows[0].item_id;
  }

  if (!itemId || !/^[0-9a-f-]{36}$/i.test(itemId)) {
    res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid token" }));
  }

  // Load item + rfq context
  const { rows: itemRows } = await pool.query(`
    SELECT
      i.id, i.rfq_id, i.forwarder_co, i.vessel, i.voyage,
      i.etd, i.usd_rate, i.transit_days, i.notes, i.internal_notes,
      i.selected, i.submitted_at,
      r.pol, r.pod, r.ctnr_type, r.status AS rfq_status,
      r.etd AS rfq_etd, r.awarded_item_id,
      r.order_id,
      o.order_no, o.contract_no, o.customer
    FROM freight_rfq_items i
    JOIN freight_rfqs r ON r.id = i.rfq_id
    LEFT JOIN orders o ON o.id = r.order_id
    WHERE i.id = $1
  `, [itemId]);

  if (!itemRows.length) {
    res.writeHead(404); return res.end(JSON.stringify({ error: "Not found" }));
  }

  const item = itemRows[0];
  const isAwarded    = item.awarded_item_id === itemId;
  const otherAwarded = item.awarded_item_id && item.awarded_item_id !== itemId;

  // GET — return context
  if (req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      success: true,
      item_id:      item.id,
      forwarder_co: item.forwarder_co,
      rfq: {
        pol:       item.pol,
        pod:       item.pod,
        ctnr_type: item.ctnr_type,
        etd:       item.rfq_etd,
        // NOTE: order_no/contract_no/customer intentionally omitted — forwarder must not see buyer identity
      },
      current: {
        vessel:       item.vessel,
        voyage:       item.voyage,
        etd:          item.etd,
        usd_rate:     item.usd_rate,
        transit_days: item.transit_days,
        // notes intentionally omitted — internal_notes must never reach forwarder; forwarder fills fresh each update
        submitted_at: item.submitted_at,
      },
      state: isAwarded ? "awarded" : otherAwarded ? "not_selected" : item.submitted_at ? "submitted" : "pending",
    }));
  }

  // POST — save quote (only if not already awarded to someone else)
  if (req.method === "POST") {
    if (otherAwarded) {
      res.writeHead(403);
      return res.end(JSON.stringify({ error: "RFQ has been awarded to another forwarder" }));
    }

    // express.json() middleware already parsed the body — use req.body directly
    const { vessel, voyage, etd, usd_rate, transit_days, notes } = req.body || {};

    await pool.query(`
      UPDATE freight_rfq_items
      SET vessel = $1, voyage = $2, etd = $3,
          usd_rate = $4, transit_days = $5, notes = $6,
          submitted_at = COALESCE(submitted_at, now())
      WHERE id = $7
    `, [vessel || null, voyage || null, etd || null,
        usd_rate ? Number(usd_rate) : null,
        transit_days ? Number(transit_days) : null,
        notes || null, itemId]);

    // Update rfq status to 'quoted' if still 'open'
    await pool.query(`
      UPDATE freight_rfqs SET status = 'quoted', updated_at = now()
      WHERE id = $1 AND status = 'open'
    `, [item.rfq_id]);

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, message: "Quote submitted" }));
  }

  res.writeHead(405);
  res.end(JSON.stringify({ error: "Method not allowed" }));
}
