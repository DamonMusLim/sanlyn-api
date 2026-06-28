/**
 * 从 JDY 导出的 Excel 数据导入客户到 SQL
 * 运行方式: node scripts/import-customers.js
 * 或直接通过 API: POST /api/db/customers { customers: [...] }
 */

var API = "https://sanlyn-api.vercel.app/api/db/customers";

var customers = [
  {
    company_code: "ENRICH",
    name_en: "ENRICH CHAMPION SDN BHD",
    brands: ["ECO","ENRICH","DACO","WANPY"],
    country: "",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", markupMode:"不加价", logisticsMarkup:"不加价", weHandleOcean:"是", portalRole:"customer" }
  },
  {
    company_code: "HARMONIOUS",
    name_en: "HARMONIOUS HAPPY VENTURES SDN BHD",
    brands: ["PET'S ACADEMY","PROPAW"],
    country: "Malaysia",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"B", defaultPayment:"B：30%定金+70%尾款", tradeTerms:"FOB", markupMode:"不加价", logisticsMarkup:"不加价", weHandleOcean:"是", department:"FortuneSanlyn", portalRole:"customer" }
  },
  {
    company_code: "EVERSPARKLES",
    name_en: "Eversparkles Pte Ltd",
    brands: ["Signature7"],
    country: "",
    currency: "USD",
    portal_role: "customer",
    raw: { customerLevel:"B", defaultPayment:"B：30%定金+70%尾款", tradeTerms:"FOB", blTypePref:"SWB", markupMode:"不加价", logisticsMarkup:"不加价", weHandleOcean:"是", portalRole:"customer" }
  },
  {
    company_code: "FORTUNESANLYN",
    name_en: "FORTUNESANLYN GROUP LIMITED",
    brands: ["福贝","SINATURE 7","JJ PET","爱舒乐","宠银","天缘","AMD","CATSOME","DOGSOME","ECO","ENRICH","JERKYTIME","NATURAL WORLD","NU","PET'S ACADEMY","PLAY N' BOND","PROPAW","Sinature7","SNIFFLY","SNIFLLY","SOUPTIME","SOUTTIME","TING TIME","TRULY","WANPY"],
    country: "",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", markupMode:"不加价", logisticsMarkup:"不加价", weHandleOcean:"是", portalRole:"customer" }
  },
  {
    company_code: "PETSOME",
    name_en: "PETSOME SDN BHD",
    brands: ["CATSOME","WANPY","DOGSOME"],
    country: "Malaysia",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", blTypePref:"SWB", markupMode:"不加价", logisticsMarkup:"按固定金额加价（每柜）", logisticsMarkupCur:"USD", weHandleOcean:"是", relatedFactory:"CN-00055", portalRole:"customer" }
  },
  {
    company_code: "DIBAQ",
    name_en: "DIBAQ (M) SDN BHD",
    brands: ["NATURAL WORLD","JERKYTIME","SOUPTIME","SOUTTIME","TING TIME","TRULY"],
    country: "Malaysia",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", markupMode:"不加价", logisticsMarkup:"按百分比加价", logisticsMarkupPct:0.2, logisticsMarkupCur:"USD", weHandleOcean:"是", portalRole:"customer" }
  },
  {
    company_code: "JJ_PET",
    name_en: "JJ PET GROUP SDN BHD",
    brands: ["CATSOME"],
    country: "Malaysia",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", markupMode:"不加价", logisticsMarkup:"不加价", weHandleOcean:"是", portalRole:"customer" }
  },
  {
    company_code: "PETSOME_EU",
    name_en: "PETSOME (EU) SDN BHD",
    brands: ["SNIFFLY"],
    country: "Malaysia",
    currency: "CNY",
    portal_role: "customer",
    raw: { customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", markupMode:"不加价", logisticsMarkup:"按固定金额加价（每柜）", logisticsMarkupCtn:20, logisticsMarkupCur:"USD", weHandleOcean:"是", portalRole:"customer" }
  },
];

async function run() {
  console.log("Importing " + customers.length + " customers...");
  var res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customers: customers }),
  });
  var data = await res.json();
  console.log("Result:", JSON.stringify(data, null, 2));
}

run().catch(function(e) { console.error(e); });
