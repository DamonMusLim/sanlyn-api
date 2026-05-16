// POST /api/db/shipping-arrangement-create
//
// Customer-initiated: when the customer picks a Marketplace route but has NO
// matching order in Sanlyn, they fill factory contact (email + phone + name) and
// we generate a token-gated link the factory clicks to confirm "can you ship by
// this ETD?" The link points at a no-login form that loads the corresponding
// shipping_arrangement collab sheet template.
//
// Per Marketplace Protocol v1.0 and collab privacy isolation: factory will see
// route + ETD + container count, NOT customer name or price.
import crypto from 'node:crypto';
import { getPool, setCors } from "./db.js";

function genShort() {
  return 'ARR-' + crypto.randomBytes(6).toString('base64url').toUpperCase();
}

export default async function handler(req, res) {
  setCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });
  if (!req.user)                return res.status(401).json({ error: 'Unauthorized' });

  const body  = req.body || {};
  const route = body.route || {};
  const fac   = body.factory || {};

  if (!fac.email && !fac.phone) {
    return res.status(400).json({ error: 'factory.email or factory.phone required' });
  }
  if (!route.pol || !route.pod) {
    return res.status(400).json({ error: 'route.pol and route.pod required' });
  }

  const shortCode = genShort();
  const token     = crypto.randomBytes(24).toString('hex');
  const link      = `https://collab.sanlyn.cn/s/${shortCode}`;

  // Best-effort persistence. If loading_collab_sheets schema doesn't support
  // shipping_arrangement yet, we still return the link so frontend can show it;
  // the factory click handler will fail gracefully and prompt for manual review.
  let persistedId = null;
  try {
    const pool = getPool();
    const insert = await pool.query(`
      INSERT INTO loading_collab_sheets (
        order_no, contract_no, status, assignee_name, assignee_user,
        participant_note, internal_note, products, loading,
        customer_code, factory_code, trade_terms, freight_by, created_at, updated_at
      ) VALUES (
        $1, $2, 'pending', $3, $4,
        $5, $6, '[]'::jsonb, $7::jsonb,
        $8, NULL, NULL, NULL, NOW(), NOW()
      ) RETURNING id
    `, [
      route.id || shortCode,
      shortCode,
      fac.name || 'Pending factory',
      fac.email || fac.phone,
      `Customer requested shipping arrangement via Marketplace`,
      JSON.stringify({
        sheet_type:    'shipping_arrangement',
        short_code:    shortCode,
        token,
        link,
        route,
        factory:       fac,
        initiated_by:  req.user.companyCode || req.user.sub,
        initiated_at:  new Date().toISOString(),
        notify_channels: ['email', 'sms', 'wechat'],
      }),
      JSON.stringify({
        pol: route.pol, pod: route.pod, carrier: route.carriers?.[0]?.name,
        voyage: route.carriers?.[0]?.voyage, etd: route.nextSailingDate,
        container_qty: route.nextSailingContainers,
      }),
      req.user.companyCode || null,
    ]);
    persistedId = insert.rows[0]?.id || null;
  } catch (err) {
    // Schema mismatch / table missing → return link anyway so customer UI continues
    return res.status(200).json({
      ok: true, source: 'mock-link',
      link, short_code: shortCode,
      persist_error: err.code || err.message,
      message: 'Collab sheet not persisted (schema not ready) — link returned for sharing. Real send-out will resume when shipping_arrangement is wired into loading_collab_sheets.',
    });
  }

  return res.status(200).json({
    ok: true, source: 'db',
    id: persistedId,
    link, short_code: shortCode,
    factory: fac,
    route: { pol: route.pol, pod: route.pod, etd: route.nextSailingDate },
  });
}
