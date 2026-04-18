// Run: node scripts/run-import-customers.js
// Upserts 9 customers from JDY Excel into PostgreSQL (matches actual schema)
import "dotenv/config";
import pg from "pg";
var { Pool } = pg;

var pool = new Pool({
  host: process.env.PG_HOST || "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432, database: process.env.PG_DB || "sanlyn_db",
  user: process.env.PG_USER || "sanlyn_admin", password: process.env.PG_PASSWORD,
  ssl: false, max: 2,
});

var customers = [
  { code: "ENRICH", nameEN: "ENRICH CHAMPION SDN BHD", nameCN: "", personNo: "00015", brands: ["ECO","ENRICH","DACO","WANPY"], country: "", countryEN: "", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", addresses: [], departments: "FortuneSanlyn", linkedFactory: "" },
  { code: "HARMONIOUS", nameEN: "HARMONIOUS HAPPY VENTURES SDN BHD", nameCN: "", personNo: "00011", brands: ["PET'S ACADEMY","PROPAW"], country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "B", paymentPolicy: "B：30%定金+70%尾款（提单/发货前）", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", addresses: [], departments: "FortuneSanlyn", linkedFactory: "" },
  { code: "EVERSPARKLES", nameEN: "Eversparkles Pte Ltd", nameCN: "", personNo: "00010", brands: ["Signature7"], country: "Philippines", countryEN: "Philippines", currency: "USD", grade: "B", paymentPolicy: "B：30%定金+70%尾款（提单/发货前）", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "SWB", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", addresses: [{"port":"","country":"Philippines","address":"Unit8148SanFranciscoSt.Plainview MandaluyongCityMetroManilaPhilippines1550","consignee":"Nexquest- KMPInternational Corporation"}], departments: "FortuneSanlyn", linkedFactory: "" },
  { code: "FORTUNESANLYN", nameEN: "FORTUNESANLYN GROUP LIMITED", nameCN: "", personNo: "00009", brands: ["福贝","SINATURE 7","JJ PET","爱舒乐","宠银","天缘","AMD","CATSOME","DOGSOME","ECO","ENRICH","JERKYTIME","NATURAL WORLD","NU","PET'S ACADEMY","PLAY N' BOND","PROPAW","Sinature7","SNIFFLY","SOUPTIME","TING TIME","TRULY","WANPY"], country: "Saudi Arabia", countryEN: "Saudi Arabia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", addresses: [{"port":"","country":"Saudi Arabia","address":"SOAQALJOMA.PARK BE HAPPY.199,TRIPOLI,LIBYA","consignee":"AL BASHEK COMPANY"}], departments: "FortuneSanlyn", linkedFactory: "" },
  { code: "FUBEI", nameEN: "", nameCN: "福贝", personNo: "00008", brands: ["福贝"], country: "", countryEN: "", currency: "CNY", grade: "B", paymentPolicy: "B：30%定金+70%尾款（提单/发货前）", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", addresses: [], departments: "福贝", linkedFactory: "" },
  { code: "PETSOME", nameEN: "PETSOME SDN BHD", nameCN: "", personNo: "00007", brands: ["CATSOME","WANPY","DOGSOME"], country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "SWB", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "按固定金额加价（每柜）", ourShipping: "是", addresses: [{"port":"Kota Kinabalu","country":"Malaysia","address":"Lot 1, Wei Hing Warehouse Jalan Bengkel Majlis Bandar Baru Penampang Jalan Bundusan 88300 Penampang Sabah, Malaysia","consignee":"PETSOME SDN BHD"}], departments: "PETSOME GROUP,FortuneSanlyn", linkedFactory: "CN-00055" },
  { code: "DIBAQ", nameEN: "DIBAQ (M) SDN BHD", nameCN: "", personNo: "00006", brands: ["NATURAL WORLD","JERKYTIME","SOUPTIME","SOUTTIME","TING TIME","TRULY"], country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.4},{"type":"尾款","percentage":0.6}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "按百分比加价", ourShipping: "是", addresses: [], departments: "远航国际,PETSOME GROUP", linkedFactory: "" },
  { code: "JJPET", nameEN: "JJ PET GROUP SDN BHD", nameCN: "", personNo: "00005", brands: ["CATSOME"], country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", addresses: [], departments: "建平中砂膨润土有限公司,FortuneSanlyn", linkedFactory: "" },
  { code: "PETSOME-EU", nameEN: "PETSOME (EU) SDN BHD", nameCN: "", personNo: "00004", brands: ["SNIFFLY"], country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "按固定金额加价（每柜）", ourShipping: "是", addresses: [], departments: "PETSOME GROUP,FortuneSanlyn", linkedFactory: "" },
];

async function run() {
  var ok = 0, fail = 0, updated = 0;

  for (var c of customers) {
    try {
      // Check if customer already exists by name_en or company_code
      var existing = await pool.query(
        "SELECT id, company_code, name_en FROM customers WHERE LOWER(name_en) = LOWER($1) OR company_code = $2 LIMIT 1",
        [c.nameEN || "___none___", c.code]
      );

      if (existing.rows.length > 0) {
        // Update existing
        await pool.query(`
          UPDATE customers SET
            company_code = $1, person_no = $2, brands = $3, country = $4, country_en = $5,
            currency = $6, grade = $7, payment_policy = $8, payment_terms = $9,
            bl_type = $10, trade_terms = $11, pricing_mode = $12, logistics_markup = $13,
            our_shipping = $14, addresses = $15, departments = $16, linked_factory = $17,
            updated_at = NOW()
          WHERE id = $18
        `, [
          c.code, c.personNo, JSON.stringify(c.brands), c.country, c.countryEN,
          c.currency, c.grade, c.paymentPolicy, JSON.stringify(c.paymentTerms),
          c.blType, c.tradeTerms, c.pricingMode, c.logisticsMarkup,
          c.ourShipping, JSON.stringify(c.addresses), c.departments, c.linkedFactory,
          existing.rows[0].id
        ]);
        updated++;
        console.log("  🔄 Updated: " + (c.nameEN || c.nameCN) + " (id=" + existing.rows[0].id + ")");
      } else {
        // Insert new
        await pool.query(`
          INSERT INTO customers (company_code, name_en, name_cn, person_no, brands, country, country_en,
            currency, grade, payment_policy, payment_terms, bl_type, trade_terms, pricing_mode,
            logistics_markup, our_shipping, addresses, departments, linked_factory, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())
        `, [
          c.code, c.nameEN, c.nameCN, c.personNo, JSON.stringify(c.brands), c.country, c.countryEN,
          c.currency, c.grade, c.paymentPolicy, JSON.stringify(c.paymentTerms),
          c.blType, c.tradeTerms, c.pricingMode, c.logisticsMarkup,
          c.ourShipping, JSON.stringify(c.addresses), c.departments, c.linkedFactory
        ]);
        ok++;
        console.log("  ✅ Inserted: " + (c.nameEN || c.nameCN));
      }
    } catch (e) {
      fail++;
      console.log("  ❌ " + (c.nameEN || c.nameCN) + ": " + e.message);
    }
  }

  // Verify
  var result = await pool.query("SELECT company_code, name_en, name_cn, brands, grade, country_en, addresses FROM customers WHERE grade IS NOT NULL AND grade != '' ORDER BY name_en");
  console.log("\n📋 Customers with grade (" + result.rows.length + "):");
  result.rows.forEach(function(r) {
    var brands = Array.isArray(r.brands) ? r.brands.join(",") : (r.brands || "-");
    var addr = Array.isArray(r.addresses) && r.addresses.length > 0 ? r.addresses[0].consignee || "" : "";
    console.log("  " + (r.name_en || r.name_cn) + " [" + r.grade + "] " + (r.country_en || "") + " | brands=" + brands + (addr ? " | consignee=" + addr : ""));
  });

  console.log("\n✅ Done! " + ok + " new, " + updated + " updated, " + fail + " failed");
  await pool.end();
}

run().catch(function(e) { console.error("Fatal:", e); process.exit(1); });
