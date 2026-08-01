import { getPool, setCors } from "../db.js";
import { resolveForwarder } from "./_forwarder-portal-auth.js";
import { priceRfq, cleanType } from "../db/lib/rfq-pricing.js";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

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
  if (req.url.startsWith("/api/public/forwarder-rfqs") || req.path === "/api/public/forwarder-rfqs") {
    return handleForwarderRfqs(req, res, pool);
  }
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
      i.selected, i.submitted_at, i.status, i.forwarder_company_id,
      i.currency, i.free_pol_days, i.free_pod_days, i.container_type, i.carrier,
      r.pol, r.pod, r.ctnr_type, r.status AS rfq_status,
      r.etd AS rfq_etd, r.awarded_item_id
    FROM freight_rfq_items i
    JOIN freight_rfqs r ON r.id = i.rfq_id
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
    const { vessel, voyage, etd, usd_rate, transit_days, notes,
      carrier, free_pol_days, free_pod_days } = req.body || {};
    const quotedRate = usd_rate ? Number(usd_rate) : null;

    await pool.query(`
      UPDATE freight_rfq_items
      SET vessel = $1, voyage = $2, etd = $3,
          usd_rate = $4, transit_days = $5, notes = $6,
          carrier = $7, free_pol_days = $8, free_pod_days = $9,
          status = 'quoted', submitted_at = COALESCE(submitted_at, now())
      WHERE id = $10
    `, [vessel || null, voyage || null, etd || null,
        quotedRate,
        transit_days ? Number(transit_days) : null,
        notes || null, carrier || item.carrier || null,
        free_pol_days || null, free_pod_days || null, itemId]);

    if (quotedRate) await upsertRate(pool, item, {
      vessel, voyage, etd, usd_rate: quotedRate, transit_days, carrier, free_pol_days, free_pod_days,
    });

    await priceRfq(pool, item.rfq_id).catch(e => console.warn("[rfq-price:auto]", e.message));

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true, message: "Quote submitted" }));
  }

  res.writeHead(405);
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

async function upsertRate(pool, item, q) {
  const ct = cleanType(item.container_type || item.ctnr_type);
  const is20 = ct.includes("20");
  const raw = { rfq_id: item.rfq_id, rfq_item_id: item.id, vessel: q.vessel || null, voyage: q.voyage || null };
  const fwd = await pool.query(
    `SELECT COALESCE(name_cn, name_en, code, id::text) AS name FROM companies WHERE id=$1 LIMIT 1`,
    [item.forwarder_company_id]
  );
  const forwarder = fwd.rows[0]?.name || item.forwarder_co || null;
  const upd = await pool.query(
    `UPDATE freight_rates
        SET pol=$2, pod=$3, carrier=$4, forwarder=$5, supplier_id=$6,
            ${is20 ? "gp20" : "hq40"}=$7, transit_days=$8,
            free_pol_days=$9, free_pod_days=$10, sail_date=$11,
            valid_from=COALESCE(valid_from, CURRENT_DATE), status='active',
            source='rfq', currency='USD', raw=COALESCE(raw,'{}'::jsonb) || $12::jsonb, updated_at=NOW()
      WHERE raw->>'rfq_item_id' = $1
      RETURNING id`,
    [item.id, item.pol, item.pod, q.carrier || item.carrier || null, forwarder,
     item.forwarder_company_id || null, q.usd_rate, q.transit_days || null,
     q.free_pol_days || null, q.free_pod_days || null, q.etd || item.etd || item.rfq_etd || null,
     JSON.stringify(raw)]
  );
  if (upd.rows.length) return;
  await pool.query(
    `INSERT INTO freight_rates
       (pol, pod, carrier, forwarder, supplier_id, ${is20 ? "gp20" : "hq40"},
        transit_days, free_pol_days, free_pod_days, sail_date, valid_from,
        source, status, currency, raw, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_DATE,'rfq','active','USD',$11::jsonb,NOW(),NOW())`,
    [item.pol, item.pod, q.carrier || item.carrier || null, forwarder,
     item.forwarder_company_id || null, q.usd_rate, q.transit_days || null,
     q.free_pol_days || null, q.free_pod_days || null, q.etd || item.etd || item.rfq_etd || null,
     JSON.stringify(raw)]
  );
}

async function handleForwarderRfqs(req, res, pool) {
  const auth = await resolveForwarder(pool, req);
  if (auth.error) return res.status(auth.error).json(auth.body);
  const t = auth.token;
  const { rows } = await pool.query(
    `SELECT r.id, r.pol, r.pod, r.ctnr_type, r.etd, r.status, r.created_at,
            i.id AS item_id, i.status AS item_status, i.vessel, i.voyage, i.etd AS item_etd,
            i.usd_rate, i.transit_days, i.submitted_at,
            sl.code
       FROM freight_rfqs r
       JOIN freight_rfq_items i ON i.rfq_id = r.id
       LEFT JOIN LATERAL (
         SELECT code FROM freight_quote_shortlinks WHERE item_id=i.id AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
       ) sl ON TRUE
      WHERE r.status IN ('open','needs_review')
        AND r.status <> 'void'
        AND (($1::int IS NOT NULL AND i.forwarder_company_id = $1)
          OR ($2::text IS NOT NULL AND i.forwarder_co = $2))
      ORDER BY r.created_at DESC`,
    [t.company_id || null, t.forwarder_co || null]
  );
  const data = rows.map(r => ({
    id: r.id, pol: r.pol, pod: r.pod, ctnr_type: r.ctnr_type, etd: r.etd,
    // needs_review 是内部定价状态，对货代一律显示为 open
    status: r.status === "needs_review" ? "open" : r.status, created_at: r.created_at,
    item: {
      id: r.item_id, status: r.item_status, vessel: r.vessel, voyage: r.voyage,
      etd: r.item_etd, usd_rate: r.usd_rate, transit_days: r.transit_days,
      submitted_at: r.submitted_at,
      quote_url: `${APP_BASE}/freight-quote/${encodeURIComponent(r.code || r.item_id)}`,
    },
  }));
  return res.json({ ok: true, data, count: data.length });
}
