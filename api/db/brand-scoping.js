/**
 * brand-scoping.js — Layer 1 brand visibility gate
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from products.js so linters / formatters can't accidentally wipe it.
 *
 * getBrandScope(pool, codes) → always returns:
 *   { mode: 'new'        , brandSet: Set, visibilityMap: Map }
 *   { mode: 'legacy'     , brandSet: Set, visibilityMap: Map }  ← visibilityMap empty
 *   { mode: 'fail_closed', brandSet: Set, visibilityMap: Map }  ← both empty
 *
 * mode is LOCKED to exactly three values: 'new' | 'legacy' | 'fail_closed'
 * Return shape is always the full struct — callers never need to guard for missing fields.
 *
 * Visibility semantics (brand-level gate):
 *   'full'  → product listed, price shown
 *   'rfq'   → product listed, price_usd/price/priceVisible nulled (RFQ badge in UI)
 *   'hidden'→ product excluded from query results (not in visibilityMap / brandSet)
 *   (no row) → treated as 'hidden' — fail-closed default
 *
 * RFQ only hides price — it does NOT remove the product row.
 * Rows for unlisted brands are excluded at the SQL WHERE level (brand = ANY(...)).
 *
 * Three-layer model:
 *   Layer 1: company_brand_permissions.visibility   ← this file
 *   Layer 2: company_products.price_visible         ← applyRfqLayer (this file)
 *   Layer 3: PRICE_INTERNAL_FIELDS + TRADER_HIDE_FIELDS strip (products.js, always last)
 *
 * Legacy fallback scope guarantee:
 *   customers.brands is queried with company_code = ANY($codes) where $codes = JWT companyCodes.
 *   A customer can only see brands from their own company records — never another customer's.
 *
 * ⚠ SECURITY-CRITICAL — do not reformat or restructure without Codex review.
 * Last Codex audit: CODEX-REVIEW-RESULT-002-FINAL (2026-05-13) — 10/10 PASS
 */

const EMPTY_SET = new Set();
const EMPTY_MAP = new Map();

/**
 * Resolve brand scope for a non-internal (customer/portal) caller.
 *
 * @param {import('pg').Pool} pool
 * @param {string[]} codes — JWT companyCodes (non-empty, pre-validated by caller)
 * @returns {Promise<{
 *   mode: 'new'|'legacy'|'fail_closed',
 *   brandSet: Set<string>,
 *   visibilityMap: Map<string,'full'|'rfq'>
 * }>}
 */
export async function getBrandScope(pool, codes) {
  // ── Group expansion (2026-05-17): if any caller company belongs to a
  // group, expand the scope to include every sibling + the group root. A
  // group user must see the union of all sibling companies' authorized
  // brands (e.g. PETSOME GROUP = SDN BHD + EU + DIBAQ M, total 9 brands).
  // Sibling expansion preserves fail-closed semantics — the WHERE still
  // locks to caller's group only, never crosses groups. ────────────────────
  try {
    const groupR = await pool.query(
      `SELECT DISTINCT c2.company_code
         FROM customers c1
         JOIN customers c2 ON (
              (c1.group_code IS NOT NULL AND c1.group_code = c2.group_code)
           OR  c1.company_code = c2.parent_company_code
           OR  c1.company_code = c2.company_code
         )
        WHERE c1.company_code = ANY($1::text[])`,
      [codes]
    );
    const expanded = new Set(codes);
    for (const row of groupR.rows) expanded.add(row.company_code);
    if (expanded.size > codes.length) codes = Array.from(expanded);
  } catch (_) {
    // group columns absent → keep original codes (safe fallback)
  }

  // ── Try company_brand_permissions (feature-flag: fallback if table absent) ──
  try {
    const cbpR = await pool.query(
      `SELECT brand, visibility
       FROM company_brand_permissions
       WHERE tenant_code = 'SANLYN'
         AND company_code = ANY($1::text[])
         AND visibility IN ('full', 'rfq')`,
      [codes]
    );

    // Build visibility map — most permissive wins across multiple company_codes
    const visibilityMap = new Map();
    for (const row of cbpR.rows) {
      const existing = visibilityMap.get(row.brand);
      if (!existing || (existing === 'rfq' && row.visibility === 'full')) {
        visibilityMap.set(row.brand, row.visibility);
      }
    }

    if (visibilityMap.size === 0) {
      // Table present but zero permitted brands for this customer → fail-closed
      return { mode: 'fail_closed', brandSet: EMPTY_SET, visibilityMap: EMPTY_MAP };
    }

    // brandSet = keys of visibilityMap (used for SQL WHERE clause)
    return { mode: 'new', brandSet: new Set(visibilityMap.keys()), visibilityMap };

  } catch (_) {
    // Table doesn't exist yet → fall through to legacy customers.brands
  }

  // ── Legacy fallback: customers.brands JSONB array ────────────────────────
  // Scope: queries only the customer's own company_code(s) from JWT.
  // Cannot leak other customers' brands — WHERE locks to $codes.
  const custR = await pool.query(
    "SELECT brands FROM customers WHERE company_code = ANY($1::text[]) AND is_active = true",
    [codes]
  );

  const brandSet = new Set();
  for (const row of custR.rows) {
    let bs = row.brands;
    // pg driver returns JSONB arrays as JS arrays; handle legacy string-encoded edge case
    if (typeof bs === 'string') {
      try { bs = JSON.parse(bs); } catch (_) { bs = []; }
    }
    if (Array.isArray(bs)) {
      for (const br of bs) if (br) brandSet.add(String(br).trim());
    }
  }

  if (brandSet.size === 0) {
    // No brands configured in legacy table → fail-closed
    return { mode: 'fail_closed', brandSet: EMPTY_SET, visibilityMap: EMPTY_MAP };
  }

  // Legacy mode: no per-brand visibility info — all permitted brands treated as 'full'
  return { mode: 'legacy', brandSet, visibilityMap: EMPTY_MAP };
}

/**
 * Apply RFQ layer to query result rows (Layer 1 → Layer 2 interaction).
 *
 * Only called when mode === 'new' (new table path).
 * Mutates rows in-place — does NOT remove rows.
 * Layer 3 (PRICE_INTERNAL_FIELDS strip) must run AFTER this function.
 *
 * @param {any[]} rows — products query result rows
 * @param {Map<string,'full'|'rfq'>} visibilityMap
 */
export function applyRfqLayer(rows, visibilityMap) {
  for (const row of rows) {
    if (visibilityMap.get(row.brand) === 'rfq') {
      // Brand-level RFQ: null price fields → product row stays, price hidden
      row.price_usd    = null;
      row.price        = null;
      row.priceVisible = false;
      row._priceMode   = 'rfq';
    } else if (visibilityMap.has(row.brand)) {
      // Brand is 'full' → check Layer 2 (company_products.price_visible on row)
      // undefined → true  (no Layer 2 override, price visible by default)
      // false     → false (Layer 2 hides price even when Layer 1 grants 'full')
      row.priceVisible = row.priceVisible !== false; // undefined !== false → true ✅
      row._priceMode   = row.priceVisible ? 'full' : 'rfq';
    }
  }
}
