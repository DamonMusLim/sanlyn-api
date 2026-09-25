import {
  brandAllowed,
  buildBrandDictionary,
  buildProduct,
  collectProductBrandTerms,
  extractFlavorKeys,
  extractModelKeys,
  findQuoteBrand,
  isTitleTruncated,
  parseQty,
} from './petstore-quote-parse.mjs';

export const STATUS_VALUES = [
  'MATCHED',
  'AMBIGUOUS_MULTI',
  'FLAVOR_MISMATCH',
  'NO_OUR_SKU',
  'NO_SPEC_TRUNCATED',
  'NO_SPEC_OTHER',
  'NO_BRAND',
];

function setsOverlap(a, b) {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildProductIndex(products) {
  const index = new Map();
  for (const product of products) {
    if (product.qty_g == null) continue;
    const terms = product.brand_terms?.length ? product.brand_terms : collectProductBrandTerms(product);
    for (const term of terms) {
      if (!brandAllowed(term)) continue;
      const key = `${String(term).toLowerCase()}|${Number(product.qty_g).toFixed(2)}|${Number(product.unit_count || 1)}`;
      if (!index.has(key)) index.set(key, new Map());
      index.get(key).set(product.product_code, product);
    }
  }
  return new Map([...index].map(([key, byCode]) => [key, [...byCode.values()]]));
}

function buildProductByBrand(products) {
  const index = new Map();
  for (const product of products) {
    const terms = product.brand_terms?.length ? product.brand_terms : collectProductBrandTerms(product);
    for (const term of terms) {
      if (!brandAllowed(term)) continue;
      const key = String(term).toLowerCase();
      if (!index.has(key)) index.set(key, new Map());
      index.get(key).set(product.product_code, product);
    }
  }
  return new Map([...index].map(([key, byCode]) => [key, [...byCode.values()]]));
}

function buildBarcodeIndex(products) {
  const index = new Map();
  for (const product of products) {
    for (const barcode of [product.barcode, product.pos_barcode]) {
      const code = String(barcode || '').trim();
      if (/^\d{8,14}$/.test(code) && !index.has(code)) index.set(code, product);
    }
  }
  return index;
}

function extractTitleBarcodes(title) {
  return [...String(title || '').matchAll(/\d{8,14}/g)].map((m) => m[0]);
}

function getProductContext(products) {
  if (products._matchContext) return products._matchContext;
  const context = {
    brandDictionary: buildBrandDictionary(products),
    productIndex: buildProductIndex(products),
    productByBrand: buildProductByBrand(products),
    barcodeIndex: buildBarcodeIndex(products),
  };
  Object.defineProperty(products, '_matchContext', { value: context, enumerable: false });
  return context;
}

function unitCountMismatchCandidates(context, brand, qty, unitCount, unitQtyG) {
  const sameBrand = context.productByBrand.get(brand.toLowerCase()) || [];
  return sameBrand.filter((product) => {
    if (Number(product.unit_count || 1) === Number(unitCount || 1)) return false;
    if (product.qty_g != null && qty != null && Number(product.qty_g).toFixed(2) === Number(qty).toFixed(2)) return true;
    if (product.unit_qty_g != null && unitQtyG != null && Number(product.unit_qty_g).toFixed(4) === Number(unitQtyG).toFixed(4)) return true;
    return unitCount !== 1 || Number(product.unit_count || 1) !== 1;
  });
}

export function matchQuote(quote, products) {
  const context = getProductContext(products);
  const parsedQty = parseQty(quote.title);
  const qty = parsedQty?.qtyG ?? null;
  const unitCount = parsedQty?.unitCount ?? 1;
  const unitQtyG = parsedQty?.unitQtyG ?? null;
  const brand = findQuoteBrand(quote.title, context.brandDictionary);
  const quoteFlavors = extractFlavorKeys(quote.title);
  const titleTruncated = isTitleTruncated(quote.title);
  const parsedFields = {
    parsed_brand: brand ?? null,
    parsed_unit_count: parsedQty?.unitCount ?? null,
    parsed_unit_qty_g: unitQtyG,
    parsed_flavors: [...quoteFlavors],
    is_title_truncated: titleTruncated,
  };

  for (const barcode of extractTitleBarcodes(quote.title)) {
    const product = context.barcodeIndex.get(barcode);
    if (product) {
      return {
        ...parsedFields,
        qty_g: product.qty_g ?? null,
        product_code: product.product_code,
        match_status: 'MATCHED',
        match_rule: 'barcode',
        match_confidence: 'high',
      };
    }
  }

  if (qty == null) {
    return {
      ...parsedFields,
      qty_g: null,
      product_code: null,
      match_status: titleTruncated ? 'NO_SPEC_TRUNCATED' : 'NO_SPEC_OTHER',
      match_rule: 'no_spec',
      match_confidence: 'high',
    };
  }

  if (!brand) {
    return {
      ...parsedFields,
      qty_g: qty,
      product_code: null,
      match_status: 'NO_BRAND',
      match_rule: 'no_brand',
      match_confidence: 'high',
    };
  }

  let candidates = context.productIndex.get(`${brand.toLowerCase()}|${Number(qty).toFixed(2)}|${Number(unitCount)}`) || [];
  if (candidates.length === 0) {
    const unitMismatches = unitCountMismatchCandidates(context, brand, qty, unitCount, unitQtyG);
    if (unitMismatches.length > 0) {
      return {
        ...parsedFields,
        qty_g: qty,
        product_code: null,
        match_status: 'AMBIGUOUS_MULTI',
        match_rule: `unit_count_mismatch:${brand}:${qty}:${unitCount}`,
        match_confidence: 'high',
      };
    }
    return {
      ...parsedFields,
      qty_g: qty,
      product_code: null,
      match_status: 'NO_OUR_SKU',
      match_rule: `brand+qty:${brand}:${qty}`,
      match_confidence: 'high',
    };
  }

  const uniqueMatch = (product, rule) => {
    if (quoteFlavors.size > 0 && product.flavor_keys.size > 0 && !setsOverlap(quoteFlavors, product.flavor_keys)) {
      return {
        ...parsedFields,
        qty_g: qty,
        product_code: null,
        match_status: 'FLAVOR_MISMATCH',
        match_rule: `flavor_mismatch:${product.product_code}`,
        match_confidence: 'high',
      };
    }
    return {
      ...parsedFields,
      qty_g: qty,
      product_code: product.product_code,
      match_status: 'MATCHED',
      match_rule: rule,
      match_confidence: 'high',
    };
  };

  if (candidates.length === 1) return uniqueMatch(candidates[0], 'brand+qty');

  const quoteModels = extractModelKeys(quote.title);
  if (quoteModels.size > 0) {
    const narrowed = candidates.filter((p) => setsOverlap(quoteModels, p.model_keys));
    if (narrowed.length === 1) return uniqueMatch(narrowed[0], 'brand+qty+model');
    if (narrowed.length > 1) candidates = narrowed;
  }

  if (quoteFlavors.size > 0) {
    const narrowed = candidates.filter((p) => setsOverlap(quoteFlavors, p.flavor_keys));
    if (narrowed.length === 1) return uniqueMatch(narrowed[0], 'brand+qty+flavor');
    if (narrowed.length > 1) candidates = narrowed;
  }

  return {
    ...parsedFields,
    qty_g: qty,
    product_code: null,
    match_status: 'AMBIGUOUS_MULTI',
    match_rule: `candidate_count:${candidates.length}`,
    match_confidence: 'high',
  };
}

export function calculateExcludeReason(row, baseNow = new Date()) {
  if (row.price > 0 && row.orig_price != null && row.orig_price / row.price > 5) return 'OCR_SUSPECT';
  if (row.qty_g == null) return 'MISSING_SPEC';

  const capturedAt = row.captured_at instanceof Date ? row.captured_at : parseDate(row.captured_at);
  if (capturedAt && capturedAt.getTime() < baseNow.getTime() - 7 * 24 * 60 * 60 * 1000) return 'STALE_QUOTE';

  if (row.monthly_sales == null || row.monthly_sales <= 5) return 'LOW_MONTHLY_SALES';
  if (String(row.source_tier || '').includes('批发')) return 'WHOLESALE_NOT_COMPARABLE';

  return null;
}

export function isComparable(excludeReason) {
  return excludeReason == null || excludeReason === 'LOW_MONTHLY_SALES';
}
