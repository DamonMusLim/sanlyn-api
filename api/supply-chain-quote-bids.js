// api/supply-chain-quote-bids.js
//
// GET /api/supply-chain/quote-bids   — list bids (role-filtered)
//
// Visibility rules:
//   supply_chain: sees ONLY own bids (bidder_company_code matches JWT companyCode)
//   trader / platform_admin / platform_finance: sees all bids
//   buyer / factory: 403
//
// Data source:
//   Primary: quote_bids table (may not exist → dev fixture fallback)
//
// FORBIDDEN fields never in response: buy_rate / sell_rate / platform_markup /
//   buyer_final_price / driver_phone / internal_margin / platform_fee_raw

import { getPool, setCors } from './db.js';
import { requireAuth }       from './auth.js';
import { sendError, callerCompanyScope } from './lib/viewmodel-adapter.js';
import { buildQuoteBidCardViewModel } from './lib/sc-viewmodels.js';
import { applyAliasMap }     from './lib/sc-field-policy-helper.js';

// ── Alias map ─────────────────────────────────────────────────────────────────
const ALIAS_MAP = [
  // Placeholder — no current deprecated aliases
];

// ── Dev fixtures ──────────────────────────────────────────────────────────────
function devFixtureRows(companyCode) {
  const all = [
    {
      bid_id:                     'BID-DEV-001',
      quote_id:                   'QR-DEV-001',
      service_type:               'ocean',
      bidder_company_code:        companyCode || 'OCEAN-CO-A',
      offered_price:              2650,
      offered_currency:           'USD',
      all_in_price:               null,
      all_in_currency:            null,
      supplier_local_charge:      true,
      supplier_local_charge_amount: 120,
      supplier_local_charge_currency: 'USD',
      status:                     'submitted',
      remarks:                    'Includes THC at port of loading',
      submitted_at:               new Date().toISOString(),
    },
    {
      bid_id:                     'BID-DEV-002',
      quote_id:                   'QR-DEV-001',
      service_type:               'ocean',
      bidder_company_code:        'OCEAN-CO-B',
      offered_price:              2780,
      offered_currency:           'USD',
      all_in_price:               null,
      all_in_currency:            null,
      supplier_local_charge:      false,
      supplier_local_charge_amount: null,
      supplier_local_charge_currency: null,
      status:                     'submitted',
      remarks:                    '',
      submitted_at:               new Date().toISOString(),
    },
  ];
  return all;
}

// ── DB query with graceful table-not-found ────────────────────────────────────
async function fetchBidRows(pool, filters) {
  try {
    let sql = `
      SELECT
        id                              AS bid_id,
        quote_id,
        service_type,
        bidder_company_code,
        offered_price,
        offered_currency,
        all_in_price,
        all_in_currency,
        supplier_local_charge,
        supplier_local_charge_amount,
        supplier_local_charge_currency,
        status,
        remarks,
        submitted_at
      FROM quote_bids
      WHERE 1=1
    `;
    const params = [];

    if (filters.quoteId) {
      params.push(filters.quoteId);
      sql += ` AND quote_id = $${params.length}`;
    }
    if (filters.companyCode) {
      params.push(filters.companyCode);
      sql += ` AND bidder_company_code = $${params.length}`;
    }
    if (filters.serviceType) {
      params.push(filters.serviceType);
      sql += ` AND service_type = $${params.length}`;
    }
    sql += ' ORDER BY submitted_at DESC LIMIT 100';

    const { rows } = await pool.query(sql, params);
    return { rows, fixture: false };
  } catch (e) {
    if (e.code === '42P01') {
      return { rows: devFixtureRows(filters.companyCode), fixture: true };
    }
    throw e;
  }
}

// ── Viewer context ────────────────────────────────────────────────────────────
function viewerCtxFromReq(req) {
  const u = req.user || {};
  const scope = callerCompanyScope(req);
  return {
    role:        String(u.role || 'anonymous'),
    serviceType: u.serviceType || u.service_type || undefined,
    companyCode: scope.primary,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
  if (!requireAuth(req, res)) return;

  const ctx = viewerCtxFromReq(req);

  // buyer and factory have no access to bid data
  if (ctx.role === 'buyer' || ctx.role === 'factory') {
    return sendError(res, 403, 'FORBIDDEN', 'Role not permitted to view bids');
  }

  // Step 1: alias preprocessing on query params
  const { body: cleanedQuery, deprecatedFields } = applyAliasMap(
    Object.assign({}, req.query),
    ALIAS_MAP,
    'supply-chain_GET_quote-bids',
  );

  const pool = getPool();

  try {
    // supply_chain scoped to own company only
    const companyFilter =
      ctx.role === 'supply_chain' ? ctx.companyCode : undefined;

    const serviceTypeFilter =
      ctx.role === 'supply_chain' ? ctx.serviceType : cleanedQuery.service_type;

    const { rows, fixture } = await fetchBidRows(pool, {
      quoteId:     cleanedQuery.quote_id,
      companyCode: companyFilter,
      serviceType: serviceTypeFilter,
    });

    const vms = rows
      .map(row => buildQuoteBidCardViewModel(ctx, row))
      .filter(Boolean);

    const responseJson = { success: true, data: vms, count: vms.length };
    if (fixture)             responseJson._dev = 'fixture';
    if (deprecatedFields.length) responseJson._deprecated = deprecatedFields;
    return res.status(200).json(responseJson);
  } catch (err) {
    if (err.code === 'UNKNOWN_FIELD') {
      return sendError(res, 400, err.code, err.message);
    }
    console.error('[supply-chain-quote-bids] error', err);
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
}
