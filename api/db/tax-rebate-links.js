// api/db/tax-rebate-links.js  -- 进项票×退税单分配 N:M
// POST   /api/db/tax-rebate/invoice-links
// GET    /api/db/tax-rebate/declaration-coverage/:rebate_id
// GET    /api/db/tax-rebate/invoice-allocation/:invoice_id
import { getPool, setCors } from '../db.js';
import { requireAuth } from '../auth.js';

export default async function handler(req, res) {
  setCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== 'admin' && req.user?.role !== 'finance') {
    return res.status(403).json({ error: '退税板块仅财务/管理员可见' });
  }
  const pool = getPool();
  const parts = (req.path || req.url || '').split('/').filter(Boolean);
  const sub = parts[parts.length - 2] === 'tax-rebate' ? parts[parts.length - 1]
    : parts.includes('invoice-links') ? 'invoice-links'
    : parts.includes('declaration-coverage') ? 'declaration-coverage'
    : parts.includes('invoice-allocation') ? 'invoice-allocation'
    : null;
  const paramId = ['declaration-coverage','invoice-allocation'].includes(sub) ? parts[parts.length - 1] : null;

  // POST /api/db/tax-rebate/invoice-links
  if (req.method === 'POST' && (sub === 'invoice-links' || parts.includes('invoice-links'))) {
    const { rebate_id, invoice_id, allocated_amount, note } = req.body || {};
    if (!rebate_id || !invoice_id || !allocated_amount)
      return res.status(400).json({ error: 'rebate_id, invoice_id, allocated_amount required' });
    const amt = Number(allocated_amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'allocated_amount must be positive' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invR = await client.query('SELECT id, amount_incl_tax FROM finance_invoices_in WHERE id=', [invoice_id]);
      if (!invR.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'invoice not found' }); }
      const invTotal = Number(invR.rows[0].amount_incl_tax || 0);
      const rebR = await client.query('SELECT id, fob_cny, rebate_rate, customs_no FROM finance_export_rebates WHERE id=', [rebate_id]);
      if (!rebR.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'rebate record not found' }); }
      const rebTotal = Number(rebR.rows[0].fob_cny || 0);
      const rebateRate = Number(rebR.rows[0].rebate_rate || 0);
      const allocByInv = Number((await client.query(
        'SELECT COALESCE(SUM(allocated_amount),0) AS s FROM invoice_declaration_links WHERE invoice_id=', [invoice_id]
      )).rows[0].s);
      if (allocByInv + amt > invTotal) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: 'INVOICE_ALLOCATION_EXCEEDS_TOTAL', message: '分配金额超过票面金额',
          details: { invoice_id, invoice_total: invTotal, already_allocated: allocByInv, requested: amt } });
      }
      const allocByReb = Number((await client.query(
        'SELECT COALESCE(SUM(allocated_amount),0) AS s FROM invoice_declaration_links WHERE rebate_id=', [rebate_id]
      )).rows[0].s);
      if (allocByReb + amt > rebTotal) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: 'DECLARATION_ALLOCATION_EXCEEDED', message: '报关FOB金额是上限，不允许多开',
          details: { rebate_id, fob_cny: rebTotal, already_allocated: allocByReb, requested: amt } });
      }
      const newRebAlloc = allocByReb + amt;
      const coverageShortfall = Math.max(0, rebTotal - newRebAlloc);
      const coverageRate = rebTotal > 0 ? newRebAlloc / rebTotal : 0;
      const linkR = await client.query(
        `INSERT INTO invoice_declaration_links (rebate_id, invoice_id, allocated_amount, coverage_shortfall, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (rebate_id, invoice_id) DO UPDATE
           SET allocated_amount=$3, coverage_shortfall=$4, note=$5, updated_at=now()
         RETURNING *`,
        [rebate_id, invoice_id, amt, coverageShortfall, note || null]);
      await client.query('COMMIT');
      const rebatable = Math.min(newRebAlloc, rebTotal);
      return res.json({ link: linkR.rows[0],
        coverage_rate: Math.round(coverageRate * 10000) / 10000,
        coverage_status: coverageRate >= 0.99 ? 'fully_covered' : 'pending_invoice',
        coverage_shortfall: coverageShortfall,
        rebatable_amount: rebatable,
        rebate_tax: Math.round(rebatable * rebateRate * 100) / 100 });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[tax-rebate-links POST]', e.message);
      return res.status(500).json({ error: e.message });
    } finally { client.release(); }
  }

  // GET /api/db/tax-rebate/declaration-coverage/:rebate_id
  if (req.method === 'GET' && paramId && (sub === 'declaration-coverage' || parts.includes('declaration-coverage'))) {
    const rid = paramId;
    try {
      const rebR = await pool.query('SELECT id, customs_no, fob_cny, rebate_rate, rebate_expected FROM finance_export_rebates WHERE id=', [rid]);
      if (!rebR.rows.length) return res.status(404).json({ error: 'rebate record not found' });
      const reb = rebR.rows[0];
      const rebTotal = Number(reb.fob_cny || 0);
      const linksR = await pool.query(
        `SELECT idl.*, fii.invoice_no, fii.seller_name FROM invoice_declaration_links idl
         LEFT JOIN finance_invoices_in fii ON fii.id = idl.invoice_id
         WHERE idl.rebate_id=$1`, [rid]);
      const allocatedTotal = linksR.rows.reduce((s, r) => s + Number(r.allocated_amount), 0);
      const coverageRate = rebTotal > 0 ? allocatedTotal / rebTotal : 0;
      const rebatable = Math.min(allocatedTotal, rebTotal);
      return res.json({ rebate_id: Number(rid), customs_no: reb.customs_no, fob_cny: rebTotal,
        allocated_total: allocatedTotal,
        coverage_rate: Math.round(coverageRate * 10000) / 10000,
        coverage_status: coverageRate >= 0.99 ? 'fully_covered' : 'pending_invoice',
        coverage_shortfall: Math.max(0, rebTotal - allocatedTotal),
        rebatable_amount: rebatable,
        rebate_tax: Math.round(rebatable * Number(reb.rebate_rate || 0) * 100) / 100,
        links: linksR.rows });
    } catch (e) { console.error('[tax-rebate-links GET coverage]', e.message); return res.status(500).json({ error: e.message }); }
  }

  // GET /api/db/tax-rebate/invoice-allocation/:invoice_id
  if (req.method === 'GET' && paramId && (sub === 'invoice-allocation' || parts.includes('invoice-allocation'))) {
    const iid = paramId;
    try {
      const invR = await pool.query('SELECT id, invoice_no, amount_incl_tax, seller_name FROM finance_invoices_in WHERE id=', [iid]);
      if (!invR.rows.length) return res.status(404).json({ error: 'invoice not found' });
      const inv = invR.rows[0];
      const invTotal = Number(inv.amount_incl_tax || 0);
      const linksR = await pool.query(
        `SELECT idl.*, fer.customs_no, fer.fob_cny FROM invoice_declaration_links idl
         LEFT JOIN finance_export_rebates fer ON fer.id = idl.rebate_id
         WHERE idl.invoice_id=$1`, [iid]);
      const allocatedTotal = linksR.rows.reduce((s, r) => s + Number(r.allocated_amount), 0);
      return res.json({ invoice_id: Number(iid), invoice_no: inv.invoice_no, seller_name: inv.seller_name,
        invoice_total: invTotal, allocated_total: allocatedTotal,
        remaining_allocatable: Math.max(0, invTotal - allocatedTotal),
        links: linksR.rows });
    } catch (e) { console.error('[tax-rebate-links GET allocation]', e.message); return res.status(500).json({ error: e.message }); }
  }

  return res.status(404).json({ error: 'not found', path: req.path });
}
