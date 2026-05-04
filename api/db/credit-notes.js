// api/db/credit-notes.js
// GET  /api/db/credit-notes          — list (filter: company_code, order_no, status)
// POST /api/db/credit-notes          — create
// GET  /api/db/credit-notes?id=123   — single record
// POST /api/db/credit-notes?action=update_status — update status/pdf_url

import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  // ── GET ──────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, company_code, order_no, status, limit = 50, offset = 0 } = req.query;

    // Single record by id
    if (id) {
      const r = await pool.query(
        'SELECT * FROM credit_notes WHERE id = $1', [id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ success: true, data: r.rows[0] });
    }

    // Fail-closed scoping for non-admin
    let where = [];
    let params = [];
    let idx = 1;

    if (req.user?.role !== 'admin') {
      const codes = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : null);
      if (!codes?.length) return res.status(403).json({ error: 'Scope missing' });
      const ph = codes.map(() => '$' + idx++).join(',');
      codes.forEach(c => params.push(c));
      where.push(`company_code IN (${ph})`);
    } else {
      if (company_code) { where.push(`company_code = $${idx++}`); params.push(company_code); }
    }

    if (order_no) { where.push(`order_no ILIKE $${idx++}`); params.push(`%${order_no}%`); }
    if (status)   { where.push(`status = $${idx++}`);        params.push(status); }

    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT * FROM credit_notes${w} ORDER BY issued_date DESC, created_at DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), parseInt(offset));

    const r = await pool.query(sql, params);
    return res.json({ success: true, data: r.rows, count: r.rows.length });
  }

  // ── POST ─────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.query;

    // Update status / pdf_url
    if (action === 'update_status') {
      const { id, status, pdf_url } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      const allowed = ['draft', 'issued', 'acknowledged'];
      if (status && !allowed.includes(status))
        return res.status(400).json({ error: 'Invalid status' });

      const sets = []; const params = []; let idx = 1;
      if (status)  { sets.push(`status = $${idx++}`);   params.push(status); }
      if (pdf_url) { sets.push(`pdf_url = $${idx++}`);  params.push(pdf_url); }
      sets.push(`updated_at = NOW()`);
      params.push(id);

      const r = await pool.query(
        `UPDATE credit_notes SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
        params
      );
      return res.json({ success: true, data: r.rows[0] });
    }

    // Create new CN
    const {
      cn_no, company_code, company_name,
      order_no, contract_no, invoice_no,
      issued_date, currency = 'CNY',
      net_amount, lang = 'en', note, items = []
    } = req.body;

    // Validation
    if (!cn_no)         return res.status(400).json({ error: 'cn_no required' });
    if (!company_code)  return res.status(400).json({ error: 'company_code required' });
    if (net_amount === undefined || net_amount === null)
                        return res.status(400).json({ error: 'net_amount required' });
    if (!Array.isArray(items) || !items.length)
                        return res.status(400).json({ error: 'items[] required' });

    // Validate each item has smallest-unit qty
    for (const it of items) {
      if (!it.qty_unit) return res.status(400).json({
        error: `Item "${it.desc || it.no}" missing qty_unit (must be smallest unit: CANS/PCS/BAGS etc.)`
      });
    }

    const r = await pool.query(`
      INSERT INTO credit_notes
        (cn_no, company_code, company_name, order_no, contract_no, invoice_no,
         issued_date, currency, net_amount, lang, note, items, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      cn_no, company_code, company_name,
      order_no, contract_no, invoice_no,
      issued_date || new Date().toISOString().slice(0,10),
      currency, net_amount, lang, note,
      JSON.stringify(items),
      req.user?.username || null
    ]);

    return res.status(201).json({ success: true, data: r.rows[0] });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
