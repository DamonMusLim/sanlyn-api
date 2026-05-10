// api/supply-chain-collab-cards.js
//
// GET /api/collab/cards       — list collab cards (role-filtered)
// GET /api/collab/cards/:id   — single collab card (role-filtered)
//
// Visibility rules (§A-§N from SC-COLLAB-SHEET-FIELD-MATRIX-v1.md):
//   - factory / supply_chain never see each other's company identity
//   - driver_phone ALWAYS stripped (FORBIDDEN)
//   - internal_notes: trader only
//   - BL: per canViewBl §4.5 matrix
//   - local_charges: 3-tier (C1/C2/C3 each gated separately)
//   - broker roles (broker_supply/broker_factory/broker_customer) → 403
//
// Data source:
//   Primary: collab_cards table (may not exist → dev fixture fallback)
//   Supplemental: existing collaboration_threads / collaboration_messages (joined if present)
//
// FORBIDDEN fields never in response: buy_rate / sell_rate / platform_markup /
//   buyer_final_price / driver_phone / internal_margin / platform_fee_raw

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';
import { sendError, callerCompanyScope } from './lib/viewmodel-adapter.js';
import { buildCollabSheetViewModel } from './lib/sc-viewmodels.js';
import { applyAliasMap }     from './lib/sc-field-policy-helper.js';

// ── Alias map (Step 1 preprocessing) ─────────────────────────────────────────
const ALIAS_MAP = [
  { deprecated: 'collab_id', canonical: 'id' },
];

// ── Dev fixture ───────────────────────────────────────────────────────────────
function devFixtureRows() {
  return [
    {
      collab_id:          'COLLAB-DEV-001',
      order_id:           1146,
      order_no:           '46-TEST-1',
      main_stage:         'in_transit',
      service_type:       'ocean',
      scope_ids:          ['ocean'],
      cargo_category:     'pet_food',
      cargo_description:  'PET SNACKS — dev fixture — trader eyes only',
      declared_value:     18000,
      declared_currency:  'USD',
      incoterm:           'FOB',
      supplier_company_code: 'OCEAN-CO-A',
      trucking_company_code: null,
      pickup_address:     null,
      delivery_address:   null,
      truck_plate:        null,
      driver_name:        null,
      // driver_phone intentionally omitted — FORBIDDEN
      vessel:             'EVER GIVEN',
      voyage:             'W042E',
      etd:                '2026-05-15',
      eta:                '2026-06-10',
      pol:                'CNSHA',
      pod:                'USNYC',
      bl_no:              null,           // gated by canViewBl
      booking_no:         'BKG-2026-001',
      hs_code:            '2309.90',
      declaration_elements: '品牌:无;材质:鸡肉',
      local_charge_rule:  null,
      supplier_local_charge: {
        amount: 120, currency: 'USD', items: [],
      },
      customer_local_charge_display: {
        displayAmount: 150, displayCurrency: 'USD', displayLabel: 'Port charges',
      },
      bl_draft_status:    'draft_uploaded',
      invoice_status:     'issued',
      packing_list_status:'issued',
      customs_status:     'pending',
      loading_photos:     [],
      inspection_photos:  [],
      exception_type:     null,
      exception_note:     null,
      internal_notes:     'Trader-only: buyer requested ETA push — pending confirmation',
      handoff_status:     'in_progress',
      submitted_at:       new Date().toISOString(),
      collab_status:      'active',
    },
  ];
}

// ── DB query with graceful table-not-found ────────────────────────────────────
async function fetchCollabRows(pool, filters) {
  try {
    let sql = `
      SELECT
        c.collab_id,
        c.order_id,
        c.order_no,
        c.main_stage,
        c.service_type,
        c.scope_ids,
        c.cargo_category,
        c.cargo_description,
        c.declared_value,
        c.declared_currency,
        c.incoterm,
        c.supplier_company_code,
        c.trucking_company_code,
        c.pickup_address,
        c.delivery_address,
        c.truck_plate,
        c.driver_name,
        -- driver_phone is never selected (FORBIDDEN)
        c.vessel,
        c.voyage,
        c.etd,
        c.eta,
        c.pol,
        c.pod,
        c.bl_no,
        c.booking_no,
        c.hs_code,
        c.declaration_elements,
        c.local_charge_rule,
        c.supplier_local_charge,
        c.customer_local_charge_display,
        c.bl_draft_status,
        c.invoice_status,
        c.packing_list_status,
        c.customs_status,
        c.loading_photos,
        c.inspection_photos,
        c.exception_type,
        c.exception_note,
        c.internal_notes,
        c.handoff_status,
        c.submitted_at,
        c.collab_status
      FROM collab_cards c
      WHERE 1=1
    `;
    const params = [];

    if (filters.orderId) {
      params.push(filters.orderId);
      sql += ` AND c.order_id = $${params.length}`;
    }
    if (filters.serviceType) {
      params.push(filters.serviceType);
      sql += ` AND c.service_type = $${params.length}`;
    }
    if (filters.supplierCompanyCode) {
      params.push(filters.supplierCompanyCode);
      sql += ` AND c.supplier_company_code = $${params.length}`;
    }
    if (filters.collabStatus) {
      params.push(filters.collabStatus);
      sql += ` AND c.collab_status = $${params.length}`;
    }
    sql += ' ORDER BY c.submitted_at DESC LIMIT 100';

    const { rows } = await pool.query(sql, params);
    return { rows, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      return { rows: devFixtureRows(), fixture: true };
    }
    throw e;
  }
}

async function fetchCollabById(pool, id) {
  try {
    const { rows } = await pool.query(
      // Same column list as above (never select driver_phone)
      `SELECT collab_id, order_id, order_no, main_stage, service_type, scope_ids,
              cargo_category, cargo_description, declared_value, declared_currency,
              incoterm, supplier_company_code, trucking_company_code,
              pickup_address, delivery_address, truck_plate, driver_name,
              vessel, voyage, etd, eta, pol, pod, bl_no, booking_no,
              hs_code, declaration_elements,
              local_charge_rule, supplier_local_charge, customer_local_charge_display,
              bl_draft_status, invoice_status, packing_list_status, customs_status,
              loading_photos, inspection_photos, exception_type, exception_note,
              internal_notes, handoff_status, submitted_at, collab_status
       FROM collab_cards WHERE collab_id = $1 LIMIT 1`,
      [id],
    );
    return { row: rows[0] || null, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      const all = devFixtureRows();
      return { row: all.find(r => r.collab_id === id) || null, fixture: true };
    }
    throw e;
  }
}

// ── Viewer context ────────────────────────────────────────────────────────────
function viewerCtxFromReq(req) {
  const u = req.user || {};
  const scope = callerCompanyScope(req);
  return {
    role:                 String(u.role || 'anonymous'),
    serviceType:          u.serviceType || u.service_type || undefined,
    companyCode:          scope.primary,
    stage:                req.query.stage || u.stage || undefined,
    isAssignedOceanBidder: u.isAssignedOceanBidder || false,
    fulfillmentMode:      u.fulfillmentMode || undefined,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (!requireAuth(req, res)) return;

  const ctx = viewerCtxFromReq(req);

  // Broker roles: 403 (not in collab flow)
  if (['broker_supply', 'broker_factory', 'broker_customer'].includes(ctx.role)) {
    return sendError(res, 403, 'FORBIDDEN', 'Role not permitted in collab flow');
  }

  // Step 1: alias preprocessing
  const { body: cleanedQuery, deprecatedFields } = applyAliasMap(
    Object.assign({}, req.query),
    ALIAS_MAP,
    'collab_GET_cards',
  );

  const pool = getPool();
  const { id } = req.params || {};

  // Use cleanedQuery.id in case alias resolved it
  const resolvedId = id || cleanedQuery.id;

  // ── Single record ────────────────────────────────────────────────────────
  if (resolvedId) {
    try {
      const { row, fixture } = await fetchCollabById(pool, resolvedId);
      if (!row) return sendError(res, 404, 'NOT_FOUND', `Collab card ${resolvedId} not found`);

      const vm = buildCollabSheetViewModel(ctx, row);
      if (!vm) return sendError(res, 403, 'FORBIDDEN', 'Role not permitted to view this collab card');

      const responseJson = { success: true, data: vm };
      if (fixture)             responseJson._dev = 'fixture';
      if (deprecatedFields.length) responseJson._deprecated = deprecatedFields;
      return res.status(200).json(responseJson);
    } catch (err) {
      console.error('[supply-chain-collab-cards] GET /:id error', err);
      return sendError(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }

  // ── List ─────────────────────────────────────────────────────────────────
  try {
    // supply_chain scoped to own company
    const supplierFilter =
      ctx.role === 'supply_chain' ? ctx.companyCode : undefined;

    const serviceTypeFilter =
      ctx.role === 'supply_chain' ? ctx.serviceType : cleanedQuery.service_type;

    const { rows, fixture } = await fetchCollabRows(pool, {
      orderId:             cleanedQuery.order_id ? parseInt(cleanedQuery.order_id) : undefined,
      serviceType:         serviceTypeFilter,
      supplierCompanyCode: supplierFilter,
      collabStatus:        cleanedQuery.collab_status,
    });

    const vms = rows
      .map(row => buildCollabSheetViewModel(ctx, row))
      .filter(Boolean);

    const responseJson = { success: true, data: vms, count: vms.length };
    if (fixture)             responseJson._dev = 'fixture';
    if (deprecatedFields.length) responseJson._deprecated = deprecatedFields;
    return res.status(200).json(responseJson);
  } catch (err) {
    if (err.code === 'UNKNOWN_FIELD') {
      return sendError(res, 400, err.code, err.message);
    }
    console.error('[supply-chain-collab-cards] GET list error', err);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}
