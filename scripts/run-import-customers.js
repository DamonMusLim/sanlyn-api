// Run: node scripts/run-import-customers.js
// Imports 9 customers from JDY Excel data into PostgreSQL
import pg from "pg";
var { Pool } = pg;

var pool = new Pool({
  host: "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432, database: "sanlyn_db",
  user: "sanlyn_admin", password: "SanlynRDS2026!",
  ssl: false, max: 2,
});

var customers = [
  { id: "699825784ebdb040c35e7c3a", code: "699825784ebdb040c35e7c3a", nameEN: "ENRICH CHAMPION SDN BHD", nameCN: "", personNo: "00015", brands: "ECO,ENRICH,DACO,WANPY", country: "", countryEN: "", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", destPort: "", address: "", consignee: "", departments: "", linkedFactory: "" },
  { id: "6984696b7b04d6e4b06005f2", code: "6984696b7b04d6e4b06005f2", nameEN: "HARMONIOUS HAPPY VENTURES SDN BHD", nameCN: "", personNo: "00011", brands: "PET'S ACADEMY,PROPAW", country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "B", paymentPolicy: "B：30%定金+70%尾款（提单/发货前）", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", destPort: "", address: "", consignee: "", departments: "FortuneSanlyn", linkedFactory: "" },
  { id: "6977345f2c2f9c249a146d10", code: "6977345f2c2f9c249a146d10", nameEN: "Eversparkles Pte Ltd", nameCN: "", personNo: "00010", brands: "Signature7", country: "", countryEN: "Philippines", currency: "USD", grade: "B", paymentPolicy: "B：30%定金+70%尾款（提单/发货前）", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "SWB", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", destPort: "", address: "Unit8148SanFranciscoSt.Plainview MandaluyongCityMetroManilaPhilippines1550", consignee: "Nexquest- KMPInternational Corporation", departments: "FortuneSanlyn", linkedFactory: "" },
  { id: "697466a4c02a1a689e67cc42", code: "697466a4c02a1a689e67cc42", nameEN: "FORTUNESANLYN GROUP LIMITED", nameCN: "", personNo: "00009", brands: "福贝,SINATURE 7,JJ PET,爱舒乐,宠银,天缘,AMD,CATSOME,DOGSOME,ECO,ENRICH,JERKYTIME,NATURAL WORLD,NU,PET'S ACADEMY,PLAY N' BOND,PROPAW,Sinature7,SNIFFLY,SNIFLLY,SOUPTIME,SOUTTIME,TING TIME,TRULY,WANPY", country: "", countryEN: "Saudi Arabia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", destPort: "", address: "SOAQALJOMA.PARK BE HAPPY.199,TRIPOLI,LIBYA", consignee: "AL BASHEK COMPANY", departments: "FortuneSanlyn", linkedFactory: "" },
  { id: "69733fa475ebb4ab77fedecd", code: "69733fa475ebb4ab77fedecd", nameEN: "", nameCN: "福贝", personNo: "00008", brands: "福贝", country: "", countryEN: "", currency: "CNY", grade: "B", paymentPolicy: "B：30%定金+70%尾款（提单/发货前）", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", destPort: "", address: "", consignee: "", departments: "福贝", linkedFactory: "" },
  { id: "6951e26dbd937e1ab631e35d", code: "CN-00037", nameEN: "PETSOME SDN BHD", nameCN: "", personNo: "00007", brands: "CATSOME,WANPY,DOGSOME", country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "SWB", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "按固定金额加价（每柜）", ourShipping: "是", destPort: "Kota Kinabalu", address: "Lot 1, Wei Hing Warehouse Jalan Bengkel Majlis Bandar Baru Penampang Jalan Bundusan 88300 Penampang Sabah, Malaysia", consignee: "PETSOME SDN BHD", departments: "PETSOME GROUP,FortuneSanlyn", linkedFactory: "CN-00055" },
  { id: "694cfbda958c870fe5992fbd", code: "694cfbda958c870fe5992fbd", nameEN: "DIBAQ (M) SDN BHD", nameCN: "", personNo: "00006", brands: "NATURAL WORLD,JERKYTIME,SOUPTIME,SOUTTIME,TING TIME,TRULY", country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.4},{"type":"尾款","percentage":0.6}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "按百分比加价", ourShipping: "是", destPort: "", address: "", consignee: "", departments: "远航国际,PETSOME GROUP", linkedFactory: "" },
  { id: "694cf863ba35328f1cb0bba6", code: "694cf863ba35328f1cb0bba6", nameEN: "JJ PET GROUP SDN BHD", nameCN: "", personNo: "00005", brands: "CATSOME", country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "不加价", ourShipping: "是", destPort: "", address: "", consignee: "", departments: "建平中砂膨润土有限公司,FortuneSanlyn", linkedFactory: "" },
  { id: "694cf301b9b1cc51f999e03a", code: "694cf301b9b1cc51f999e03a", nameEN: "PETSOME (EU) SDN BHD", nameCN: "", personNo: "00004", brands: "SNIFFLY", country: "Malaysia", countryEN: "Malaysia", currency: "CNY", grade: "A", paymentPolicy: "A：发货前全款", paymentTerms: [{"type":"定金","percentage":0.3},{"type":"尾款","percentage":0.7}], blType: "", tradeTerms: "FOB", pricingMode: "不加价", logisticsMarkup: "按固定金额加价（每柜）", ourShipping: "是", destPort: "", address: "", consignee: "", departments: "PETSOME GROUP,FortuneSanlyn", linkedFactory: "" },
];

async function run() {
  // Add columns
  var alterSQL = `
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS person_no TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS brands TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS linked_factory TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS departments TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS bl_type TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS country TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS country_en TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS currency TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS grade TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_policy TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms JSONB;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS pricing_mode TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS trade_terms TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS logistics_markup TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS our_shipping TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS destination_port TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS consignee TEXT;
  `;
  await pool.query(alterSQL);
  console.log("✅ Columns ready");

  var ok = 0, fail = 0;
  for (var c of customers) {
    try {
      await pool.query(`
        INSERT INTO customers (_id, company_code, company_name_en, company_name_cn, person_no, brands, linked_factory, departments, bl_type, country, country_en, currency, grade, payment_policy, payment_terms, pricing_mode, trade_terms, logistics_markup, our_shipping, destination_port, address, consignee)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT (_id) DO UPDATE SET
          company_code=EXCLUDED.company_code, company_name_en=EXCLUDED.company_name_en, company_name_cn=EXCLUDED.company_name_cn,
          person_no=EXCLUDED.person_no, brands=EXCLUDED.brands, linked_factory=EXCLUDED.linked_factory,
          departments=EXCLUDED.departments, bl_type=EXCLUDED.bl_type, country=EXCLUDED.country, country_en=EXCLUDED.country_en,
          currency=EXCLUDED.currency, grade=EXCLUDED.grade, payment_policy=EXCLUDED.payment_policy,
          payment_terms=EXCLUDED.payment_terms, pricing_mode=EXCLUDED.pricing_mode, trade_terms=EXCLUDED.trade_terms,
          logistics_markup=EXCLUDED.logistics_markup, our_shipping=EXCLUDED.our_shipping,
          destination_port=EXCLUDED.destination_port, address=EXCLUDED.address, consignee=EXCLUDED.consignee
      `, [
        c.id, c.code, c.nameEN, c.nameCN, c.personNo, c.brands, c.linkedFactory, c.departments,
        c.blType, c.country, c.countryEN, c.currency, c.grade, c.paymentPolicy,
        JSON.stringify(c.paymentTerms), c.pricingMode, c.tradeTerms, c.logisticsMarkup,
        c.ourShipping, c.destPort, c.address, c.consignee
      ]);
      ok++;
      console.log("  ✅ " + (c.nameEN || c.nameCN) + " | " + c.grade + " | " + (c.countryEN || "-"));
    } catch (e) {
      fail++;
      console.log("  ❌ " + (c.nameEN || c.nameCN) + ": " + e.message);
    }
  }

  // Verify
  var result = await pool.query("SELECT company_name_en, company_name_cn, brands, grade, country_en, destination_port FROM customers WHERE grade IS NOT NULL AND grade != '' ORDER BY company_name_en");
  console.log("\n📋 Database now has " + result.rows.length + " customers with grade:");
  result.rows.forEach(function(r) {
    console.log("  " + (r.company_name_en || r.company_name_cn) + " [" + r.grade + "] " + (r.country_en || "") + " brands=" + (r.brands || "-"));
  });

  console.log("\n✅ Done! " + ok + " imported, " + fail + " failed");
  await pool.end();
}

run().catch(function(e) { console.error("Fatal:", e); process.exit(1); });
