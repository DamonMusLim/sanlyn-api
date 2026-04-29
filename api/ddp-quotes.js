import { getPool, setCors } from "./db.js";

// GET  /api/ddp-quotes          — list (filter: status, country, source)
// POST /api/ddp-quotes          — create quote
// PATCH /api/ddp-quotes?id=xxx  — update quote fields / status

function genRef() {
  const d = new Date();
  const ymd = d.toISOString().slice(0,10).replace(/-/g,'');
  const rnd = Math.floor(Math.random()*900)+100;
  return `DDP-${ymd}-${rnd}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── GET ─────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { status, country, source, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    if (status)  { params.push(status);  conditions.push(`status = $${params.length}`); }
    if (country) { params.push(country); conditions.push(`country ILIKE $${params.length}`); }
    if (source)  { params.push(source);  conditions.push(`source = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(parseInt(limit), parseInt(offset));
    const rows = await pool.query(
      `SELECT * FROM ddp_quotes ${where} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM ddp_quotes ${where}`,
      params.slice(0, -2)
    );
    return res.status(200).json({
      success: true,
      data: rows.rows,
      count: parseInt(countRes.rows[0].count),
    });
  }

  // ── POST ────────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const {
      customerName, customerId, country, flag, subRegion,
      mode, tier, cargo, pickupAddress, pickupRegion,
      deliveryAddress, domesticFeeMin, domesticFeeMax,
      intlRefPrice, markupPct = 15, displayPrice,
      status = "draft", source = "manual",
      rawOcr, photos = [], notes, createdBy,
    } = req.body;

    if (!country) return res.status(400).json({ success: false, error: "country required" });

    const refNo = genRef();

    const { rows } = await pool.query(
      `INSERT INTO ddp_quotes (
        ref_no, customer_name, customer_id, country, flag, sub_region,
        mode, tier, cargo, pickup_address, pickup_region,
        delivery_address, domestic_fee_min, domestic_fee_max,
        intl_ref_price, markup_pct, display_price,
        status, source, raw_ocr, photos, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING *`,
      [
        refNo, customerName||null, customerId||null, country, flag||null, subRegion||null,
        mode||null, tier||null,
        cargo ? JSON.stringify(cargo) : "{}",
        pickupAddress||null, pickupRegion||null,
        deliveryAddress||null, domesticFeeMin||null, domesticFeeMax||null,
        intlRefPrice||null, markupPct, displayPrice||null,
        status, source,
        rawOcr ? JSON.stringify(rawOcr) : null,
        JSON.stringify(photos), notes||null, createdBy||null,
      ]
    );

    return res.status(201).json({ success: true, data: rows[0] });
  }

  // ── PATCH ───────────────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: "id required" });

    const allowed = [
      "customer_name","country","flag","sub_region","mode","tier",
      "cargo","pickup_address","pickup_region","delivery_address",
      "domestic_fee_min","domestic_fee_max","intl_ref_price",
      "markup_pct","display_price","status","notes","photos",
    ];
    const body = req.body;
    const sets = [];
    const params = [id];

    for (const key of allowed) {
      // accept both camelCase and snake_case from frontend
      const camel = key.replace(/_([a-z])/g, (_,c) => c.toUpperCase());
      const val = body[key] ?? body[camel];
      if (val === undefined) continue;
      params.push(typeof val === "object" ? JSON.stringify(val) : val);
      sets.push(`${key} = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, error: "nothing to update" });
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);

    const { rows } = await pool.query(
      `UPDATE ddp_quotes SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "not found" });
    return res.status(200).json({ success: true, data: rows[0] });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
