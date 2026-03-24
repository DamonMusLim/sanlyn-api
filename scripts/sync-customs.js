// sync-customs.js — 从 JDY 报关资料表拉数据 → upsert 到 RDS customs_data
// 用法: node sync-customs.js
// 环境变量: JDY_TOKEN, UPSERT_URL (sanlyn-api.vercel.app/api/db/upsert)

const JDY_API   = "https://api.jiandaoyun.com/api/v5/app/entry/data/list";
const APP_ID    = "689cb08a93c073210bfc772b";
const ENTRY_ID  = "691e74ea175dfbf0607cc820";  // 报关资料表
const JDY_TOKEN = process.env.JDY_TOKEN || "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const UPSERT_URL = process.env.UPSERT_URL || "https://sanlyn-api.vercel.app/api/db/upsert";

async function fetchAllJDY() {
  let all = [];
  let dataId = "";
  let hasMore = true;
  while (hasMore) {
    const body = {
      app_id: APP_ID,
      entry_id: ENTRY_ID,
      limit: 100,
      fields: [],  // 空=全部字段
      filter: { rel: "and", cond: [] },
    };
    if (dataId) body.data_id = dataId;

    const resp = await fetch(JDY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${JDY_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      console.error("JDY API error:", resp.status, await resp.text());
      break;
    }
    const json = await resp.json();
    const rows = json.data || [];
    all = all.concat(rows);
    console.log(`  fetched ${rows.length} rows (total: ${all.length})`);
    
    if (rows.length < 100) {
      hasMore = false;
    } else {
      dataId = rows[rows.length - 1]._id;
    }
  }
  return all;
}

async function upsertOne(record) {
  const resp = await fetch(UPSERT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table: "customs_data", record }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`  ❌ upsert failed for ${record._id}: ${txt}`);
    return false;
  }
  return true;
}

async function main() {
  console.log("=== S61: Sync JDY 报关资料 → RDS customs_data ===");
  console.log(`JDY Entry: ${ENTRY_ID}`);
  console.log(`Upsert URL: ${UPSERT_URL}\n`);

  const rows = await fetchAllJDY();
  console.log(`\nTotal records from JDY: ${rows.length}\n`);

  let ok = 0, fail = 0;
  for (const r of rows) {
    // 直接传原始 JDY 数据，upsert.js 的 _normalizeCustomsRecord 会处理 widget 映射
    const success = await upsertOne(r);
    if (success) {
      ok++;
      // 简要日志
      const customsNo = r._widget_1763603690386 || r._id?.slice(-8);
      const shipmentNo = r._widget_1767082183888 || "—";
      console.log(`  ✅ ${ok}/${rows.length} customsNo=${customsNo} shipment=${shipmentNo}`);
    } else {
      fail++;
    }
  }

  console.log(`\n=== Done: ${ok} success, ${fail} failed ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
