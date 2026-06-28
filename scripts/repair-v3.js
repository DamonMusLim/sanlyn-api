#!/usr/bin/env node
/**
 * repair-v3.js — S60 完整数据恢复（修正 widget ID）
 *
 * 用法：
 *   node scripts/repair-v3.js                  # dry-run
 *   node scripts/repair-v3.js --execute        # 执行
 */

const JDY_URL = "https://api.jiandaoyun.com/api/v5/app/entry/data/list";
const JDY_TOKEN = "jgAipmndimpj0endT0wStd6gpspAQpAd";
const APP_ID = "689cb08a93c073210bfc772b";
const ENTRY_ID = "6419d478b9b91b00091e4d73";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const apiArg = args.find(a => a.startsWith("--api="));
const API_BASE = apiArg ? apiArg.split("=")[1] : "https://sanlyn-api.vercel.app";

// 正确的 widget ID（从 JDY 表单数据结构确认）
const W_CONTRACT     = "_widget_1679903024720";  // 合同号
const W_COMPANY_EN   = "_widget_1764468507574";  // 公司名称（英文）
const W_CATEGORY     = "_widget_1766653844751";  // 二级类目
const W_DELIVERY     = "_widget_1765186212190";  // 预计交货日期
const W_ACT_DELIVERY = "_widget_1766462809214";  // 工厂交货确认
const W_STATUS       = "_widget_1773467773240";  // 生产状态

function jdyVal(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !Array.isArray(v) && v.value !== undefined) return v.value ?? "";
  return v;
}

async function fetchAllJDY() {
  console.log("📡 Fetching ALL orders from JDY (full fields)...");
  const all = [];
  let lastId = "";
  while (true) {
    const body = { app_id: APP_ID, entry_id: ENTRY_ID, limit: 100 };
    if (lastId) body.data_id = lastId;
    const res = await fetch(JDY_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${JDY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!d.data || d.data.length === 0) break;
    all.push(...d.data);
    lastId = d.data[d.data.length - 1]._id;
    console.log(`  fetched ${all.length} records...`);
    if (d.data.length < 100) break;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`✅ Total JDY records: ${all.length}`);
  return all;
}

async function upsertOne(record) {
  const res = await fetch(`${API_BASE}/api/db/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table: "orders", record }),
  });
  const d = await res.json();
  if (!d.success) {
    console.error(`  ❌ ${record._id}: ${d.error}`);
    return false;
  }
  return true;
}

async function main() {
  const records = await fetchAllJDY();

  // 诊断
  let hasContract = 0, hasCompany = 0, hasCategory = 0, hasDelivery = 0, hasActDelivery = 0, hasStatus = 0;
  for (const r of records) {
    if (jdyVal(r[W_CONTRACT]))     hasContract++;
    if (jdyVal(r[W_COMPANY_EN]))   hasCompany++;
    if (jdyVal(r[W_CATEGORY]))     hasCategory++;
    if (jdyVal(r[W_DELIVERY]))     hasDelivery++;
    if (jdyVal(r[W_ACT_DELIVERY])) hasActDelivery++;
    if (jdyVal(r[W_STATUS]))       hasStatus++;
  }

  console.log(`\n📊 Field coverage (from JDY):`);
  console.log(`  contractNo      (${W_CONTRACT}):     ${hasContract}/${records.length}`);
  console.log(`  companyNameEN   (${W_COMPANY_EN}):    ${hasCompany}/${records.length}`);
  console.log(`  category        (${W_CATEGORY}):      ${hasCategory}/${records.length}`);
  console.log(`  deliveryDate    (${W_DELIVERY}):      ${hasDelivery}/${records.length}`);
  console.log(`  actDelivery     (${W_ACT_DELIVERY}):  ${hasActDelivery}/${records.length}`);
  console.log(`  productionStatus(${W_STATUS}):        ${hasStatus}/${records.length}`);

  // 打印前3条样例
  console.log(`\n📝 Sample records:`);
  for (const r of records.slice(0, 3)) {
    console.log(`  _id=${r._id}`);
    console.log(`    contractNo=${jdyVal(r[W_CONTRACT])}`);
    console.log(`    company=${jdyVal(r[W_COMPANY_EN])}`);
    console.log(`    category=${jdyVal(r[W_CATEGORY])}`);
    console.log(`    deliveryDate=${jdyVal(r[W_DELIVERY])}`);
    console.log(`    status=${jdyVal(r[W_STATUS])}`);
  }

  if (!EXECUTE) {
    console.log(`\n🔍 DRY RUN — add --execute to repair`);
    console.log(`   Will upsert ${records.length} records to ${API_BASE}/api/db/upsert`);
    console.log(`   ⚠️  Deploy upsert.js v3 first!`);
    return;
  }

  console.log(`\n🔧 Executing full re-sync for ${records.length} records...`);
  let ok = 0, fail = 0;
  for (let i = 0; i < records.length; i++) {
    const success = await upsertOne(records[i]);
    if (success) ok++; else fail++;
    if ((i + 1) % 10 === 0) console.log(`  progress: ${i + 1}/${records.length} (ok=${ok}, fail=${fail})`);
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`\n✅ Done! ok=${ok}, fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
