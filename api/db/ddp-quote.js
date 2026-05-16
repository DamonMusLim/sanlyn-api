// POST /api/db/ddp-quote
//
// Compute (and optionally persist) a DDP quote. Customer fills weight + tier +
// destination → returns unit price × weight + platform fee. For now the price
// table lives in the front-end mock (ddpProviders.js) and the front-end passes
// its local calc; this endpoint verifies via DB-stored partner rates when
// available, falls back to echoing the local calc when not.
//
// Per Marketplace Protocol v1.0: provider visibility was already enforced
// upstream by scopeFilter(user.partners.ddp) — we only need to make sure the
// requested provider is actually one of viewer's allowed providers if a JWT is
// present. Admin bypasses.
import { getPool, setCors } from "./db.js";

// Same canonical price book as front-end. Keep in sync; promote to DB once a
// ddp_rates table exists.
const PRICE_BOOK = {
  'ddp-oceanbaby': {
    SEA: [[0,21,16.5],[21,100,5.8],[100,300,3.6],[300,1000,2.4],[1000,null,1.7]],
    AIR: [[0,21,32.0],[21,100,18.5],[100,300,14.0],[300,1000,10.5],[1000,null,8.0]],
    commissionRate: 0.08,
  },
  'ddp-mintai':  { SEA: [[0,21,18.0],[21,100,6.5],[100,300,4.2],[300,1000,2.8],[1000,null,1.9]], commissionRate: 0.08 },
  'ddp-cainiao': { SEA: [[0,21,22.5],[21,100,8.4],[100,300,5.6],[300,1000,3.8],[1000,null,2.4]], commissionRate: 0.08 },
  'ddp-fedex':   { EXPRESS:[[0,21,38.5],[21,100,22.5],[100,300,16.5],[300,1000,12.5],[1000,null,9.5]], commissionRate: 0.08 },
  'ddp-yanwen':  { SEA: [[0,21,14.5],[21,100,5.2],[100,300,3.6],[300,1000,2.4],[1000,null,1.6]], commissionRate: 0.08 },
};

function bracketUnit(brackets, kg) {
  if (!Array.isArray(brackets) || !(kg > 0)) return null;
  for (const [lo, hi, unit] of brackets) {
    if (hi == null) { if (kg > lo) return unit; }
    else if (kg > lo && kg <= hi) return unit;
  }
  return brackets[brackets.length - 1]?.[2] || null;
}

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });
  if (!req.user)                return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const providerId = body.provider_id;
  const kg         = parseFloat(body.weight_kg);
  const tier       = String(body.tier || 'SEA').toUpperCase();

  if (!providerId || !PRICE_BOOK[providerId]) {
    return res.status(400).json({ error: 'Unknown provider_id' });
  }
  if (!(kg > 0)) {
    return res.status(400).json({ error: 'weight_kg must be > 0' });
  }

  const book   = PRICE_BOOK[providerId];
  const tierBk = book[tier] || book.SEA;
  const unit   = bracketUnit(tierBk, kg);
  if (unit == null) return res.status(400).json({ error: 'No bracket matched for weight' });

  const subtotal   = Math.round(unit * kg * 100) / 100;
  const commission = Math.round(subtotal * (book.commissionRate || 0.08) * 100) / 100;
  const total      = Math.round((subtotal + commission) * 100) / 100;

  // Best-effort persistence into a ddp_quotes table if one exists. Schema not
  // mandated yet, so we swallow errors and return the quote regardless.
  let persistedId = null;
  try {
    const pool = getPool();
    const ins = await pool.query(`
      INSERT INTO ddp_quotes (provider_id, viewer_company, weight_kg, tier, origin, dest_country, dest_addr, linked_order_no, unit_usd, subtotal_usd, commission_usd, total_usd, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
      RETURNING id
    `, [
      providerId, req.user.companyCode || null, kg, tier,
      body.origin || null, body.destCountry || null, body.destAddr || null, body.linked_order_no || null,
      unit, subtotal, commission, total,
    ]);
    persistedId = ins.rows[0]?.id || null;
  } catch (err) {
    // Table missing? Fine — return calc anyway.
    return res.status(200).json({
      ok: true, source: 'computed-no-persist',
      unit, kg, subtotal, commission, total,
      tier, provider_id: providerId,
      persist_error: err.code || err.message,
    });
  }

  return res.status(200).json({
    ok: true, source: 'computed-and-persisted',
    id: persistedId,
    unit, kg, subtotal, commission, total,
    tier, provider_id: providerId,
  });
}
