#!/usr/bin/env node
// S65: 从 JDY 海运计划表拉全量数据 → POST 到 jdy-plans-sync → 更新 RDS + OSS
// 用法: node scripts/sync-all-plans.js

const JDY_API = "https://api.jiandaoyun.com/api/v5/app/entry/data/list";
const JDY_TOKEN = "jgAipmndimpj0endT0wStd6gpspAQpAd";
const APP_ID = "689cb08a93c073210bfc772b";
const ENTRY_ID = "6912a100e6f679d3089bd434"; // 海运计划
const SYNC_API = "https://api.sanlyn.cn/api/jdy-plans-sync";

async function fetchAllFromJDY() {
  let all = [];
  let dataId = null;
  let page = 0;

  while (true) {
    page++;
    const body = {
      app_id: APP_ID,
      entry_id: ENTRY_ID,
      limit: 100,
      fields: [],
      filter: { rel: "and", cond: [] },
    };
    if (dataId) body.data_id = dataId;

    const res = await fetch(JDY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${JDY_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error(`JDY API error: ${res.status} ${await res.text()}`);
      break;
    }

    const data = await res.json();
    const rows = data.data || [];
    console.log(`Page ${page}: ${rows.length} records`);
    all = all.concat(rows);

    if (rows.length < 100) break;
    dataId = rows[rows.length - 1]._id;
  }

  return all;
}

async function syncToAPI(record) {
  const res = await fetch(SYNC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      op: "data_update",
      data: { data: record },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: txt, _id: record._id };
  }
  const json = await res.json();
  return { ok: true, ...json, _id: record._id };
}

async function main() {
  console.log("=== S65: Sync all shipping plans from JDY → RDS ===\n");

  console.log("Step 1: Fetching all records from JDY...");
  const records = await fetchAllFromJDY();
  console.log(`\nTotal: ${records.length} records\n`);

  if (records.length === 0) {
    console.log("No records found. Exiting.");
    return;
  }

  // Quick check: print supplier fields from first record
  const W_TRUCK = "_widget_1774376841970";
  const W_CUSTOMS = "_widget_1772454275251";
  const W_FORWARDER = "_widget_1764591553170";
  const W_TRUCK_TEXT = "_widget_1768645113405";
  const W_CUSTOMS_TEXT = "_widget_1768645113406";

  console.log("Sample record supplier fields:");
  const sample = records[0];
  console.log("  拖车(lookup):", sample[W_TRUCK] || "(empty)");
  console.log("  拖车(text):", sample[W_TRUCK_TEXT] || "(empty)");
  console.log("  报关(combo):", sample[W_CUSTOMS] || "(empty)");
  console.log("  报关(text):", sample[W_CUSTOMS_TEXT] || "(empty)");
  console.log("  货代(text):", sample[W_FORWARDER] || "(empty)");
  console.log("");

  console.log("Step 2: Syncing to RDS via jdy-plans-sync API...\n");

  let ok = 0, fail = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const shipNo = r._widget_1762828544749 || r._id;
    try {
      const result = await syncToAPI(r);
      if (result.ok) {
        ok++;
        console.log(`  [${i+1}/${records.length}] ✅ ${result.shipmentNo || shipNo} (${result.action})`);
      } else {
        fail++;
        console.log(`  [${i+1}/${records.length}] ❌ ${shipNo}: ${result.error}`);
      }
    } catch (err) {
      fail++;
      console.log(`  [${i+1}/${records.length}] ❌ ${shipNo}: ${err.message}`);
    }
    // Rate limit: 100ms between requests
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n=== Done: ${ok} success, ${fail} failed ===`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
