export const QTY_RE = /(\d+(?:\.\d+)?)\s*(kg|KG|Kg|千克|公斤|g|G|克|mg|MG|Mg|ml|ML|Ml|mI|MI|毫升|l|L|升)(?:\s*[*xX×]\s*(\d+(?:\.\d+)?)(?:\s*(支|片|袋|盒|罐|粒|包|条|个))?)?/u;
const QTY_SCAN_RE = new RegExp(QTY_RE.source, 'gu');
const COUNT_UNIT_RE = /支|片|袋|盒|罐|粒|包|条|个/u;
const COUNT_FIRST_RE = /(\d+(?:\.\d+)?)\s*(支|片|袋|盒|罐|粒|包|条|个)\s*[*xX×]\s*(\d+(?:\.\d+)?)\s*(kg|KG|Kg|千克|公斤|g|G|克|mg|MG|Mg|ml|ML|Ml|mI|MI|毫升|l|L|升)/gu;
const COUNT_ONLY_RE = /(\d+(?:\.\d+)?)\s*(支|片|袋|盒|罐|粒|包|条|个)/gu;
const TRUNCATED_RE = /(?:[⋯•…]+|(?:\.\s*){3,})\s*$/u;
const BRAND_STOP_WORDS = new Set([
  '临期特惠',
  '特价',
  '清仓',
  '试吃装',
  '宠物',
  '猫咪',
  '狗狗',
  '全价',
  '进口',
  '猫用',
  '犬用',
  '狗用',
  '成猫',
  '幼猫',
  '成犬',
  '幼犬',
  '老年',
  '体重',
  '适合',
  '通用',
  '专用',
  '主粮',
  '猫粮',
  '狗粮',
  '零食',
  '罐头',
  '湿粮',
  '驱虫',
  '滴剂',
  '内外',
  '同驱',
  '体内',
  '体外',
  '新品',
  '包邮',
  '正品',
  '现货',
  '直邮',
  '旗舰',
]);

function normalizeUnit(unit) {
  const u = String(unit || '').trim();
  if (u === 'mI' || u === 'MI') return 'ml';
  return u.toLowerCase();
}

function toGrams(value, unit) {
  const u = normalizeUnit(unit);
  if (u === 'kg' || u === '千克' || u === '公斤') return value * 1000;
  if (u === 'mg') return value / 1000;
  if (u === 'l' || u === '升') return value * 1000;
  if (u === 'ml' || u === '毫升') return value;
  if (u === 'g' || u === '克') return value;
  return value;
}

function qtyResult(unitQtyG, unitCount) {
  if (!Number.isFinite(unitCount) || unitCount <= 0) return null;
  if (unitQtyG == null) return { unitCount, unitQtyG: null, qtyG: null };
  const qtyG = unitQtyG * unitCount;
  if (!(qtyG > 0 && qtyG <= 100000)) return null;
  return {
    unitCount,
    unitQtyG: Number(unitQtyG.toFixed(4)),
    qtyG: Number(qtyG.toFixed(4)),
  };
}

export function parseQty(text) {
  const input = String(text || '');

  for (const match of input.matchAll(COUNT_FIRST_RE)) {
    const value = Number(match[3]);
    const unitCount = Number(match[1]);
    if (!Number.isFinite(value) || !Number.isFinite(unitCount)) continue;
    const result = qtyResult(toGrams(value, match[4]), unitCount);
    if (result) return result;
  }

  const re = new RegExp(QTY_SCAN_RE);
  for (const match of input.matchAll(re)) {
    if (isWeightRangeQty(input, match)) continue;

    const value = Number(match[1]);
    const multiplier = match[3] == null ? 1 : Number(match[3]);
    const unitCount = match[4] && COUNT_UNIT_RE.test(match[4]) ? multiplier : multiplier;
    if (!Number.isFinite(value) || !Number.isFinite(unitCount)) continue;

    const result = qtyResult(toGrams(value, match[2]), unitCount);
    if (result) return result;
  }

  for (const match of input.matchAll(COUNT_ONLY_RE)) {
    const unitCount = Number(match[1]);
    if (Number.isFinite(unitCount) && unitCount > 0) return qtyResult(null, unitCount);
  }

  return null;
}

function takeLastChars(text, count) {
  return Array.from(text).slice(-count).join('');
}

function isWeightRangeQty(input, match) {
  const start = match.index;
  const end = start + match[0].length;
  const before = input.slice(0, start);
  const after = input.slice(end);

  if (/(?:\d+(?:\.\d+)?)\s*[-～~]\s*$/u.test(before)) return true;

  const before6 = takeLastChars(before, 6);
  if (/(?:体重|适合|≥|＞|>|以下|以上)/u.test(before6)) return true;

  if (/^(?:猫用|犬用|狗用|以内|以下|以上)/u.test(after.trimStart())) return true;

  return false;
}

export function isTitleTruncated(title) {
  return TRUNCATED_RE.test(String(title || ''));
}

export function extractModelKeys(text) {
  const s = String(text || '');
  const keys = new Set();
  for (const m of s.matchAll(/[A-Za-z]{1,6}[- ]?\d{1,6}[A-Za-z]?|\d{2,6}[A-Za-z]{1,4}/g)) {
    keys.add(m[0].toLowerCase().replace(/[- ]/g, ''));
  }
  return keys;
}

const FLAVOR_WORDS = [
  '鸡肉',
  '鸭肉',
  '牛肉',
  '羊肉',
  '鱼肉',
  '三文鱼',
  '金枪鱼',
  '鳕鱼',
  '禽肉',
  '兔肉',
  '鹿肉',
  '火鸡',
  '乳鸽',
  '海鲜',
  '奶糕',
  '全价',
  '无谷',
  '幼猫',
  '成猫',
  '幼犬',
  '成犬',
  '老年',
  '绝育',
  '室内',
  '肠胃',
  '泌尿',
  '化毛',
];

const PRIMARY_FLAVOR_WORDS = new Set([
  '鸡肉',
  '鸭肉',
  '牛肉',
  '羊肉',
  '鱼肉',
  '三文鱼',
  '金枪鱼',
  '鳕鱼',
  '禽肉',
  '兔肉',
  '鹿肉',
  '火鸡',
  '乳鸽',
  '海鲜',
  '奶糕',
]);

export function extractFlavorKeys(text) {
  const s = String(text || '');
  const matched = FLAVOR_WORDS.filter((word) => s.includes(word));
  const primary = matched.filter((word) => PRIMARY_FLAVOR_WORDS.has(word));
  return new Set(primary.length > 0 ? primary : matched);
}

function stripBrandSource(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(?:临期特惠|特价|清仓)\s*/u, '').trim();
  while (/^(?:【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/u.test(s)) {
    s = s.replace(/^(?:【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/u, '').trim();
  }
  return s;
}

export function brandAllowed(term) {
  const t = String(term || '').trim();
  if (!t || BRAND_STOP_WORDS.has(t)) return false;
  if (/^[A-Za-z]+$/.test(t)) return t.length >= 4;
  if (/^[\u4e00-\u9fff]+$/u.test(t)) return t.length >= 2;
  return t.length >= 3;
}

function addBrandTerm(out, term) {
  const t = String(term || '').trim();
  if (brandAllowed(t)) out.add(t);
}

function charLength(text) {
  return Array.from(String(text || '')).length;
}

function isMixedEnglishChinese(text) {
  return /[A-Za-z]/.test(text) && /[\u4e00-\u9fff]/u.test(text);
}

function addLeadingChineseBrandPrefixes(out, term) {
  const chars = Array.from(term);
  const limit = Math.min(chars.length, 6);
  for (let len = 2; len <= limit; len += 1) addBrandTerm(out, chars.slice(0, len).join(''));
}

export function collectBrandTermsFromText(text) {
  const out = new Set();
  const token = stripBrandSource(text).split(/\s+/u)[0] || '';
  if (!token) return out;

  if (charLength(token) <= 8) {
    addBrandTerm(out, token);
    if (isMixedEnglishChinese(token)) {
      for (const m of token.matchAll(/[A-Za-z]+|[\u4e00-\u9fff]+/gu)) addBrandTerm(out, m[0]);
    }
    return out;
  }

  const leadingEnglish = token.match(/^[A-Za-z]{4,}/u);
  if (leadingEnglish) addBrandTerm(out, leadingEnglish[0]);

  const leadingChinese = token.match(/^[\u4e00-\u9fff]+/u);
  if (leadingChinese) addLeadingChineseBrandPrefixes(out, leadingChinese[0]);

  return out;
}

export function collectProductBrandTerms(row) {
  const out = new Set();
  const name = row.standard_product_name || row.pos_product_name || row.title || '';
  for (const term of collectBrandTermsFromText(name)) addBrandTerm(out, term);
  for (const field of [row.brand, row.pos_brand]) {
    if (!field) continue;
    for (const term of collectBrandTermsFromText(field)) addBrandTerm(out, term);
  }
  return out;
}

function inferBrand(row) {
  return row.brand || row.pos_brand || '';
}

function productSearchText(row) {
  return [
    row.standard_product_name,
    row.pos_product_name,
    inferBrand(row),
    row.standard_spec,
    row.pos_spec,
  ].filter(Boolean).join(' ');
}

export function buildProduct(row) {
  const text = productSearchText(row);
  const qty = parseQty(`${row.standard_spec || ''} ${row.pos_spec || ''} ${text}`);
  return {
    product_code: String(row.product_code),
    title: text,
    qty_g: qty?.qtyG ?? null,
    unit_count: qty?.unitCount ?? 1,
    unit_qty_g: qty?.unitQtyG ?? null,
    barcode: row.barcode || null,
    pos_barcode: row.pos_barcode || null,
    model_keys: extractModelKeys(text),
    flavor_keys: extractFlavorKeys(text),
    brand_terms: [...collectProductBrandTerms(row)],
  };
}

export function buildBrandDictionary(products) {
  const seen = new Map();
  for (const product of products) {
    for (const term of product.brand_terms?.length ? product.brand_terms : collectProductBrandTerms(product)) {
      if (brandAllowed(term)) seen.set(String(term).toLowerCase(), term);
    }
  }
  return [...seen.values()].sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh-Hans-CN'));
}

function quoteHasBrandTerm(title, term) {
  const s = String(title || '');
  if (/^[A-Za-z]+$/.test(term)) {
    const hay = s.toLowerCase();
    const needle = term.toLowerCase();
    let pos = hay.indexOf(needle);
    while (pos !== -1) {
      const before = pos === 0 ? '' : hay[pos - 1];
      const after = hay[pos + needle.length] || '';
      if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return true;
      pos = hay.indexOf(needle, pos + 1);
    }
    return false;
  }
  if (/^[\u4e00-\u9fff]+$/u.test(term)) return s.includes(term);
  return s.toLowerCase().includes(term.toLowerCase());
}

export function findQuoteBrand(title, brandDictionary) {
  for (const term of brandDictionary) {
    if (quoteHasBrandTerm(title, term)) return term;
  }
  return null;
}
