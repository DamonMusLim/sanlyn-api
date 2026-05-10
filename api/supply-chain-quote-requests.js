// api/supply-chain-quote-requests.js
//
// GET /api/supply-chain/quote-requests        — list (role-filtered)
// GET /api/supply-chain/quote-requests/:id    — single (role-filtered)
//
// Data source:
//   Primary: quote_requests table (may not exist in Phase 1 DB → graceful fallback to dev fixtures)
//   Supplemental: local_charges table (for C1 rule enrichment, trader+admin only)
//
// Auth: requireAuth (global authMiddleware already applied in server.js)
//
// 10 mandatory rules:
//   1. Response always from ViewModel — no raw rows
//   2. FORBIDDEN fields never in response (buy_rate/sell_rate/buyer_final_price/driver_phone)
//   3. Unknown fields → 400 UNKNOWN_FIELD
//   4. Deprecated alias → applyAliasMap + warning header
//   5. Missing whitelist config → 500
//   6. supply_chain filtered by serviceType + companyCode from JWT
//   7. local_charges remain 3-tier (handled by ViewModel)
//   8. BL uses canViewBl()
//   9. targetPriceRange uses QuoteVisibilityPolicy (default 15%)
//  10. ProductsModule not mixed in

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';
import { sendError, callerCompanyScope } from './lib/viewmodel-adapter.js';
import {
  buildQuoteRequestViewModel,
  DEFAULT_QUOTE_VISIBILITY_POLICY,
} from './lib/sc-viewmodels.js';
import { applyAliasMap } from './lib/sc-field-policy-helper.js';

// ── Field whitelists for write paths ─────────────────────────────────────────
// (GET endpoints have no body; these are for future PATCH support)
const QUOTE_REQUEST_PATCH_ALLOW = new Set([
  'status', 'expires_at', 'notes',
]);

// ── Alias map (Step 1 preprocessing) ─────────────────────────────────────────
const ALIAS_MAP = [
  // No current deprecated aliases — placeholder for future migrations
];

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

// ── Try to query real table; fall back to fixtures on table-not-found ─────────
async function fetchQuoteRequestRows(pool, filters) {
  try {
    let sql = `
      SELECT
        qr.id             AS quote_id,
        qr.order_id,
        qr.order_no,
        qr.service_type,
        qr.pol,
        qr.pod,
        qr.cargo_type,
        qr.target_price,
        qr.target_currency,
        qr.cargo_description,
        qr.total_weight,
        qr.total_volume,
        qr.incoterm,
        qr.scope_ids,
        qr.status,
        qr.requested_at,
        qr.expires_at,
        qr.accepted_bidder_id
      FROM quote_requests qr
      WHERE 1=1
    `;
    const params = [];

    if (filters.serviceType) {
      params.push(filters.serviceType);
      sql += ` AND qr.service_type = $${params.length}`;
    }
    if (filters.status) {
      params.push(filters.status);
      sql += ` AND qr.status = $${params.length}`;
    }
    if (filters.orderId) {
      params.push(filters.orderId);
      sql += ` AND qr.order_id = $${params.length}`;
    }
    sql += ' ORDER BY qr.requested_at DESC LIMIT 100';

    const { rows } = await pool.query(sql, params);
    return { rows, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      // Table doesn't exist yet — return dev fixtures
      return { rows: devFixtureRows(), fixture: true };
    }
    throw e;
  }
}

async function fetchQuoteRequestById(pool, id) {
  try {
    const { rows } = await pool.query(
      `SELECT
        id AS quote_id, order_id, order_no, service_type, pol, pod,
        cargo_type, target_price, target_currency, cargo_description,
        total_weight, total_volume, incoterm, scope_ids, status,
        requested_at, expires_at, accepted_bidder_id
       FROM quote_requests WHERE id = $1 LIMIT 1`,
      [id],
    );
    return { row: rows[0] || null, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      const all = devFixtureRows();
      return { row: all.find(r => r.quote_id === id) || null, fixture: true };
    }
    throw e;
  }
}

// ── Build ViewerContext from request ─────────────────────────────────────────
function viewerCtxFromReq(req) {
  const u = req.user || {};
  const scope = callerCompanyScope(req);
  return {
    role:               String(u.role || 'anonymous'),
    serviceType:        u.serviceType || u.service_type || undefined,
    companyCode:        scope.primary,
    stage:              req.query.stage || undefined,
    isAcceptedBidder:   u.isAcceptedBidder || false,
    fulfillmentMode:    u.fulfillmentMode || undefined,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (!requireAuth(req, res)) return;

  // Step 1: apply alias map (for any body params — GET has none, defensive)
  const bodyLike = Object.assign({}, req.query);
  const { body: cleanedQuery, deprecatedFields } = applyAliasMap(bodyLike, ALIAS_MAP, 'supply-chain_GET_quote-requests');

  const pool = getPool();
  const ctx  = viewerCtxFromReq(req);
  const { id } = req.params || {};

  // ── Single record ────────────────────────────────────────────────────────
  if (id) {
    try {
      const { row, fixture } = await fetchQuoteRequestById(pool, id);
      if (!row) return sendError(res, 404, 'NOT_FOUND', `Quote request ${id} not found`);

      const vm = buildQuoteRequestViewModel(ctx, row, DEFAULT_QUOTE_VISIBILITY_POLICY);
      if (!vm) return sendError(res, 403, 'FORBIDDEN', 'Role not permitted to view quote requests');

      const responseJson = { success: true, data: vm };
      if (fixture)            responseJson._dev = 'fixture';
      if (deprecatedFields.length) responseJson._deprecated = deprecatedFields;
      return res.status(200).json(responseJson);
    } catch (err) {
      console.error('[supply-chain-quote-requests] GET /:id error', err);
      return sendError(res, 500, 'INTERNAL_ERROR', err.message);
    }
  }

  // ── List ─────────────────────────────────────────────────────────────────
  try {
    // supply_chain viewers scoped to their own serviceType
    const serviceTypeFilter =
      ctx.role === 'supply_chain' ? ctx.serviceType : cleanedQuery.service_type;

    const { rows, fixture } = await fetchQuoteRequestRows(pool, {
      serviceType: serviceTypeFilter,
      status:      cleanedQuery.status,
      orderId:     cleanedQuery.order_id ? parseInt(cleanedQuery.order_id) : undefined,
    });

    const vms = rows
      .map(row => buildQuoteRequestViewModel(ctx, row, DEFAULT_QUOTE_VISIBILITY_POLICY))
      .filter(Boolean);

    const responseJson = { success: true, data: vms, count: vms.length };
    if (fixture)             responseJson._dev = 'fixture';
    if (deprecatedFields.length) responseJson._deprecated = deprecatedFields;
    return res.status(200).json(responseJson);
  } catch (err) {
    if (err.code === 'UNKNOWN_FIELD') {
      return sendError(res, 400, err.code, err.message);
    }
    console.error('[supply-chain-quote-requests] GET list error', err);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}
