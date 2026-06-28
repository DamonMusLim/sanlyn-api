// api/supply-chain-quote-requests.js
//
// GET /api/supply-chain/quote-requests        — list (role-filtered)
// GET /api/supply-chain/quote-requests/:id    — single (role-filtered)
//
// Phase 2.5 hardening:
//   P1-C1: stage NOT from req.query — derived per-row via deriveQuoteStage(row)
//   P1-A1: factory returns 403 (ViewModel fail-closed)
//   P1-A2: buyer sees raw targetPrice (via ViewModel)
//
// Data source:
//   Primary: quote_requests table (may not exist → dev fixture fallback on pg 42P01)

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';
import { sendError, callerCompanyScope } from './lib/viewmodel-adapter.js';
import {
  buildQuoteRequestViewModel,
  deriveQuoteStage,
  DEFAULT_QUOTE_VISIBILITY_POLICY,
} from './lib/sc-viewmodels.js';
import { applyAliasMap } from './lib/sc-field-policy-helper.js';

const ALIAS_MAP = [];

// ── Dev fixture rows (returned when quote_requests table doesn't exist yet) ──
function devFixtureRows() {
  return [
    {
      quote_id:         'QR-DEV-001',
      order_id:         1146,
      order_no:         '46-TEST-1',
      service_type:     'ocean',
      pol:              'CNSHA',
      pod:              'USNYC',
      cargo_type:       'general',
      target_price:     2800,
      target_currency:  'USD',
      cargo_description:'PET FOOD SNACKS — dev fixture',
      total_weight:     5400,
      total_volume:     22.5,
      incoterm:         'FOB',
      scope_ids:        ['ocean'],
      status:           'open',
      requested_at:     new Date().toISOString(),
      expires_at:       null,
      accepted_bidder_id: null,
    },
    {
      quote_id:         'QR-DEV-002',
      order_id:         1147,
      order_no:         '46-TEST-2',
      service_type:     'trucking',
      pol:              null,
      pod:              null,
      cargo_type:       'general',
      target_price:     600,
      target_currency:  'CNY',
      cargo_description:'Dry goods — dev fixture',
      total_weight:     1200,
      total_volume:     8.0,
      incoterm:         null,
      scope_ids:        ['trucking'],
      status:           'open',
      requested_at:     new Date().toISOString(),
      expires_at:       null,
      accepted_bidder_id: null,
    },
  ];
}

async function fetchQuoteRequestRows(pool, filters) {
  try {
    let sql = `
      SELECT id AS quote_id, order_id, order_no, service_type, pol, pod,
             cargo_type, target_price, target_currency, cargo_description,
             total_weight, total_volume, incoterm, scope_ids, status,
             requested_at, expires_at, accepted_bidder_id
      FROM quote_requests WHERE 1=1
    `;
    const params = [];
    if (filters.serviceType) { params.push(filters.serviceType); sql += ` AND service_type = $${params.length}`; }
    if (filters.status)      { params.push(filters.status);      sql += ` AND status = $${params.length}`; }
    if (filters.orderId)     { params.push(filters.orderId);     sql += ` AND order_id = $${params.length}`; }
    sql += ' ORDER BY requested_at DESC LIMIT 100';
    const { rows } = await pool.query(sql, params);
    return { rows, fixture: false };
  } catch (e) {
    if (e.code === '42P01') return { rows: devFixtureRows(), fixture: true };
    throw e;
  }
}

async function fetchQuoteRequestById(pool, id) {
  try {
    const { rows } = await pool.query(
      `SELECT id AS quote_id, order_id, order_no, service_type, pol, pod,
              cargo_type, target_price, target_currency, cargo_description,
              total_weight, total_volume, incoterm, scope_ids, status,
              requested_at, expires_at, accepted_bidder_id
       FROM quote_requests WHERE id = $1 LIMIT 1`,
      [id],
    );
    return { row: rows[0] || null, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      return { row: devFixtureRows().find(r => r.quote_id === id) || null, fixture: true };
    }
    throw e;
  }
}

// P1-C1: stage NOT from query — role/company/scope from JWT only
function viewerCtxFromReq(req) {
  const u = req.user || {};
  const scope = callerCompanyScope(req);
  return {
    role:             String(u.role || 'anonymous'),
    serviceType:      u.serviceType || u.service_type || undefined,
    companyCode:      scope.primary,
    isAcceptedBidder: u.isAcceptedBidder || false,
    fulfillmentMode:  u.fulfillmentMode || undefined,
    // Dev-only stage override — never active in production
    _devStageOverride: process.env.NODE_ENV !== 'production'
      ? (req.query._dev_stage || undefined)
      : undefined,
  };
}

function ctxWithStage(ctx, row) {
  return Object.assign({}, ctx, { stage: ctx._devStageOverride || deriveQuoteStage(row) });
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (!requireAuth(req, res)) return;

  const { body: cleanedQuery, deprecatedFields } = applyAliasMap(
    Object.assign({}, req.query), ALIAS_MAP, 'supply-chain_GET_quote-requests',
  );

  const pool = getPool();
  const ctx  = viewerCtxFromReq(req);
  const { id } = req.params || {};

  if (id) {
    try {
      const { row, fixture } = await fetchQuoteRequestById(pool, id);
      if (!row) return sendError(res, 404, 'NOT_FOUND', `Quote request ${id} not found`);

      const vm = buildQuoteRequestViewModel(ctxWithStage(ctx, row), row, DEFAULT_QUOTE_VISIBILITY_POLICY);
      if (!vm) return sendError(res, 403, 'FORBIDDEN', 'Role not permitted to view quote requests');

      const out = { success: true, data: vm };
      if (fixture)              out._dev = 'fixture';
      if (deprecatedFields.length) out._deprecated = deprecatedFields;
      return res.status(200).json(out);
    } catch (err) {
      console.error('[supply-chain-quote-requests] GET /:id error', err);
      return sendError(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }

  try {
    const serviceTypeFilter = ctx.role === 'supply_chain' ? ctx.serviceType : cleanedQuery.service_type;
    const { rows, fixture } = await fetchQuoteRequestRows(pool, {
      serviceType: serviceTypeFilter,
      status:      cleanedQuery.status,
      orderId:     cleanedQuery.order_id ? parseInt(cleanedQuery.order_id) : undefined,
    });

    const vms = rows
      .map(row => buildQuoteRequestViewModel(ctxWithStage(ctx, row), row, DEFAULT_QUOTE_VISIBILITY_POLICY))
      .filter(Boolean);

    const out = { success: true, data: vms, count: vms.length };
    if (fixture)              out._dev = 'fixture';
    if (deprecatedFields.length) out._deprecated = deprecatedFields;
    return res.status(200).json(out);
  } catch (err) {
    if (err.code === 'UNKNOWN_FIELD') return sendError(res, 400, err.code, err.message);
    console.error('[supply-chain-quote-requests] GET list error', err);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}
