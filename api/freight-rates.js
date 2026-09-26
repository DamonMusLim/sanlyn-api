import { getPool, setCors } from './db.js';
import { normalizeCarrier } from './db/lib/portcharge-close-loop.js';

function normRateBody(body) {
  const out = { ...(body || {}) };
  if (Object.prototype.hasOwnProperty.call(out, 'carrier')) out.carrier = normalizeCarrier(out.carrier);
  if (Object.prototype.hasOwnProperty.call(out, 'forwarder')) out.forwarder = String(out.forwarder || '').trim();
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const pool = getPool();

  if (req.method === 'GET') {
    const { status = 'active', pol, pod } = req.query;
    const params = [];
    const conditions = [];
    if (status !== 'all') {
      params.push(status);
      conditions.push('status = $' + params.length);
    }
    if (pol) {
      params.push(pol);
      conditions.push('pol ILIKE $' + params.length);
    }
    if (pod) {
      params.push(pod);
      conditions.push('pod ILIKE $' + params.length);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    try {
      const result = await pool.query(
        'SELECT id, carrier, forwarder, pol, pod, route_code, gp20, hq40, customer_gp20, customer_hq40, this_week, next_sailing, transit_days, thc, local_charge_code, eta_date, status, remarks FROM freight_rates ' + where + ' ORDER BY pol, pod, carrier',
        params,
      );
      return res.status(200).json({ success: true, data: result.rows, count: result.rows.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const body = normRateBody(req.body || {});
    const { carrier, forwarder, pol, pod, route_code, gp20, hq40, customer_gp20, customer_hq40, this_week, next_sailing, transit_days, thc, local_charge_code, eta_date, remarks } = body;
    if (!carrier || !pol || !pod || !forwarder) return res.status(400).json({ error: 'carrier, forwarder, pol, pod required' });
    try {
      const result = await pool.query(
        'INSERT INTO freight_rates (carrier, forwarder, pol, pod, route_code, gp20, hq40, customer_gp20, customer_hq40, this_week, next_sailing, transit_days, thc, local_charge_code, eta_date, remarks, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,\'active\') RETURNING *',
        [carrier, forwarder||null, pol, pod, route_code||null, gp20||null, hq40||null, customer_gp20||null, customer_hq40||null, this_week||null, next_sailing||null, transit_days||null, thc||null, local_charge_code||null, eta_date||null, remarks||null],
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const allowed = ['carrier','forwarder','pol','pod','route_code','gp20','hq40','customer_gp20','customer_hq40','this_week','next_sailing','transit_days','thc','local_charge_code','eta_date','remarks','status'];
    const body = normRateBody(req.body || {});
    if (Object.prototype.hasOwnProperty.call(body, 'forwarder') && !body.forwarder) return res.status(400).json({ error: 'forwarder required' });
    const fields = Object.keys(body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'no updatable fields' });
    const setClauses = fields.map((f, i) => '`' + f + '` = $' + (i + 1)).join(', ');
    const values = fields.map(f => body[f]);
    values.push(id);
    try {
      const result = await pool.query(
        'UPDATE freight_rates SET ' + fields.map((f, i) => f + ' = $' + (i+1)).join(', ') + ', updated_at = now() WHERE id = $' + (fields.length+1) + ' RETURNING *',
        values,
      );
      if (!result.rows.length) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
