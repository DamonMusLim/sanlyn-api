// api/supply-chain-collab-cards.js
//
// GET /api/collab/cards       — list collab cards (role-filtered)
// GET /api/collab/cards/:id   — single collab card (role-filtered)
//
// Phase 2.5 hardening:
//   P1-C1: stage NOT from req.query — derived per-row via deriveCollabStage(row)
//   P1-D1: buyer/factory SQL-level scope guard (no full-table scan → ViewModel filter)
//
// Visibility rules (§A-§N from SC-COLLAB-SHEET-FIELD-MATRIX-v1.md):
//   - factory / supply_chain never see each other's company identity
//   - driver_phone ALWAYS excluded from SELECT (FORBIDDEN)
//   - internal_notes: trader only
//   - BL: per canViewBl §4.5 matrix using server-derived stage
//   - local_charges: 3-tier (C1/C2/C3 each gated separately)
//   - broker roles → 403

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';
import { sendError, callerCompanyScope } from './lib/viewmodel-adapter.js';
import {
  buildCollabSheetViewModel,
  deriveCollabStage,
} from './lib/sc-viewmodels.js';
import { applyAliasMap } from './lib/sc-field-policy-helper.js';

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
      main_stage:         'in_transit',       // → deriveCollabStage → 'assigned'
      collab_status:      'active',
      service_type:       'ocean',
      scope_ids:          ['ocean'],
      buyer_company_code: 'BUYER-A',          // P1-D1: buyer scope field
      factory_company_code: 'FACTORY-X',      // P1-D1: factory scope field
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
      // driver_phone intentionally absent — FORBIDDEN
      vessel:             'EVER GIVEN',
      voyage:             'W042E',
      etd:                '2026-05-15',
      eta:                '2026-06-10',
      pol:                'CNSHA',
      pod:                'USNYC',
      bl_no:              'MAEU1234567',
      booking_no:         'BKG-2026-001',
      hs_code:            '2309.90',
      declaration_elements: '品牌:无;材质:鸡肉',
      local_charge_rule:  null,
      supplier_local_charge: { amount: 120, currency: 'USD', items: [] },
      customer_local_charge_display: { displayAmount: 150, displayCurrency: 'USD', displayLabel: 'Port charges' },
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
    },
  ];
}

// ── SQL with buyer/factory scope guard (P1-D1) ────────────────────────────────
// driver_phone is never selected (FORBIDDEN)
const BASE_SELECT = `
  SELECT c.collab_id, c.order_id, c.order_no, c.main_stage, c.collab_status,
         c.service_type, c.scope_ids,
         c.buyer_company_code, c.factory_company_code,
         c.cargo_category, c.cargo_description, c.declared_value, c.declared_currency,
         c.incoterm, c.supplier_company_code, c.trucking_company_code,
         c.pickup_address, c.delivery_address, c.truck_plate, c.driver_name,
         c.vessel, c.voyage, c.etd, c.eta, c.pol, c.pod,
         c.bl_no, c.booking_no, c.hs_code, c.declaration_elements,
         c.local_charge_rule, c.supplier_local_charge, c.customer_local_charge_display,
         c.bl_draft_status, c.invoice_status, c.packing_list_status, c.customs_status,
         c.loading_photos, c.inspection_photos,
         c.exception_type, c.exception_note,
         c.internal_notes, c.handoff_status, c.submitted_at
  FROM collab_cards c
  WHERE 1=1
`;

async function fetchCollabRows(pool, filters) {
  try {
    let sql = BASE_SELECT;
    const params = [];

    // P1-D1: SQL-level scope guards (not ViewModel-only)
    if (filters.buyerCompanyCode) {
      params.push(filters.buyerCompanyCode);
      sql += ` AND c.buyer_company_code = $${params.length}`;
    }
    if (filters.factoryCompanyCode) {
      params.push(filters.factoryCompanyCode);
      sql += ` AND c.factory_company_code = $${params.length}`;
    }
    if (filters.supplierCompanyCode) {
      params.push(filters.supplierCompanyCode);
      sql += ` AND c.supplier_company_code = $${params.length}`;
    }
    if (filters.serviceType) {
      params.push(filters.serviceType);
      sql += ` AND c.service_type = $${params.length}`;
    }
    if (filters.orderId) {
      params.push(filters.orderId);
      sql += ` AND c.order_id = $${params.length}`;
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
      // P1-D1: also apply scope guard to fixture rows
      let rows = devFixtureRows();
      if (filters.buyerCompanyCode)   rows = rows.filter(r => r.buyer_company_code   === filters.buyerCompanyCode);
      if (filters.factoryCompanyCode) rows = rows.filter(r => r.factory_company_code === filters.factoryCompanyCode);
      if (filters.supplierCompanyCode) rows = rows.filter(r => r.supplier_company_code === filters.supplierCompanyCode);
      return { rows, fixture: true };
    }
    throw e;
  }
}

async function fetchCollabById(pool, id) {
  try {
    const { rows } = await pool.query(
      BASE_SELECT + ` AND c.collab_id = $1 LIMIT 1`,
      [id],
    );
    return { row: rows[0] || null, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      return { row: devFixtureRows().find(r => r.collab_id === id) || null, fixture: true };
    }
    throw e;
  }
}

// P1-C1: role/company from JWT; stage derived per-row
function viewerCtxFromReq(req) {
  const u = req.user || {};
  const scope = callerCompanyScope(req);
  return {
    role:                  String(u.role || 'anonymous'),
    serviceType:           u.serviceType || u.service_type || undefined,
    companyCode:           scope.primary,
    isAssignedOceanBidder: u.isAssignedOceanBidder || false,
    fulfillmentMode:       u.fulfillmentMode || undefined,
    _devStageOverride: process.env.NODE_ENV !== 'production'
      ? (req.query._dev_stage || undefined)
      : undefined,
  };
}

function ctxWithStage(ctx, row) {
  return Object.assign({}, ctx, { stage: ctx._devStageOverride || deriveCollabStage(row) });
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (!requireAuth(req, res)) return;

  const ctx = viewerCtxFromReq(req);

  if (['broker_supply', 'broker_factory', 'broker_customer'].includes(ctx.role)) {
    return sendError(res, 403, 'FORBIDDEN', 'Role not permitted in collab flow');
  }

  const { body: cleanedQuery, deprecatedFields } = applyAliasMap(
    Object.assign({}, req.query), ALIAS_MAP, 'collab_GET_cards',
  );

  const pool = getPool();
  const { id } = req.params || {};
  const resolvedId = id || cleanedQuery.id;

  // ── Single record ────────────────────────────────────────────────────────
  if (resolvedId) {
    try {
      const { row, fixture } = await fetchCollabById(pool, resolvedId);
      if (!row) return sendError(res, 404, 'NOT_FOUND', `Collab card ${resolvedId} not found`);

      const vm = buildCollabSheetViewModel(ctxWithStage(ctx, row), row);
      if (!vm) return sendError(res, 403, 'FORBIDDEN', 'Role not permitted to view this collab card');

      const out = { success: true, data: vm };
      if (fixture)              out._dev = 'fixture';
      if (deprecatedFields.length) out._deprecated = deprecatedFields;
      return res.status(200).json(out);
    } catch (err) {
      console.error('[supply-chain-collab-cards] GET /:id error', err);
      return sendError(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }

  // ── List ─────────────────────────────────────────────────────────────────
  try {
    // P1-D1: SQL-level scope guards derived from JWT (not from query params)
    const buyerFilter    = ctx.role === 'buyer'    ? ctx.companyCode : undefined;
    const factoryFilter  = ctx.role === 'factory'  ? ctx.companyCode : undefined;
    const supplierFilter = ctx.role === 'supply_chain' ? ctx.companyCode : undefined;
    const serviceFilter  = ctx.role === 'supply_chain' ? ctx.serviceType
                                                       : cleanedQuery.service_type;

    const { rows, fixture } = await fetchCollabRows(pool, {
      buyerCompanyCode:    buyerFilter,
      factoryCompanyCode:  factoryFilter,
      supplierCompanyCode: supplierFilter,
      serviceType:         serviceFilter,
      orderId:             cleanedQuery.order_id ? parseInt(cleanedQuery.order_id) : undefined,
      collabStatus:        cleanedQuery.collab_status,
    });

    const vms = rows
      .map(row => buildCollabSheetViewModel(ctxWithStage(ctx, row), row))
      .filter(Boolean);

    const out = { success: true, data: vms, count: vms.length };
    if (fixture)              out._dev = 'fixture';
    if (deprecatedFields.length) out._deprecated = deprecatedFields;
    return res.status(200).json(out);
  } catch (err) {
    if (err.code === 'UNKNOWN_FIELD') return sendError(res, 400, err.code, err.message);
    console.error('[supply-chain-collab-cards] GET list error', err);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}
