/**
 * brand-scoping.js — Layer 1 brand visibility gate
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from products.js so linters / formatters can't accidentally wipe it.
 *
 * Call: const scope = await getBrandScope(pool, companyCodes);
 *
 * Returns one of three shapes:
 *   { mode: 'internal' }                       — caller is internal role, no scoping needed
 *   { mode: 'new',    visibilityMap: Map }     — company_brand_permissions table active
 *   { mode: 'legacy', brandSet: Set }          — fallback to customers.brands JSONB
 *   { mode: 'empty' }                          — fail-closed: no brands assigned, return []
 *
 * effectivePriceMode (applyRfqLayer in products.js):
 *   brand.visibility = 'full'  → price shown
 *   brand.visibility = 'rfq'   → price_usd/price/priceVisible nulled (RFQ badge in UI)
 *   brand not in table         → excluded from results (visibility = 'hidden' default)
 *
 * Three-layer model:
 *   Layer 1: company_brand_permissions.visibility   (this file)
 *   Layer 2: company_products.price_visible         (products.js RFQ layer)
 *   Layer 3: PRICE_INTERNAL_FIELDS + TRADER_HIDE_FIELDS strip (products.js, always last)
 *
 * ⚠ SECURITY-CRITICAL FILE — do not reformat or restructure without Codex review.
 * Last Codex audit: CODEX-REVIEW-RESULT-002-FINAL (2026-05-13) — 10/10 PASS
 */

/**
 * Resolve brand scope for a non-internal (customer/portal) caller.
 *
 * @param {import('pg').Pool} pool
 * @param {string[]} codes — companyCodes from JWT (already validated non-empty)
 * @returns {Promise<{
 *   mode: 'new'|'legacy'|'empty',
 *   visibilityMap?: Map<string,'full'|'rfq'>,
 *   brandSet?: Set<string>
 * }>}
 */
export async function getBrandScope(pool, codes) {
  // ── Try company_brand_permissions first (feature-flag: graceful fallback) ──
  try {
    const cbpR = await pool.query(
      `SELECT brand, visibility
       FROM company_brand_permissions
       WHERE tenant_code = 'SANLYN'
         AND company_code = ANY($1::text[])
         AND visibility IN ('full', 'rfq')`,
      [codes]
    );

    // Table exists — build visibility map (most permissive wins for multi-code customers)
    const visibilityMap = new Map();
    for (const row of cbpR.rows) {
      const existing = visibilityMap.get(row.brand);
      if (!existing || (existing === 'rfq' && row.visibility === 'full')) {
        visibilityMap.set(row.brand, row.visibility);
      }
    }

    if (visibilityMap.size === 0) {
      // Table present but customer has no permitted brands → fail-closed
      return { mode: 'empty' };
    }

    return { mode: 'new', visibilityMap };

  } catch (_) {
    // company_brand_permissions doesn't exist yet — fall through to legacy
  }

  // ── Legacy fallback: customers.brands JSONB array ──
  const custR = await pool.query(
    "SELECT brands FROM customers WHERE company_code = ANY($1::text[]) AND is_active = true",
    [codes]
  );

  const brandSet = new Set();
  for (const row of custR.rows) {
    let bs = row.brands;
    // pg returns JSONB arrays as JS arrays already; handle string-encoded edge case
    if (typeof bs === 'string') {
      try { bs = JSON.parse(bs); } catch (_) { bs = []; }
    }
    if (Array.isArray(bs)) {
      for (const br of bs) if (br) brandSet.add(String(br).trim());
    }
  }

  if (brandSet.size === 0) {
    // No brands in legacy table either → fail-closed
    return { mode: 'empty' };
  }

  return { mode: 'legacy', brandSet };
}

/**
 * Apply RFQ layer to query result rows (Layer 1 → Layer 2 interaction).
 * Mutates rows in-place. Layer 3 (PRICE_INTERNAL_FIELDS strip) must run AFTER this.
 *
 * @param {any[]} rows — query result rows
 * @param {Map<string,'full'|'rfq'>} visibilityMap
 */
export function applyRfqLayer(rows, visibilityMap) {
  for (const row of rows) {
    if (visibilityMap.get(row.brand) === 'rfq') {
      // Brand-level RFQ: price hidden regardless of Layer 2
      row.price_usd   = null;
      row.price       = null;
      row.priceVisible = false;
      row._priceMode  = 'rfq';
    } else if (visibilityMap.has(row.brand)) {
      // Layer 2: company_products.price_visible may be on the row (boolean).
      // undefined → true  (no Layer 2 override, price visible by default)
      // false     → false (Layer 2 explicitly hides price even at full visibility)
      row.priceVisible = row.priceVisible !== false; // undefined !== false → true ✅
      row._priceMode   = row.priceVisible ? 'full' : 'rfq';
    }
  }
}
