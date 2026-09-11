import { readFile, open, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STORES = ['63350001', '63350002', '63350003'];
const URL = 'https://mini.guodongcheng.cn/tenantManager/productStoreProfile/getProductProfileListV1';
const PAGE_SIZE = 100;
const CLEARANCE_RE = /临期|清仓|特惠|到期|甩卖|处理/;

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('missing output file path');
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function shanghaiDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

async function loadToken() {
  // 🩸 果冻橙 token 的真源在 mini 的 ~/Desktop/sanlyn-desktop/(mini 刷新它),
  //    ~/bin/ 那份是 Studio 拉过去的副本 —— 在 mini 上读 ~/bin/ 会拿到过期的,报 code 9006。
  //    按 环境变量 → 真源 → 副本 的顺序找。
  if (process.env.GDC_TOKEN) return process.env.GDC_TOKEN;
  const candidates = [
    join(homedir(), 'Desktop', 'sanlyn-desktop', 'minicheng_config.json'),
    join(homedir(), 'bin', 'minicheng_config.json'),
  ];
  for (const path of candidates) {
    try {
      const cfg = JSON.parse(await readFile(path, 'utf8'));
      if (cfg.token) return cfg.token;
    } catch { /* 换下一个 */ }
  }
  throw new Error('找不到果冻橙 token(试过 GDC_TOKEN 和两个配置路径)');
}

function toPriceFen(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

async function fetchPage(token, storeCode, pageNumber) {
  const body = new URLSearchParams({
    storeCode,
    pageNumber: String(pageNumber),
    pageSize: String(PAGE_SIZE),
    isMergeMultiSpecProduct: '0',
    sortRule: '0',
    productParam: '',
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: {
          Authorization: token,
          tenantCode: '6335',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== 200) throw new Error(`API code ${json.code}`);
      return json.data || {};
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(500 * attempt);
    }
  }
}

function cleanItem(item, storeCode, dropped) {
  const productCode = String(item.productCode ?? '').trim();
  if (!productCode) { dropped.bad_price += 1; return null; }

  const productName = String(item.productName ?? '');
  if (CLEARANCE_RE.test(productName)) {
    dropped.clearance += 1;
    return null;
  }

  const priceFen = toPriceFen(item.outPrice);
  if (priceFen === null) {
    dropped.bad_price += 1;
    return null;
  }

  const outPrice = priceFen / 100;
  if (outPrice >= 9999) {
    dropped.sentinel += 1;
    return null;
  }
  if (outPrice < 1) {
    dropped.too_cheap += 1;
    return null;
  }

  return {
    store_code: storeCode,
    product_code: productCode,
    product_name: productName,
    spec: String(item.spec ?? ''),
    barcode: item.upcCode == null || item.upcCode === '' ? null : String(item.upcCode),
    price_fen: priceFen,
    in_stock: Number(item.stockNum) > 0,
  };
}

async function collectStore(token, storeCode, dropped, rows) {
  let pageNumber = 1;
  let seen = 0;
  let total = null;

  while (true) {
    const data = await fetchPage(token, storeCode, pageNumber);
    const list = Array.isArray(data.list) ? data.list : [];
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : total;

    if (list.length === 0) break;

    for (const item of list) {
      seen += 1;
      const row = cleanItem(item, storeCode, dropped);
      if (row) rows.push(row);
    }

    if (total !== null && seen >= total) break;
    pageNumber += 1;
    await sleep(250);
  }

  return { total: total ?? seen, fetched: seen };
}

async function main() {
  const token = await loadToken();
  const rows = [];
  const stores = {};
  const dropped = { sentinel: 0, too_cheap: 0, clearance: 0, bad_price: 0 };

  for (const storeCode of STORES) {
    stores[storeCode] = await collectStore(token, storeCode, dropped, rows);
    console.log(`${storeCode}: fetched=${stores[storeCode].fetched}, kept=${rows.filter(r => r.store_code === storeCode).length}`);
  }

  const fetchedTotal = Object.values(stores).reduce((sum, s) => sum + s.fetched, 0);
  const droppedTotal = Object.values(dropped).reduce((sum, n) => sum + n, 0);

  console.log(`dropped.sentinel=${dropped.sentinel}`);
  console.log(`dropped.too_cheap=${dropped.too_cheap}`);
  console.log(`dropped.clearance=${dropped.clearance}`);
  console.log(`dropped.bad_price=${dropped.bad_price}`);

  if (fetchedTotal > 0 && droppedTotal / fetchedTotal > 0.15) {
    console.error(`dropped ratio too high: ${droppedTotal}/${fetchedTotal}`);
    process.exit(1);
  }

  const payload = {
    obs_date: shanghaiDate(),
    collected_at: new Date().toISOString(),
    stores,
    dropped,
    rows,
  };

  const fh = await open(outputPath, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(payload, null, 2));
  } finally {
    await fh.close();
  }
  await chmod(outputPath, 0o600);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
