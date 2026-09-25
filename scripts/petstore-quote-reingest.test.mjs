import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrandDictionary,
  buildProduct,
  findQuoteBrand,
  isTitleTruncated,
  parseQty,
} from './petstore-quote-parse.mjs';
import {
  STATUS_VALUES,
  calculateExcludeReason,
  isComparable,
  matchQuote,
} from './petstore-quote-match.mjs';

function product(row) {
  return buildProduct({
    product_code: row.product_code,
    standard_product_name: row.name,
    pos_product_name: row.pos_name || '',
    brand: row.brand || '',
    pos_brand: row.pos_brand || '',
    standard_spec: row.spec || '',
    pos_spec: row.pos_spec || '',
    barcode: row.barcode || '',
    pos_barcode: row.pos_barcode || '',
  });
}

function qty(text) {
  return parseQty(text)?.qtyG ?? null;
}

function assertQty(text, expected) {
  assert.deepEqual(parseQty(text), expected);
}

test('parseQty handles kg, g, mg, ml, l and multipliers', () => {
  assert.equal(qty('皇家 猫粮 2kg'), 2000);
  assert.equal(qty('猫条 85g*12'), 1020);
  assert.equal(qty('营养膏 500mg'), 0.5);
  assert.equal(qty('羊奶 1L'), 1000);
  assert.equal(qty('饮水 250ml×4'), 1000);
});

test('parseQty rejects missing and unreasonable specs', () => {
  assert.equal(parseQty('皇家 猫粮'), null);
  assert.equal(parseQty('皇家 猫粮 200kg'), null);
});

test('isTitleTruncated detects ellipsis suffixes', () => {
  assert.equal(isTitleTruncated('皇家 猫粮 2k...'), true);
  assert.equal(isTitleTruncated('皇家 猫粮 2kg'), false);
});

test('missing spec returns truncated status when title is truncated', () => {
  const result = matchQuote({ title: '皇家 全价猫粮...' }, [product({ product_code: 'P1', name: '皇家 猫粮', spec: '2kg' })]);
  assert.equal(result.match_status, 'NO_SPEC_TRUNCATED');
  assert.equal(result.product_code, null);
});

test('missing spec returns NO_SPEC_OTHER when title is complete', () => {
  const result = matchQuote({ title: '皇家 全价猫粮' }, [product({ product_code: 'P1', name: '皇家 猫粮', spec: '2kg' })]);
  assert.equal(result.match_status, 'NO_SPEC_OTHER');
  assert.equal(result.product_code, null);
});

test('unique brand and spec match returns MATCHED', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg' })];
  const result = matchQuote({ title: '皇家 鸡肉成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'MATCHED');
  assert.equal(result.product_code, 'P1');
  assert.equal(result.match_rule, 'brand+qty');
});

test('missing same-brand spec returns NO_OUR_SKU', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg' })];
  const result = matchQuote({ title: '皇家 鸡肉成猫粮 3kg' }, products);
  assert.equal(result.match_status, 'NO_OUR_SKU');
  assert.equal(result.product_code, null);
});

test('model narrows same-brand same-spec candidates to one product', () => {
  const products = [
    product({ product_code: 'P1', name: '皇家 A123 鸡肉 成猫粮', spec: '2kg' }),
    product({ product_code: 'P2', name: '皇家 B456 鸡肉 成猫粮', spec: '2kg' }),
  ];
  const result = matchQuote({ title: '皇家 A123 鸡肉成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'MATCHED');
  assert.equal(result.product_code, 'P1');
  assert.equal(result.match_rule, 'brand+qty+model');
});

test('flavor narrows same-brand same-spec candidates to one product', () => {
  const products = [
    product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg' }),
    product({ product_code: 'P2', name: '皇家 牛肉 成猫粮', spec: '2kg' }),
  ];
  const result = matchQuote({ title: '皇家 牛肉成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'MATCHED');
  assert.equal(result.product_code, 'P2');
  assert.equal(result.match_rule, 'brand+qty+flavor');
});

test('unresolved same-brand same-spec candidates stay ambiguous', () => {
  const products = [
    product({ product_code: 'P1', name: '皇家 成猫粮', spec: '2kg' }),
    product({ product_code: 'P2', name: '皇家 成猫粮', spec: '2kg' }),
  ];
  const result = matchQuote({ title: '皇家 成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'AMBIGUOUS_MULTI');
  assert.equal(result.product_code, null);
});

test('single same-brand spec candidate with flavor conflict returns FLAVOR_MISMATCH', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg' })];
  const result = matchQuote({ title: '皇家 牛肉成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'FLAVOR_MISMATCH');
  assert.equal(result.product_code, null);
});

test('exclude reason and comparable rules are stable', () => {
  const now = new Date('2026-08-16T00:00:00Z');
  assert.equal(calculateExcludeReason({ price: 10, orig_price: 80, qty_g: 1000, monthly_sales: 10, captured_at: now }, now), 'OCR_SUSPECT');
  assert.equal(calculateExcludeReason({ price: 10, qty_g: null, monthly_sales: 10, captured_at: now }, now), 'MISSING_SPEC');
  assert.equal(calculateExcludeReason({ price: 10, qty_g: 1000, monthly_sales: 1, captured_at: now }, now), 'LOW_MONTHLY_SALES');
  assert.equal(isComparable('LOW_MONTHLY_SALES'), true);
  assert.equal(isComparable('OCR_SUSPECT'), false);
});

test('STATUS_VALUES includes NO_BRAND', () => {
  assert.equal(STATUS_VALUES.includes('NO_BRAND'), true);
});

test('cross-brand same spec with unknown quote brand returns NO_BRAND', () => {
  const products = [product({ product_code: 'MFD2', name: '麦富迪 鸡肉猫粮', spec: '2kg' })];
  const result = matchQuote({ title: '皇家 全价猫粮 2kg' }, products);
  assert.equal(result.match_status, 'NO_BRAND');
  assert.equal(result.product_code, null);
});

test('known quote brand with missing same-brand spec returns NO_OUR_SKU', () => {
  const products = [product({ product_code: 'RC400', name: '皇家 全价猫粮', spec: '400g' })];
  const result = matchQuote({ title: '皇家 全价猫粮 2kg' }, products);
  assert.equal(result.match_status, 'NO_OUR_SKU');
  assert.equal(result.product_code, null);
});

test('short English aliases do not enter dictionary or hit inside longer words', () => {
  const products = [
    product({ product_code: 'PI1', name: 'pi 猫粮', brand: 'pi', spec: '2kg' }),
    product({ product_code: 'SC1', name: 'sc 猫粮', brand: 'sc', spec: '2kg' }),
    product({ product_code: 'AIR1', name: 'air 猫粮', brand: 'air', spec: '2kg' }),
    product({ product_code: 'CH1', name: 'champion 猫粮', spec: '2kg' }),
    product({ product_code: 'CB1', name: 'chairball 猫粮', spec: '2kg' }),
  ];
  const dict = buildBrandDictionary(products);
  assert.equal(dict.includes('pi'), false);
  assert.equal(dict.includes('sc'), false);
  assert.equal(dict.includes('air'), false);
  assert.equal(findQuoteBrand('champion 猫粮 2kg', ['pi']), null);
  assert.equal(findQuoteBrand('chairball 猫粮 2kg', ['air']), null);
});

test('quote without any known product brand returns NO_BRAND', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg' })];
  const result = matchQuote({ title: '未知牌 鸡肉成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'NO_BRAND');
  assert.equal(result.product_code, null);
});

test('long unsegmented product names do not add generic brand terms', () => {
  const products = [
    product({
      product_code: '6335104579',
      name: '菲内仕吡虫啉莫昔克丁滴剂（猫用）体重＞4-8kg/3支*0.8ml/盒',
    }),
  ];
  const dict = buildBrandDictionary(products);
  assert.equal(dict.includes('猫用'), false);
  assert.equal(dict.includes('体重'), false);
  assert.equal(dict.includes('菲内仕'), true);
});

test('cross-brand antiparasitic quote does not match through generic terms', () => {
  const products = [
    product({
      product_code: '6335104579',
      name: '菲内仕吡虫啉莫昔克丁滴剂（猫用）体重＞4-8kg/3支*0.8ml/盒',
    }),
  ];
  const result = matchQuote({ title: '【体重2-8kg猫用】海乐妙 成猫体内外驱虫' }, products);
  assert.notEqual(result.match_status, 'MATCHED');
});

test('parseQty skips pet body weight ranges', () => {
  assert.equal(parseQty('【2.6-7.5kg猫用】大宠爱 猫体内外一体驱虫'), null);
  assert.equal(parseQty('【体重2-8kg猫用】海乐妙'), null);
  assert.equal(parseQty('适合体重12-22斤 胸背带'), null);
});

test('parseQty still accepts normal product specs', () => {
  assert.equal(qty('鲜朗 烘焙全价犬粮50g/400g/2kg/6kg'), 50);
  assert.equal(qty('皇家K36 400g/袋'), 400);
  assert.equal(qty('顽皮猫条 14g*5支'), 70);
  assert.equal(qty('金盾诺信芬苯达唑片 0.1g*12粒/盒'), 1.2);
  assert.equal(qty('妮可露豆腐猫砂 2.5kg/袋'), 2500);
});

test('mixed English and Chinese brand token is split into both brands', () => {
  const products = [product({ product_code: 'GW1', name: 'GiGwi贵为 狗狗玩具拉环' })];
  const dict = buildBrandDictionary(products);
  assert.equal(dict.includes('GiGwi'), true);
  assert.equal(dict.includes('贵为'), true);
});

test('parseQty returns unit count, unit qty and total qty for package specs', () => {
  assertQty('3支*0.8ml', { unitCount: 3, unitQtyG: 0.8, qtyG: 2.4 });
  assertQty('0.5ml*1支', { unitCount: 1, unitQtyG: 0.5, qtyG: 0.5 });
  assertQty('0.1g*12片/盒', { unitCount: 12, unitQtyG: 0.1, qtyG: 1.2 });
  assertQty('14g*5支', { unitCount: 5, unitQtyG: 14, qtyG: 70 });
  assertQty('2.5kg/袋', { unitCount: 1, unitQtyG: 2500, qtyG: 2500 });
  assertQty('1盒', { unitCount: 1, unitQtyG: null, qtyG: null });
});

test('parseQty treats capital I in mI as ml', () => {
  assert.deepEqual(parseQty('3支*0.8mI'), parseQty('3支*0.8ml'));
});

test('different unit counts are not comparable', () => {
  const products = [product({ product_code: 'P1', name: '菲内仕 吡虫啉莫昔克丁滴剂', spec: '0.5ml*1支' })];
  const result = matchQuote({ title: '菲内仕 吡虫啉莫昔克丁滴剂 3支*0.8ml' }, products);
  assert.notEqual(result.match_status, 'MATCHED');
  assert.match(result.match_rule, /unit_count_mismatch/);
});

test('barcode exact match bypasses brand spec and flavor checks', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg', barcode: '6977443810555' })];
  const result = matchQuote({ title: '未知牌 牛肉 小包装 6977443810555' }, products);
  assert.equal(result.match_status, 'MATCHED');
  assert.equal(result.product_code, 'P1');
  assert.equal(result.match_rule, 'barcode');
});

test('barcode changed by one digit does not match by containment', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg', barcode: '6977443810555' })];
  const result = matchQuote({ title: '未知牌 牛肉 小包装 6977443810556' }, products);
  assert.notEqual(result.match_status, 'MATCHED');
});

test('brand and qty path still matches without barcode', () => {
  const products = [product({ product_code: 'P1', name: '皇家 鸡肉 成猫粮', spec: '2kg' })];
  const result = matchQuote({ title: '皇家 鸡肉成猫粮 2kg' }, products);
  assert.equal(result.match_status, 'MATCHED');
  assert.equal(result.product_code, 'P1');
  assert.equal(result.match_rule, 'brand+qty');
});
