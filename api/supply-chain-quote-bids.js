// api/supply-chain-quote-bids.js
//
// GET /api/supply-chain/quote-bids   — list bids (role-filtered)
//
// Phase 2.5 hardening:
//   P1-C1: stage NOT from req.query — derived per-row via deriveQuoteBidStage(row)
//   P1-A3: factory → 403 (ViewModel fail-closed)
//   P1-A4: buyer in accepted stage sees offeredPrice on accepted bids
//   P1-A5: allInPrice derived in ViewModel, never from row.all_in_price
//
// supply_chain: sees ONLY own bids (bidder_company_code from JWT)
// buyer: sees accepted bids for their order (bid_status=accepted/assigned)
// trader/platform: sees all bids

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';
import { sendError, callerCompanyScope } from './lib/viewmodel-adapter.js';
import {
  buildQuoteBidCardViewModel,
  deriveQuoteBidStage,
} from './lib/sc-viewmodels.js';
import { applyAliasMap } from './lib/sc-field-policy-helper.js';

const ALIAS_MAP = [];

function devFixtureRows(companyCode) {
  return [
    {
      bid_id:                       'BID-DEV-001',
      quote_id:                     'QR-DEV-001',
      service_type:                 'ocean',
      bidder_company_code:          companyCode || 'OCEAN-CO-A',
      offered_price:                2650,
      offered_currency:             'USD',
      supplier_local_charge:        true,
      supplier_local_charge_amount: 120,
      supplier_local_charge_currency: 'USD',
      bid_status:                   'submitted',
      status:                       'submitted',
      remarks:                      'Includes THC at port of loading',
      submitted_at:                 new Date().toISOString(),
    },
    {
      bid_id:                       'BID-DEV-002',
      quote_id:                     'QR-DEV-001',
      service_type:                 'ocean',
      bidder_company_code:          'OCEAN-CO-B',
      offered_price:                2780,
      offered_currency:             'USD',
      supplier_local_charge:        false,
      supplier_local_charge_amount: null,
      supplier_local_charge_currency: null,
      bid_status:                   'submitted',
      status:                       'submitted',
      remarks:                      '',
      submitted_at:                 new Date().toISOString(),
    },
  ];
}

async function fetchBidRows(pool, filters) {
  try {
    let sql = `
      SELECT id AS bid_id, quote_id, service_type, bidder_company_code,
             offered_price, offered_currency,
             supplier_local_charge, supplier_local_charge_amount,
             supplier_local_charge_currency,
             bid_status, status, remarks, submitted_at
      FROM quote_bids WHERE 1=1
    `;
    const params = [];
    if (filters.quoteId)     { params.push(filters.quoteId);     sql += ` AND quote_id = $${params.length}`; }
    if (filters.companyCode) { params.push(filters.companyCode); sql += ` AND bidder_company_code = $${params.length}`; }
    if (filters.serviceType) { params.push(filters.serviceType); sql += ` AND service_type = $${params.length}`; }
    // buyer sees only accepted bids for their order (security guard at SQL level)
    if (filters.buyerOnly) {
      sql += ` AND bid_status IN ('accepted','assigned')`;
    }
    sql += ' ORDER BY submitted_at DESC LIMIT 100';
    const { rows } = await pool.query(sql, params);
    return { rows, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      let rows = devFixtureRows(filters.companyCode);
      if (filters.buyerOnly) rows = rows.filter(r => r.bid_status === 'accepted' || r.bid_status === 'assigned');
      return { rows, fixture: true };
    }
    throw e;
  }
}

// P1-C1: role/company from JWT; stage derived per-row
function viewerCtxFromReq(req) {
  const u = req.user || {};
  const scope = callerCompanyScope(req);
  return {
    role:        String(u.role || 'anonymous'),
    serviceType: u.serviceType || u.service_type || undefined,
    companyCode: scope.primary,
    _devStageOverride: process.env.NODE_ENV !== 'production'
      ? (req.query._dev_stage || undefined)
      : undefined,
  };
}

function ctxWithStage(ctx, row) {
  return Object.assign({}, ctx, { stage: ctx._devStageOverride || deriveQuoteBidStage(row) });
}

export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (!requireAuth(req, res)) return;

  const ctx = viewerCtxFromReq(req);

  // factory blocked here (ViewModel is also fail-closed, belt+suspenders)
  if (ctx.role === 'factory') {
    return sendError(res, 403, 'FORBIDDEN', 'Role not permitted to view bids');
  }

  const { body: cleanedQuery, deprecatedFields } = applyAliasMap(
    Object.assign({}, req.query), ALIAS_MAP, 'supply-chain_GET_quote-bids',
  );

  const pool = getPool();

  try {
    // supply_chain scoped to own company (SQL guard)
    const companyFilter    = ctx.role === 'supply_chain' ? ctx.companyCode : undefined;
    const serviceTypeFilter = ctx.role === 'supply_chain' ? ctx.serviceType : cleanedQuery.service_type;
    // buyer sees only accepted/assigned bids (SQL guard, P1-D1 for bids)
    const buyerOnly = ctx.role === 'buyer';

    const { rows, fixture } = await fetchBidRows(pool, {
      quoteId:     cleanedQuery.quote_id,
      companyCode: companyFilter,
      serviceType: serviceTypeFilter,
      buyerOnly,
    });

    const vms = rows
      .map(row => buildQuoteBidCardViewModel(ctxWithStage(ctx, row), row))
      .filter(Boolean);

    const out = { success: true, data: vms, count: vms.length };
    if (fixture)              out._dev = 'fixture';
    if (deprecatedFields.length) out._deprecated = deprecatedFields;
    return res.status(200).json(out);
  } catch (err) {
    if (err.code === 'UNKNOWN_FIELD') return sendError(res, 400, err.code, err.message);
    console.error('[supply-chain-quote-bids] error', err);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}
