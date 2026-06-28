// api/db/migrate-hh-bill-202604.js
// ONE-SHOT: Insert 天津惠禾 HH_202604ZXCK01868 (BL 269236192) into freight_supplier_bills
// Idempotent — uses ON CONFLICT DO NOTHING on (bl_no, cost_category)
// Admin-only POST. Delete this file after confirmed insert.
// Usage: curl -X POST https://api.sanlyn.cn/api/db/migrate-hh-bill-202604 \
//          -H "Authorization: Bearer <ADMIN_JWT>"

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const BILL_ROWS = [
  { cost_category: "海运费",        amount: 1375.00, currency: "USD" },
  { cost_category: "港杂费",        amount:  432.00, currency: "CNY" },
  { cost_category: "THC",           amount:  950.00, currency: "CNY" },
  { cost_category: "安保费",        amount:   12.00, currency: "CNY" },
  { cost_category: "仓单审核费",    amount:   50.00, currency: "CNY" },
  { cost_category: "VGM信息代输费", amount:   20.00, currency: "CNY" },
  { cost_category: "PTF",           amount:  100.00, currency: "CNY" },
  { cost_category: "文件费",        amount:  450.00, currency: "CNY" },
  { cost_category: "设备管理费",    amount:  100.00, currency: "CNY" },
  { cost_category: "陆运费",        amount: 2300.00, currency: "CNY" },
  { cost_category: "报关费",        amount:  100.00, currency: "CNY" },
  { cost_category: "太平洋集港费",  amount:  100.00, currency: "CNY" },
];

const META = {
  supplier:      "天津惠禾国际货运代理有限责任公司",
  supplier_type: "forwarder",
  bill_month:    "2026-04",
  bl_no:         "269236192",
  link_plan_id:  "162",          // shipping_plans.id=162, contract_no=FS20260223020-3
  source_row:    "HH_202604ZXCK01868",
  raw: {
    vessel:      "TS HONGKONG 616S",
    pol:         "天津新港",
    pod:         "亚庇 (KOTA KINABALU)",
    etd:         "2026-04-19",
    bill_to:     "上海洋宝宝国际物流有限公司",
    contract_no: "FS20260223020-3",
  },
};

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }

  const pool = getPool();

  // Check if already inserted
  const existing = await pool.query(
    "SELECT COUNT(*) AS n FROM freight_supplier_bills WHERE bl_no = $1",
    [META.bl_no]
  );
  const alreadyIn = parseInt(existing.rows[0].n);
  if (alreadyIn > 0) {
    return res.status(200).json({
      success: true,
      skipped: true,
      message: `Already imported: ${alreadyIn} rows for bl_no=${META.bl_no}. No changes made.`,
    });
  }

  const inserted = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of BILL_ROWS) {
      const result = await client.query(
        `INSERT INTO freight_supplier_bills
           (supplier, supplier_type, bill_month, bl_no, link_plan_id, source_row,
            cost_category, amount, currency, qty, reconciled, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, cost_category, amount, currency`,
        [
          META.supplier, META.supplier_type, META.bill_month, META.bl_no,
          META.link_plan_id, META.source_row,
          row.cost_category, row.amount, row.currency, 1, false,
          JSON.stringify(META.raw),
        ]
      );
      inserted.push(result.rows[0]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    console.error("[migrate-hh-bill] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
  client.release();

  const cnyTotal = BILL_ROWS.filter(r => r.currency === "CNY").reduce((s, r) => s + r.amount, 0);
  const usdTotal = BILL_ROWS.filter(r => r.currency === "USD").reduce((s, r) => s + r.amount, 0);

  console.log(`[migrate-hh-bill] Inserted ${inserted.length} rows for bl_no=${META.bl_no}`);

  return res.status(200).json({
    success: true,
    inserted_count: inserted.length,
    bl_no: META.bl_no,
    supplier: META.supplier,
    totals: { CNY: cnyTotal, USD: usdTotal },
    rows: inserted,
  });
}
