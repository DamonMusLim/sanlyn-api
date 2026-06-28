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

var customers = [
  { company_code:"ENRICH", name_en:"ENRICH CHAMPION SDN BHD", brands:["ECO","ENRICH","DACO","WANPY"], country:"", currency:"CNY", raw:{ customerLevel:"A", defaultPayment:"A：发货前全款", tradeTerms:"FOB", weHandleOcean:"是", portalRole:"customer" } },
  { company_code:"HARMONIOUS", name_en:"HARMONIOUS HAPPY VENTURES SDN BHD", brands:["PET'S ACADEMY","PROPAW"], country:"Malaysia", currency:"CNY", raw:{ customerLevel:"B", defaultPayment:"B：30%定金+70%尾款", tradeTerms:"FOB", weHandleOcean:"是", portalRole:"customer" } },
  { company_code:"EVERSPARKLES", name_en:"Eversparkles Pte Ltd", brands:["Signature7"], country:"", currency:"USD", raw:{ customerLevel:"B", tradeTerms:"FOB", blTypePref:"SWB", weHandleOcean:"是", portalRole:"customer" } },
  { company_code:"FORTUNESANLYN", name_en:"FORTUNESANLYN GROUP LIMITED", brands:["福贝","SINATURE 7","JJ PET","爱舒乐","宠银","天缘","AMD","CATSOME","DOGSOME","ECO","ENRICH","JERKYTIME","NATURAL WORLD","NU","PET'S ACADEMY","PLAY N' BOND","PROPAW","Sinature7","SNIFFLY","SNIFLLY","SOUPTIME","SOUTTIME","TING TIME","TRULY","WANPY"], country:"", currency:"CNY", raw:{ customerLevel:"A", tradeTerms:"FOB", weHandleOcean:"是", portalRole:"customer" } },
  { company_code:"PETSOME", name_en:"PETSOME SDN BHD", brands:["CATSOME","WANPY","DOGSOME"], country:"Malaysia", currency:"CNY", raw:{ customerLevel:"A", tradeTerms:"FOB", blTypePref:"SWB", logisticsMarkup:"按固定金额加价（每柜）", portalRole:"customer" } },
  { company_code:"DIBAQ", name_en:"DIBAQ (M) SDN BHD", brands:["NATURAL WORLD","JERKYTIME","SOUPTIME","SOUTTIME","TING TIME","TRULY"], country:"Malaysia", currency:"CNY", raw:{ customerLevel:"A", tradeTerms:"FOB", logisticsMarkup:"按百分比加价", logisticsMarkupPct:0.2, weHandleOcean:"是", portalRole:"customer" } },
  { company_code:"JJ_PET", name_en:"JJ PET GROUP SDN BHD", brands:["CATSOME"], country:"Malaysia", currency:"CNY", raw:{ customerLevel:"A", tradeTerms:"FOB", weHandleOcean:"是", portalRole:"customer" } },
  { company_code:"PETSOME_EU", name_en:"PETSOME (EU) SDN BHD", brands:["SNIFFLY"], country:"Malaysia", currency:"CNY", raw:{ customerLevel:"A", tradeTerms:"FOB", logisticsMarkup:"按固定金额加价（每柜）", logisticsMarkupCtn:20, weHandleOcean:"是", portalRole:"customer" } },
];

async function run() {
  console.log("Step 1: Adding missing columns...");
  var cols = [
    ["brands","JSONB DEFAULT '[]'::jsonb"],
    ["addresses","JSONB DEFAULT '[]'::jsonb"],
    ["contact_name","VARCHAR(128) DEFAULT ''"],
    ["contact_phone","VARCHAR(64) DEFAULT ''"],
    ["contact_email","VARCHAR(128) DEFAULT ''"],
    ["country","VARCHAR(64) DEFAULT ''"],
    ["currency","VARCHAR(8) DEFAULT 'USD'"],
    ["payment_term","VARCHAR(128) DEFAULT ''"],
    ["portal_role","VARCHAR(32) DEFAULT 'customer'"],
    ["group_id","VARCHAR(64) DEFAULT ''"],
    ["invoice","JSONB DEFAULT '{}'::jsonb"],
    ["is_active","BOOLEAN DEFAULT true"],
    ["name_en","VARCHAR(256) DEFAULT ''"],
    ["name_cn","VARCHAR(256) DEFAULT ''"],
  ];
  for (var c of cols) {
    try {
      await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS " + c[0] + " " + c[1]);
      console.log("  + " + c[0]);
    } catch(e) { console.log("  ~ " + c[0] + ": " + e.message); }
  }

  console.log("\nStep 2: Importing " + customers.length + " customers...");
  for (var cust of customers) {
    try {
      var r = await pool.query(`
        INSERT INTO customers (company_code, name_en, brands, country, currency, portal_role, raw)
        VALUES ($1, $2, $3, $4, $5, 'customer', $6)
        ON CONFLICT (company_code) DO UPDATE SET
          name_en = COALESCE(NULLIF($2,''), customers.name_en),
          brands = $3,
          country = COALESCE(NULLIF($4,''), customers.country),
          currency = COALESCE(NULLIF($5,''), customers.currency),
          raw = customers.raw || $6,
          updated_at = NOW()
        RETURNING company_code, name_en, brands
      `, [cust.company_code, cust.name_en, JSON.stringify(cust.brands), cust.country, cust.currency, JSON.stringify(cust.raw)]);
      console.log("  ✓ " + r.rows[0].company_code + " — " + r.rows[0].name_en + " — brands: " + JSON.stringify(r.rows[0].brands));
    } catch(e) { console.log("  ✗ " + cust.company_code + ": " + e.message); }
  }

  console.log("\nStep 3: Verifying...");
  var all = await pool.query("SELECT company_code, name_en, brands FROM customers ORDER BY company_code");
  console.log("Total customers: " + all.rowCount);
  for (var row of all.rows) {
    console.log("  " + row.company_code + " | " + row.name_en + " | brands: " + JSON.stringify(row.brands));
  }

  await pool.end();
  console.log("\nDone!");
}

run().catch(function(e) { console.error(e); pool.end(); });
