// api/freight-debit-notes.js
//
// POST   /api/freight-debit-notes              — create draft (auto-prefill from shipping_plan_id)
// GET    /api/freight-debit-notes              — list (filter: status, bl_no, shipping_plan_id, customer_en)
// GET    /api/freight-debit-notes?id=<uuid>    — single record
// PATCH  /api/freight-debit-notes?id=<uuid>    — update fee fields / status
//
// Design doc: docs/workstreams/2026-05-customer-order-intake/FREIGHT-DEBIT-NOTE-TABLE-DESIGN-001.md

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';

// ── CNY_TOTAL formula ────────────────────────────────────────────────────────
// Σ(per-BL fees × ticket_count) + Σ(per-container fees × box_count)
function computeCnyTotal(f) {
  const perBL =
    (f.fee_edi      || 0) + (f.fee_customs  || 0) + (f.fee_doc    || 0) +
    (f.fee_epacking || 0) + (f.fee_booking  || 0) + (f.fee_barcode|| 0) +
    (f.fee_packing  || 0);
  const perBox =
    (f.fee_thc      || 0) + (f.fee_crane    || 0) + (f.fee_storage|| 0) +
    (f.fee_port_entry|| 0)+ (f.fee_pickup   || 0) + (f.fee_parking || 0) +
    (f.fee_trucking  || 0);
  return perBL * (f.ticket_count || 1) + perBox * (f.box_count || 1);
}

// ── FX rate fetch (USD → CNY mid-rate from open.er-api.com) ─────────────────
async function fetchFxRate() {
  try {
    const url = 'https://open.er-api.com/v6/latest/USD';
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.rates?.CNY ? parseFloat(data.rates.CNY.toFixed(4)) : null;
  } catch {
    return null;  // Non-fatal — caller stores null and operator can fill manually
  }
}

// ── ref_no generator: FDN-{YYYYMMDD}-{4-digit seq} ──────────────────────────
async function genRefNo(pool) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `FDN-${today}-`;
  const { rows } = await pool.query(
    `SELECT ref_no FROM freight_debit_notes
     WHERE ref_no LIKE $1
     ORDER BY ref_no DESC LIMIT 1`,
    [`${prefix}%`]
  );
  const last = rows[0]?.ref_no;
  const seq  = last ? parseInt(last.slice(-4)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ── Allowed fee fields (for PATCH whitelist) ─────────────────────────────────
const FEE_FIELDS = [
  'fee_edi','fee_customs','fee_doc','fee_epacking','fee_booking','fee_barcode','fee_packing',
  'fee_thc','fee_crane','fee_storage','fee_port_entry','fee_pickup','fee_parking','fee_trucking',
];
const EDITABLE_FIELDS = [
  ...FEE_FIELDS,
  'bl_no','etd','container_type','pod','incoterm','work_no',
  'ticket_count','box_count',
  'customer_en','customer_full','customer_note',
  'usd_freight','fx_rate_snapshot','fx_markup',
  'issuer','issuer_en',
  'issued_by','issued_at',
];
const VALID_STATUSES = ['draft', 'issued', 'paid', 'void'];

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  // ══ GET ═══════════════════════════════════════════════════════════════════
  if (req.method === 'GET') {
    const { id, status, bl_no, shipping_plan_id, customer_en,
            limit = 50, offset = 0 } = req.query;

    // Single record by UUID
    if (id) {
      const { rows } = await pool.query(
        'SELECT * FROM freight_debit_notes WHERE id = $1', [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ success: true, data: rows[0] });
    }

    // List with optional filters
    const where  = [];
    const params = [];
    let   idx    = 1;

    if (status)          { where.push(`status = $${idx++}`);                params.push(status); }
    if (bl_no)           { where.push(`bl_no ILIKE $${idx++}`);             params.push(`%${bl_no}%`); }
    if (shipping_plan_id){ where.push(`shipping_plan_id = $${idx++}`);      params.push(shipping_plan_id); }
    if (customer_en)     { where.push(`customer_en ILIKE $${idx++}`);       params.push(`%${customer_en}%`); }

    const w   = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT * FROM freight_debit_notes${w}
                 ORDER BY created_at DESC
                 LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await pool.query(sql, params);
    return res.json({ success: true, data: rows, count: rows.length });
  }

  // ══ POST ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST') {
    const { shipping_plan_id, order_intake_id } = req.body;

    // ── Auto-prefill from shipping_plans ────────────────────────────────────
    let prefill = {};
    let prefilled_fields = [];

    if (shipping_plan_id) {
      const { rows: sp } = await pool.query(
        `SELECT etd, pod, container_type, customer_en,
                freight_sale_usd, doc_fee, bkg_fee, thc_fee, bl_no
         FROM shipping_plans
         WHERE shipment_no = $1
         LIMIT 1`,
        [shipping_plan_id]
      );

      if (sp.length) {
        const s = sp[0];
        const map = {
          etd:            s.etd            ? s.etd.toISOString().slice(0,10) : null,
          pod:            s.pod            || null,
          container_type: s.container_type || null,
          customer_en:    s.customer_en    || null,
          usd_freight:    s.freight_sale_usd != null ? parseFloat(s.freight_sale_usd) : null,
          fee_doc:        s.doc_fee  != null ? parseFloat(s.doc_fee)  : null,
          fee_booking:    s.bkg_fee  != null ? parseFloat(s.bkg_fee)  : null,
          fee_thc:        s.thc_fee  != null ? parseFloat(s.thc_fee)  : null,
          bl_no:          s.bl_no          || null,
        };
        // Only include non-null prefill values
        for (const [k, v] of Object.entries(map)) {
          if (v != null) { prefill[k] = v; prefilled_fields.push(k); }
        }
      }
    }

    // ── FX rate snapshot ────────────────────────────────────────────────────
    const midRate = await fetchFxRate();
    const fx_markup = parseFloat(req.body.fx_markup ?? 0.10);
    const fx_rate_snapshot = midRate != null ? parseFloat((midRate + fx_markup).toFixed(4)) : null;

    // ── Generate ref_no ─────────────────────────────────────────────────────
    const ref_no = await genRefNo(pool);

    // ── Merge body overrides (body wins over prefill) ────────────────────────
    const merged = {
      // Defaults
      ticket_count: 1,
      box_count: 1,
      // Prefill from shipping_plans
      ...prefill,
      // Explicit body overrides (operator can override prefill at create time)
      ...(req.body.etd            != null && { etd:            req.body.etd }),
      ...(req.body.pod            != null && { pod:            req.body.pod }),
      ...(req.body.container_type != null && { container_type: req.body.container_type }),
      ...(req.body.customer_en    != null && { customer_en:    req.body.customer_en }),
      ...(req.body.incoterm       != null && { incoterm:       req.body.incoterm }),
      ...(req.body.work_no        != null && { work_no:        req.body.work_no }),
      ...(req.body.ticket_count   != null && { ticket_count:   parseInt(req.body.ticket_count) }),
      ...(req.body.box_count      != null && { box_count:      parseInt(req.body.box_count) }),
      ...(req.body.customer_full  != null && { customer_full:  req.body.customer_full }),
      ...(req.body.customer_note  != null && { customer_note:  req.body.customer_note }),
      ...(req.body.usd_freight    != null && { usd_freight:    parseFloat(req.body.usd_freight) }),
      ...(req.body.bl_no          != null && { bl_no:          req.body.bl_no }),
      // Issuer
      issuer:    req.body.issuer    || '上海洋宝宝国际物流有限公司',
      issuer_en: req.body.issuer_en || 'Shanghai Ocean Baby International Logistics Co., Ltd.',
    };

    // cny_total starts at 0 on draft (all fees default 0)
    const cny_total = computeCnyTotal({
      ...merged,
      // fee fields from body if provided, else 0
      fee_edi:         parseFloat(req.body.fee_edi         || 0),
      fee_customs:     parseFloat(req.body.fee_customs     || 0),
      fee_doc:         parseFloat(merged.fee_doc           || req.body.fee_doc    || 0),
      fee_epacking:    parseFloat(req.body.fee_epacking    || 0),
      fee_booking:     parseFloat(merged.fee_booking       || req.body.fee_booking|| 0),
      fee_barcode:     parseFloat(req.body.fee_barcode     || 0),
      fee_packing:     parseFloat(req.body.fee_packing     || 0),
      fee_thc:         parseFloat(merged.fee_thc           || req.body.fee_thc   || 0),
      fee_crane:       parseFloat(req.body.fee_crane       || 0),
      fee_storage:     parseFloat(req.body.fee_storage     || 0),
      fee_port_entry:  parseFloat(req.body.fee_port_entry  || 0),
      fee_pickup:      parseFloat(req.body.fee_pickup      || 0),
      fee_parking:     parseFloat(req.body.fee_parking     || 0),
      fee_trucking:    parseFloat(req.body.fee_trucking    || 0),
    });

    const { rows } = await pool.query(`
      INSERT INTO freight_debit_notes (
        ref_no, status, shipping_plan_id, order_intake_id,
        bl_no, etd, container_type, pod, incoterm, work_no,
        ticket_count, box_count,
        customer_en, customer_full, customer_note,
        fee_edi, fee_customs, fee_doc, fee_epacking, fee_booking, fee_barcode, fee_packing,
        fee_thc, fee_crane, fee_storage, fee_port_entry, fee_pickup, fee_parking, fee_trucking,
        cny_total, usd_freight,
        fx_rate_snapshot, fx_markup,
        issuer, issuer_en,
        created_by
      ) VALUES (
        $1,'draft',$2,$3,
        $4,$5,$6,$7,$8,$9,
        $10,$11,
        $12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,
        $29,$30,
        $31,$32,
        $33,$34,
        $35
      )
      RETURNING *
    `, [
      ref_no, shipping_plan_id || null, order_intake_id || null,
      merged.bl_no          || null,
      merged.etd            || null,
      merged.container_type || null,
      merged.pod            || null,
      merged.incoterm       || null,
      merged.work_no        || null,
      merged.ticket_count   || 1,
      merged.box_count      || 1,
      merged.customer_en    || null,
      merged.customer_full  || null,
      merged.customer_note  || null,
      parseFloat(req.body.fee_edi        || merged.fee_edi        || 0),
      parseFloat(req.body.fee_customs    || 0),
      parseFloat(merged.fee_doc          || req.body.fee_doc      || 0),
      parseFloat(req.body.fee_epacking   || 0),
      parseFloat(merged.fee_booking      || req.body.fee_booking  || 0),
      parseFloat(req.body.fee_barcode    || 0),
      parseFloat(req.body.fee_packing    || 0),
      parseFloat(merged.fee_thc          || req.body.fee_thc      || 0),
      parseFloat(req.body.fee_crane      || 0),
      parseFloat(req.body.fee_storage    || 0),
      parseFloat(req.body.fee_port_entry || 0),
      parseFloat(req.body.fee_pickup     || 0),
      parseFloat(req.body.fee_parking    || 0),
      parseFloat(req.body.fee_trucking   || 0),
      cny_total,
      merged.usd_freight    != null ? parseFloat(merged.usd_freight) : null,
      fx_rate_snapshot,
      fx_markup,
      merged.issuer,
      merged.issuer_en,
      req.user?.username || null,
    ]);

    return res.status(201).json({
      success: true,
      data: rows[0],
      prefilled_fields,
      fx_mid_rate: midRate,
    });
  }

  // ══ PATCH ═════════════════════════════════════════════════════════════════
  if (req.method === 'PATCH') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id query param required' });

    // Fetch current record
    const { rows: curr } = await pool.query(
      'SELECT * FROM freight_debit_notes WHERE id = $1', [id]
    );
    if (!curr.length) return res.status(404).json({ error: 'Not found' });
    const current = curr[0];

    // Status transition guard
    const { status } = req.body;
    if (status) {
      if (!VALID_STATUSES.includes(status))
        return res.status(400).json({ error: `Invalid status: ${status}. Valid: ${VALID_STATUSES.join('|')}` });
      if (current.status === 'void')
        return res.status(409).json({ error: 'Cannot update a voided FDN' });
    }

    // Build SET clause from whitelisted fields only
    const sets   = [];
    const params = [];
    let   idx    = 1;

    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${idx++}`);
        const val = req.body[field];
        // Coerce numeric fee fields
        if (FEE_FIELDS.includes(field) || ['usd_freight','fx_rate_snapshot','fx_markup'].includes(field)) {
          params.push(val != null ? parseFloat(val) : null);
        } else if (['ticket_count','box_count'].includes(field)) {
          params.push(val != null ? parseInt(val) : null);
        } else {
          params.push(val);
        }
      }
    }

    if (status) {
      sets.push(`status = $${idx++}`);
      params.push(status);
      // Auto-stamp issued_at on status→issued
      if (status === 'issued' && current.status !== 'issued') {
        sets.push(`issued_at = NOW()`);
        if (!req.body.issued_by && req.user?.username) {
          sets.push(`issued_by = $${idx++}`);
          params.push(req.user.username);
        }
      }
    }

    if (!sets.length)
      return res.status(400).json({ error: 'No editable fields provided' });

    // Recompute cny_total server-side (don't trust client)
    // Merge current record with incoming changes
    const merged = { ...current };
    for (const field of [...FEE_FIELDS, 'ticket_count', 'box_count']) {
      if (req.body[field] !== undefined) {
        merged[field] = parseFloat(req.body[field]);
      }
    }
    const new_cny_total = computeCnyTotal(merged);
    sets.push(`cny_total = $${idx++}`);
    params.push(new_cny_total);

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE freight_debit_notes SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    return res.json({ success: true, data: rows[0] });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
