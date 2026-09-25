import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlan,
  classifyBarcodeConflict,
  isDirtySuppValue,
  parseExpireDateBatch,
  parseImageUrls,
  parseShelfLifeDays,
  parseTsv,
} from './petstore-enrich-values.mjs';

function row(overrides) {
  return {
    product_code: 'p1',
    upc_code: null,
    brand: null,
    pet_type: null,
    shelf_life_days: null,
    expire_date_batch: null,
    compliance_status: null,
    shelf_location: null,
    image_urls: null,
    image_ocr_text: null,
    ...overrides,
  };
}

test('trim 后相同不得算冲突', () => {
  const plan = buildPlan(
    [row({ product_code: 'p1', upc_code: '123' })],
    [{ product_code: 'p1', barcode: '  123 ' }],
    [],
    [],
  );

  assert.equal(plan.stats.barcode.consistent, 1);
  assert.equal(plan.stats.barcode.conflict, 0);
  assert.equal(plan.barcodeConflicts.length, 0);
});

test('腾讯空 + mini 有 -> 写入计划', () => {
  const plan = buildPlan(
    [row({ product_code: 'p1', upc_code: '123' })],
    [{ product_code: 'p1', barcode: null }],
    [],
    [],
  );

  assert.deepEqual(plan.barcodeAdds, [{ product_code: 'p1', barcode: '123' }]);
  assert.equal(plan.stats.barcode.addable, 1);
});

test('两边都有且不同 -> 不写、进冲突表计划', () => {
  const plan = buildPlan(
    [row({ product_code: 'p1', upc_code: '2000000000001' })],
    [{ product_code: 'p1', barcode: '6900000000001' }],
    [],
    [],
  );

  assert.equal(plan.barcodeAdds.length, 0);
  assert.equal(plan.barcodeConflicts.length, 1);
  assert.equal(plan.barcodeConflicts[0].resolution, 'keep_tencent');
});

test('EAN 前缀分类', () => {
  assert.equal(classifyBarcodeConflict('6900000000001', '2000000000001'), 'keep_tencent');
  assert.equal(classifyBarcodeConflict('2000000000001', '6900000000001'), 'prefer_mini');
  assert.equal(classifyBarcodeConflict('6900000000001', '6910000000001'), 'needs_damon');
  assert.equal(classifyBarcodeConflict('9670000000001', '2000000000001'), 'needs_damon');
});

test('prefer_mini 本轮仍然不写 barcode', () => {
  const plan = buildPlan(
    [row({ product_code: '6335108538', upc_code: '6900000000001' })],
    [{ product_code: '6335108538', barcode: '2000000000001' }],
    [],
    [],
  );

  assert.equal(plan.barcodeAdds.length, 0);
  assert.equal(plan.barcodeConflicts.length, 1);
  assert.equal(plan.barcodeConflicts[0].resolution, 'prefer_mini');
});

test('image_urls JSON 数组字符串正确解析，解析失败写 NULL 不报错', () => {
  assert.deepEqual(parseImageUrls('["https://a.test/1.jpg"," https://a.test/2.jpg "]'), [
    'https://a.test/1.jpg',
    'https://a.test/2.jpg',
  ]);
  assert.equal(parseImageUrls('{bad json'), null);

  const plan = buildPlan(
    [
      row({
        product_code: 'p1',
        image_urls: '["https://a.test/1.jpg"]',
        image_ocr_text: ' OCR ',
      }),
      row({
        product_code: 'p2',
        image_urls: '{bad json',
        image_ocr_text: 'text still writes',
      }),
    ],
    [
      { product_code: 'p1', barcode: null },
      { product_code: 'p2', barcode: null },
    ],
    [],
    [{ product_code: 'p1' }, { product_code: 'p2' }],
  );

  assert.deepEqual(plan.imageUpdates[0], {
    product_code: 'p1',
    image_urls: ['https://a.test/1.jpg'],
    image_ocr_text: 'OCR',
  });
  assert.deepEqual(plan.imageUpdates[1], {
    product_code: 'p2',
    image_urls: null,
    image_ocr_text: 'text still writes',
  });
});

test('TSV 使用 unit separator 并按固定列解析', () => {
  const line = [
    'p1',
    '123',
    'brand',
    'cat',
    '365',
    '2026-12',
    'ok',
    'A1',
    '["u"]',
    'ocr',
  ].join('\x1f');

  assert.deepEqual(parseTsv(`${line}\n`), [
    {
      product_code: 'p1',
      upc_code: '123',
      brand: 'brand',
      pet_type: 'cat',
      shelf_life_days: '365',
      expire_date_batch: '2026-12',
      compliance_status: 'ok',
      shelf_location: 'A1',
      image_urls: '["u"]',
      image_ocr_text: 'ocr',
    },
  ]);
});

test('shelf_life_days null 重复拼接判为脏值，跳过且不计入可补', () => {
  const dirty = 'null'.repeat(30);
  const plan = buildPlan(
    [row({ product_code: 'p1', shelf_life_days: dirty })],
    [{ product_code: 'p1', barcode: null }],
    [],
    [],
  );

  assert.equal(isDirtySuppValue('shelf_life_days', dirty), true);
  assert.equal(plan.stats.supp.shelf_life_days.fillable, 0);
  assert.equal(plan.stats.supp.shelf_life_days.dirty, 1);
  assert.equal(plan.suppUpdates.length, 0);
});

test('TSV 空字面量全部按空处理', () => {
  for (const value of ['null', 'NULL', 'undefined', '', '  ']) {
    const line = [
      'p1',
      value,
      value,
      value,
      value,
      value,
      value,
      value,
      value,
      value,
    ].join('\x1f');

    assert.deepEqual(parseTsv(`${line}\n`), [
      {
        product_code: 'p1',
        upc_code: null,
        brand: null,
        pet_type: null,
        shelf_life_days: null,
        expire_date_batch: null,
        compliance_status: null,
        shelf_location: null,
        image_urls: null,
        image_ocr_text: null,
      },
    ]);
  }
});

test('shelf_life_days 有效整数写入数字', () => {
  assert.equal(parseShelfLifeDays('540'), 540);

  const plan = buildPlan(
    [row({ product_code: 'p1', shelf_life_days: '540' })],
    [{ product_code: 'p1', barcode: null }],
    [],
    [],
  );

  assert.deepEqual(plan.suppUpdates, [{ product_code: 'p1', shelf_life_days: 540 }]);
  assert.equal(plan.stats.supp.shelf_life_days.fillable, 1);
  assert.equal(plan.stats.supp.shelf_life_days.dirty, 0);
});

test('shelf_life_days 越界或非正数跳过并计脏值', () => {
  for (const value of ['0', '-5', '99999']) {
    const plan = buildPlan(
      [row({ product_code: 'p1', shelf_life_days: value })],
      [{ product_code: 'p1', barcode: null }],
      [],
      [],
    );

    assert.equal(parseShelfLifeDays(value), null);
    assert.equal(plan.stats.supp.shelf_life_days.fillable, 0);
    assert.equal(plan.stats.supp.shelf_life_days.dirty, 1);
    assert.equal(plan.suppUpdates.length, 0);
  }
});

test('expire_date_batch 日期校验', () => {
  assert.equal(parseExpireDateBatch('2026-08-16'), '2026-08-16');
  assert.equal(parseExpireDateBatch('nullnull'), null);
  assert.equal(parseExpireDateBatch('20260816'), '20260816');

  const plan = buildPlan(
    [
      row({ product_code: 'p1', expire_date_batch: '2026-08-16' }),
      row({ product_code: 'p2', expire_date_batch: 'nullnull' }),
      row({ product_code: 'p3', expire_date_batch: '20260816' }),
    ],
    [
      { product_code: 'p1', barcode: null },
      { product_code: 'p2', barcode: null },
      { product_code: 'p3', barcode: null },
    ],
    [],
    [],
  );

  assert.deepEqual(plan.suppUpdates, [
    { product_code: 'p1', expire_date_batch: '2026-08-16' },
    { product_code: 'p3', expire_date_batch: '20260816' },
  ]);
  assert.equal(plan.stats.supp.expire_date_batch.fillable, 2);
  assert.equal(plan.stats.supp.expire_date_batch.dirty, 1);
});

test('干净条码和 image_urls 没被误伤', () => {
  const plan = buildPlan(
    [
      row({
        product_code: 'p1',
        upc_code: '6972060287131',
        image_urls: '["https://a.test/1.jpg"]',
      }),
    ],
    [{ product_code: 'p1', barcode: null }],
    [],
    [{ product_code: 'p1' }],
  );

  assert.deepEqual(plan.barcodeAdds, [{ product_code: 'p1', barcode: '6972060287131' }]);
  assert.deepEqual(plan.imageUpdates, [
    {
      product_code: 'p1',
      image_urls: ['https://a.test/1.jpg'],
      image_ocr_text: null,
    },
  ]);
});
