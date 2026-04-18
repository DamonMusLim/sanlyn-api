import "dotenv/config";
import pkg from "pg";
var Pool = pkg.Pool;

var pool = new Pool({
  host: process.env.PG_HOST || "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432,
  database: process.env.PG_DB || "sanlyn_db",
  user: process.env.PG_USER || "sanlyn_admin",
  password: process.env.PG_PASSWORD,
  ssl: false,
});

// Group assignments: group_id → [company_codes belonging to that group]
// When a user logs in with groupId "PETSOME", they should see
// PETSOME, PETSOME_EU, and DIBAQ as their company options.
var groups = [
  { groupId: "PETSOME",       codes: ["PETSOME", "PETSOME_EU", "DIBAQ"] },
  { groupId: "ENRICH",        codes: ["ENRICH"] },
  { groupId: "HARMONIOUS",    codes: ["HARMONIOUS"] },
  { groupId: "EVERSPARKLES",  codes: ["EVERSPARKLES"] },
  { groupId: "FORTUNESANLYN", codes: ["FORTUNESANLYN"] },
  { groupId: "JJ_PET",        codes: ["JJ_PET"] },
];

// Also update customer data from JDY Excel export with richer info
var enrichments = [
  {
    company_code: "ENRICH",
    payment_term: "A：发货前全款",
    raw_extra: { customerLevel: "A", defaultPayment: "A：发货前全款", tradeTerms: "FOB", weHandleOcean: "是", pricingMode: "不加价", logisticsMarkup: "不加价" }
  },
  {
    company_code: "HARMONIOUS",
    payment_term: "B：30%定金+70%尾款",
    raw_extra: { customerLevel: "B", defaultPayment: "B：30%定金+70%尾款", tradeTerms: "FOB", weHandleOcean: "是", pricingMode: "不加价", logisticsMarkup: "不加价" }
  },
  {
    company_code: "EVERSPARKLES",
    raw_extra: { customerLevel: "B", tradeTerms: "FOB", blTypePref: "SWB", weHandleOcean: "是" },
    addresses: [{ country: "Philippines", port: "", consignee: "Nexquest- KMPInternational Corporation" }]
  },
  {
    company_code: "FORTUNESANLYN",
    raw_extra: { customerLevel: "A", tradeTerms: "FOB", weHandleOcean: "是" },
    addresses: [{ country: "Saudi Arabia", port: "", consignee: "AL BASHEK COMPANY" }]
  },
  {
    company_code: "PETSOME",
    raw_extra: { customerLevel: "A", tradeTerms: "FOB", blTypePref: "SWB", logisticsMarkup: "按固定金额加价（每柜）", weHandleOcean: "是" },
    addresses: [{ country: "Malaysia", port: "Kota Kinabalu", consignee: "PETSOME SDN BHD" }]
  },
  {
    company_code: "DIBAQ",
    raw_extra: { customerLevel: "A", tradeTerms: "FOB", logisticsMarkup: "按百分比加价", logisticsMarkupPct: 0.2, weHandleOcean: "是" }
  },
  {
    company_code: "JJ_PET",
    raw_extra: { customerLevel: "A", tradeTerms: "FOB", weHandleOcean: "是" }
  },
  {
    company_code: "PETSOME_EU",
    raw_extra: { customerLevel: "A", tradeTerms: "FOB", logisticsMarkup: "按固定金额加价（每柜）", logisticsMarkupCtn: 20, weHandleOcean: "是" }
  },
];

async function run() {
  console.log("Step 1: Setting group_id on company-coded records...\n");
  for (var g of groups) {
    for (var code of g.codes) {
      try {
        var r = await pool.query(
          "UPDATE customers SET group_id = $1, updated_at = NOW() WHERE company_code = $2 RETURNING company_code, group_id, name_en",
          [g.groupId, code]
        );
        if (r.rowCount > 0) {
          console.log("  ✓ " + code + " → group_id = " + g.groupId + " (" + r.rows[0].name_en + ")");
        } else {
          console.log("  ✗ " + code + " — not found");
        }
      } catch(e) { console.log("  ✗ " + code + ": " + e.message); }
    }
  }

  console.log("\nStep 2: Enriching customer data with JDY export info...\n");
  for (var e of enrichments) {
    try {
      var sets = [];
      var params = [e.company_code];
      var idx = 2;

      if (e.payment_term) {
        sets.push("payment_term = $" + idx);
        params.push(e.payment_term);
        idx++;
      }
      if (e.addresses) {
        sets.push("addresses = $" + idx);
        params.push(JSON.stringify(e.addresses));
        idx++;
      }
      if (e.raw_extra) {
        sets.push("raw = raw || $" + idx);
        params.push(JSON.stringify(e.raw_extra));
        idx++;
      }
      sets.push("updated_at = NOW()");

      var sql = "UPDATE customers SET " + sets.join(", ") + " WHERE company_code = $1 RETURNING company_code, name_en, group_id, payment_term, addresses";
      var r = await pool.query(sql, params);
      if (r.rowCount > 0) {
        console.log("  ✓ " + e.company_code + " enriched — payment: " + (r.rows[0].payment_term || "n/a") + ", addresses: " + JSON.stringify(r.rows[0].addresses));
      } else {
        console.log("  ✗ " + e.company_code + " — not found");
      }
    } catch(err) { console.log("  ✗ " + e.company_code + ": " + err.message); }
  }

  console.log("\nStep 3: Mark old CN-coded records as inactive (they lack brands)...\n");
  var r = await pool.query(
    "UPDATE customers SET is_active = false, updated_at = NOW() WHERE company_code LIKE 'CN-%' AND (brands IS NULL OR brands = '[]'::jsonb) RETURNING company_code, name_en"
  );
  console.log("  Deactivated " + r.rowCount + " old CN-coded records");

  console.log("\nStep 4: Verify active customers with group_id and brands...\n");
  var all = await pool.query(
    "SELECT company_code, name_en, group_id, brands, is_active, addresses FROM customers WHERE is_active = true ORDER BY company_code"
  );
  console.log("Active customers: " + all.rowCount + "\n");
  for (var row of all.rows) {
    console.log("  " + row.company_code + " | group=" + (row.group_id || "—") + " | " + row.name_en + " | brands=" + JSON.stringify(row.brands));
  }

  await pool.end();
  console.log("\nDone!");
}

run().catch(function(e) { console.error(e); pool.end(); });
