#!/usr/bin/env node
/**
 * repair-category-v2.js — S60 完整数据恢复脚本
 *
 * 问题：repair v1 把 JDY 原始 _widget_xxx 数据直接传给 upsert，
 *       导致 contract_no/customer 等顶层索引字段全部变 null，订单消失。
 *
 * 修复：
 *   1. 从 JDY 拉所有订单（全部字段）
 *   2. 通过升级后的 upsert API 重新写入（upsert v2 支持 _widget_ 自动映射）
 *
 * 前提：先部署 upsert.js v2（含 _normalizeJDYOrder）
 *
 * 用法：
 *   node scripts/repair-category-v2.js                  # dry-run
 *   node scripts/repair-category-v2.js --execute        # 执行
 */

const JDY_URL = "https://api.jiandaoyun.com/api/v5/app/entry/data/list";
const JDY_TOKEN = "jgAipmndimpj0endT0wStd6gpspAQpAd";
const APP_ID = "689cb08a93c073210bfc772b";
const ENTRY_ID = "6419d478b9b91b00091e4d73";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const apiArg = args.find(a => a.startsWith("--api="));
const API_BASE = apiArg ? apiArg.split("=")[1] : "https://sanlyn-api.vercel.app";

async function fetchAllJDY() {
  console.log("📡 Fetching ALL orders from JDY (full fields)...");
  const all = [];
  let lastId = "";
  while (true) {
    const body = {
      app_id: APP_ID,
      entry_id: ENTRY_ID,
      limit: 100,
      // 不指定 fields — 拉全部字段
    };
    if (lastId) body.data_id = lastId;

    const res = await fetch(JDY_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${JDY_TOKEN}`,
        "Content-Type": "application/json",
      },
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
  const payload = {
    table: "orders",
    record,
  };

  const res = await fetch(`${API_BASE}/api/db/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

  // 诊断：检查关键字段
  const W_CONTRACT = "_widget_1766730818801";
  const W_COMPANY  = "_widget_1764468507574";
  const W_CATEGORY = "_widget_1766653844751";

  let hasContract = 0, hasCompany = 0, hasCategory = 0;
  for (const r of records) {
    const cv = r[W_CONTRACT]; const c = cv && (typeof cv === "object" ? cv.value : cv);
    const ev = r[W_COMPANY];  const e = ev && (typeof ev === "object" ? ev.value : ev);
    const kv = r[W_CATEGORY]; const k = kv && (typeof kv === "object" ? kv.value : kv);
    if (c) hasContract++;
    if (e) hasCompany++;
    if (k) hasCategory++;
  }

  console.log(`\n📊 Field coverage:`);
  console.log(`  contractNo:    ${hasContract}/${records.length}`);
  console.log(`  companyNameEN: ${hasCompany}/${records.length}`);
  console.log(`  category:      ${hasCategory}/${records.length}`);

  if (!EXECUTE) {
    console.log(`\n🔍 DRY RUN — add --execute to repair`);
    console.log(`   Will upsert ${records.length} records to ${API_BASE}/api/db/upsert`);
    console.log(`   ⚠️  Make sure upsert.js v2 (with _normalizeJDYOrder) is deployed first!`);
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
