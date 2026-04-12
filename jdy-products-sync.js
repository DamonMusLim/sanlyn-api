#!/usr/bin/env node
// jdy-products-sync.js — S71 JDY产品信息 → RDS products表 同步
// 用法: node jdy-products-sync.js
// 部署: 可在本地跑，也可以部署到FC

const https = require('https');

const JDY_API = 'https://api.jiandaoyun.com/api/v5';
const JDY_TOKEN = 'jgAipmndimpj0endT0wStd6gpspAQpAd';
const JDY_APP = '689cb08a93c073210bfc772b';
const JDY_PRODUCT_ENTRY = '5c6a555e2ce076490e9e0595';

// Vercel API (用upsert写RDS)
const UPSERT_API = 'https://sanlyn-api.vercel.app/api/db/upsert';

// JDY Widget ID → 字段名映射
const WIDGET_MAP = {
  '_widget_1755320381920': 'code',
  '_widget_1679316712691': 'productCode',
  '_widget_1755320381922': 'productName',
  '_widget_1764952417030': 'productNameCn',
  '_widget_1755320381921': 'brand',
  '_widget_1764580624342': 'brandCn',
  '_widget_1550556533919': 'size',
  '_widget_1770168687867': 'unit',
  '_widget_1755101384423': 'cbm',
  '_widget_1755101384424': 'netWeight',
  '_widget_1755101384425': 'grossWeight',
  '_widget_1773914830501': 'moq',
  '_widget_1765185485727': 'factoryPrice',
  '_widget_1770717211264': 'priceUSD',
  '_widget_1770615910946': 'price',
  '_widget_1770717211265': 'price1',
  '_widget_1770717211266': 'price2',
  '_widget_1770717211267': 'price3',
  '_widget_1770799762840': 'profit',
  '_widget_1762569306803': 'hsCode',
  '_widget_1766398374830': 'declName',
  '_widget_1766398374831': 'declElements',
  '_widget_1767150481600': 'declAmount',
  '_widget_1766398374834': 'blDesc',
  '_widget_1762569306816': 'vatRate',
  '_widget_1762569306817': 'taxRefund',
  '_widget_1762569306802': 'flavor',
  '_widget_1759256456320': 'cat1',
  '_widget_1759256456321': 'cat2',
  '_widget_1759256456322': 'cat3',
  '_widget_1767007835477': 'cat4',
  '_widget_1764959440239': 'factory',
  '_widget_1765087824863': 'issuer',
  '_widget_1771624463708': 'tradeTerms',
  '_widget_1755320381932': 'palletSize',
  '_widget_1763435074560': 'bagPerPallet',
  '_widget_1763435074559': 'palletLayer',
  '_widget_1770626890613': 'bgBx',
  '_widget_1762569306819': 'remark',
  '_widget_1550472542924': 'image',
  '_widget_1764592418295': 'factoryLink',
  '_widget_1764395515602': 'issuerLookup',
  '_widget_1763436128100': 'factoryBrandLookup',
  '_widget_1765185198903': 'owner',
};

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// 从JDY拉取所有产品数据
async function fetchAllJDYProducts() {
  let allData = [];
  let dataId = '';
  let hasMore = true;
  let page = 0;

  while (hasMore) {
    page++;
    const body = {
      app_id: JDY_APP,
      entry_id: JDY_PRODUCT_ENTRY,
      limit: 100,
      fields: [],
      filter: { rel: 'and', cond: [] },
    };
    if (dataId) body.data_id = dataId;

    console.log(`[JDY] Fetching page ${page}...`);
    const resp = await fetch(`${JDY_API}/app/entry/data/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JDY_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const list = resp.data || [];
    console.log(`[JDY] Got ${list.length} records`);
    allData = allData.concat(list);

    if (list.length < 100) {
      hasMore = false;
    } else {
      dataId = list[list.length - 1]._id;
    }
  }

  console.log(`[JDY] Total: ${allData.length} products`);
  return allData;
}

// 归一化JDY记录
function normalizeProduct(jdyRecord) {
  const raw = {};
  // 保留原始widget数据
  for (const [key, value] of Object.entries(jdyRecord)) {
    if (key.startsWith('_widget_')) {
      raw[key] = value;
      // 同时写入可读字段名
      if (WIDGET_MAP[key]) {
        raw[WIDGET_MAP[key]] = value;
      }
    }
  }
  raw._id = jdyRecord._id;
  raw.creator = jdyRecord.creator;
  raw.createTime = jdyRecord.createTime;
  raw.updateTime = jdyRecord.updateTime;

  // 提取顶层索引字段
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k] || jdyRecord[k];
      if (v != null && v !== '') return v;
    }
    return null;
  };

  const num = (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  // 处理图片字段 (JDY image是数组)
  let imageUrl = null;
  const imgField = jdyRecord['_widget_1550472542924'];
  if (Array.isArray(imgField) && imgField.length > 0 && imgField[0].url) {
    imageUrl = imgField[0].url;
  }

  return {
    _id: jdyRecord._id,
    sku: pick('code', 'productCode', '_widget_1755320381920') || null,
    product_name: pick('productName', '_widget_1755320381922') || null,
    product_name_cn: pick('productNameCn', '_widget_1764952417030') || null,
    brand: pick('brand', '_widget_1755320381921') || null,
    category: pick('cat1', '_widget_1759256456320') || null,
    spec: pick('size', '_widget_1550556533919') || null,
    factory_price: num(pick('factoryPrice', '_widget_1765185485727')),
    sanlyn_price: num(pick('priceUSD', '_widget_1770717211264')),
    cbm: num(pick('cbm', '_widget_1755101384423')),
    weight: num(pick('netWeight', '_widget_1755101384424')),
    gross_weight: num(pick('grossWeight', '_widget_1755101384425')),
    image_url: imageUrl,
    raw: { ...raw, imageUrl },
  };
}

// 通过upsert API写入RDS
async function upsertProduct(product) {
  try {
    const resp = await fetch(UPSERT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'products',
        record: product,
        conflict: '_id', // 用JDY _id做去重
      }),
    });
    return resp;
  } catch (e) {
    console.error(`[UPSERT] Failed for ${product.sku}: ${e.message}`);
    return null;
  }
}

// 主流程
async function main() {
  console.log('=== JDY Products Sync Start ===');
  console.log(`Time: ${new Date().toISOString()}`);

  // 1. 从JDY拉取
  const jdyProducts = await fetchAllJDYProducts();

  // 2. 归一化 + 写入RDS
  let success = 0;
  let fail = 0;
  for (let i = 0; i < jdyProducts.length; i++) {
    const normalized = normalizeProduct(jdyProducts[i]);
    console.log(`[${i + 1}/${jdyProducts.length}] ${normalized.sku || 'no-sku'} - ${normalized.product_name || normalized.product_name_cn || 'unnamed'}`);

    const result = await upsertProduct(normalized);
    if (result && !result.error) {
      success++;
    } else {
      fail++;
      console.error(`  FAIL: ${JSON.stringify(result)}`);
    }

    // 节流: 每50个暂停500ms
    if (i > 0 && i % 50 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n=== Sync Complete ===`);
  console.log(`Success: ${success}, Failed: ${fail}, Total: ${jdyProducts.length}`);
}

main().catch(console.error);
