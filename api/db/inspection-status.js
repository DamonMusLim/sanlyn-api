// inspection-status.js
// GET /api/db/inspection-status?order_id=<id>
// Returns:
// { required: bool, reason: string|null, sheet: {id, status, created_at}|null }

import { getPool, setCors } from './db.js';

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }

  const u = new URL(req.url, 'http://x');
  const orderId = u.searchParams.get('order_id');
  if (!orderId) { res.writeHead(400); res.end(JSON.stringify({ error: 'order_id required' })); return; }

  const pool = getPool();
  try {
    // Check if order has any HS codes requiring quarantine
    const hsRes = await pool.query(
      `SELECT DISTINCT oli.hs_code, cha.quarantine_required, cha.quarantine_note
       FROM order_line_items oli
       LEFT JOIN customs_hs_authority cha ON cha.hs_code = oli.hs_code
         OR cha.hs_code = SUBSTRING(oli.hs_code, 1, 8)
         OR cha.hs_code = SUBSTRING(oli.hs_code, 1, 10)
       WHERE oli.order_id = $1`,
      [orderId]
    );

    // Also check products table for 10-digit HS
    const p10Res = await pool.query(
      `SELECT DISTINCT p.hs_code, cha.quarantine_required, cha.quarantine_note
       FROM order_line_items oli
       JOIN products p ON p.sku = oli.sku
       LEFT JOIN customs_hs_authority cha ON cha.hs_code = p.hs_code
         OR cha.hs_code = SUBSTRING(p.hs_code, 1, 8)
       WHERE oli.order_id = $1 AND cha.quarantine_required = true`,
      [orderId]
    );

    const quarantineRows = [
      ...hsRes.rows.filter(r => r.quarantine_required === true),
      ...p10Res.rows
    ];
    const required = quarantineRows.length > 0;
    const reason = required
      ? quarantineRows.map(r => r.quarantine_note || '检疫').filter((v,i,a)=>a.indexOf(v)===i).join('；')
      : null;

    // Check inspection_request_sheets
    const sheetRes = await pool.query(
      `SELECT id, status, created_at FROM inspection_request_sheets
       WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    );
    const sheet = sheetRes.rows[0] || null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ required, reason, sheet }));
  } catch (e) {
    console.error('[inspection-status]', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}
