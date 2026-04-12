import { getPool, setCors } from "../db.js";

// Each ALTER run separately to avoid DO-block issues with pg driver
var ALTER_COLS = [
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_price     NUMERIC(12,2) DEFAULT NULL",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS sanlyn_price      NUMERIC(12,2) DEFAULT NULL",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd         NUMERIC(12,2) DEFAULT NULL",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_rate          NUMERIC(5,4)  DEFAULT 0",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS rebate_rate       NUMERIC(5,4)  DEFAULT 0",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS profit            NUMERIC(12,4) DEFAULT NULL",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS cat1              VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS cat2              VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS cat3              VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS cat1_cn           VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS cat2_cn           VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS cat3_cn           VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS trade_terms       VARCHAR(16)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS declaration_name  VARCHAR(512)  DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS declaration_elements TEXT       DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS bl_description    VARCHAR(512)  DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_name      VARCHAR(256)  DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS declaration_amount NUMERIC(12,2) DEFAULT NULL",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS bg_bx             NUMERIC(8,2)  DEFAULT NULL",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS flavor            VARCHAR(128)  DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS moq               VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS jdy_id            VARCHAR(64)   DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS spec              VARCHAR(256)  DEFAULT ''",
  "ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url         VARCHAR(512)  DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_prod_cat1 ON products(cat1)",
  "CREATE INDEX IF NOT EXISTS idx_prod_cat2 ON products(cat2)",
  "CREATE INDEX IF NOT EXISTS idx_prod_hs ON products(hs_code)",
];

var INIT_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id              SERIAL PRIMARY KEY,
  sku             VARCHAR(64) UNIQUE,
  product_name    VARCHAR(512) DEFAULT '',
  product_name_cn VARCHAR(512) DEFAULT '',
  brand           VARCHAR(128) DEFAULT '',
  size            VARCHAR(128) DEFAULT '',
  unit            VARCHAR(16)  DEFAULT 'CTN',
  price           NUMERIC(12,2) DEFAULT 0,
  cbm             NUMERIC(12,6) DEFAULT 0,
  net_weight      NUMERIC(12,2) DEFAULT 0,
  gross_weight    NUMERIC(12,2) DEFAULT 0,
  barcode         VARCHAR(64)  DEFAULT '',
  category        VARCHAR(64)  DEFAULT '',
  hs_code         VARCHAR(32)  DEFAULT '',
  active          BOOLEAN DEFAULT true,
  raw             JSONB DEFAULT '{}'::jsonb,
  factory_price     NUMERIC(12,2) DEFAULT NULL,
  sanlyn_price      NUMERIC(12,2) DEFAULT NULL,
  price_usd         NUMERIC(12,2) DEFAULT NULL,
  tax_rate          NUMERIC(5,4)  DEFAULT 0,
  rebate_rate       NUMERIC(5,4)  DEFAULT 0,
  profit            NUMERIC(12,4) DEFAULT NULL,
  cat1              VARCHAR(64)   DEFAULT '',
  cat2              VARCHAR(64)   DEFAULT '',
  cat3              VARCHAR(64)   DEFAULT '',
  cat1_cn           VARCHAR(64)   DEFAULT '',
  cat2_cn           VARCHAR(64)   DEFAULT '',
  cat3_cn           VARCHAR(64)   DEFAULT '',
  trade_terms       VARCHAR(16)   DEFAULT '',
  declaration_name  VARCHAR(512)  DEFAULT '',
  declaration_elements TEXT       DEFAULT '',
  bl_description    VARCHAR(512)  DEFAULT '',
  factory_name      VARCHAR(256)  DEFAULT '',
  declaration_amount NUMERIC(12,2) DEFAULT NULL,
  bg_bx             NUMERIC(8,2)  DEFAULT NULL,
  flavor            VARCHAR(128)  DEFAULT '',
  moq               VARCHAR(64)   DEFAULT '',
  jdy_id            VARCHAR(64)   DEFAULT '',
  spec              VARCHAR(256)  DEFAULT '',
  image_url         VARCHAR(512)  DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prod_sku   ON products(sku);
CREATE INDEX IF NOT EXISTS idx_prod_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_prod_cat1  ON products(cat1);
CREATE INDEX IF NOT EXISTS idx_prod_cat2  ON products(cat2);
CREATE INDEX IF NOT EXISTS idx_prod_hs    ON products(hs_code);
`;

// POST body = JSON array of cleaned products from the Excel import
export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var log = [];

    // Step 1: Ensure table + new columns
    log.push("=== Step 1: Ensure products table + new columns ===");
    await pool.query(INIT_SQL);
    for (var altSql of ALTER_COLS) {
      try { await pool.query(altSql); } catch(e) { /* column may already exist */ }
    }
    log.push("Table + columns + indexes OK");

    // Step 2: Get product data
    var products;
    if (req.method === "POST" && req.body && Array.isArray(req.body)) {
      products = req.body;
      log.push("Received " + products.length + " products from POST body");
    } else if (req.method === "GET" && req.query.source === "oss") {
      log.push("Fetching from OSS...");
      var r = await fetch("https://files.sanlynos.com/data/products.json");
      var ossData = await r.json();
      if (!Array.isArray(ossData)) throw new Error("products.json is not an array");
      // Map old OSS format to new format
      products = ossData.map(function(p) {
        return {
          sku: p.code || "",
          product_name: p.name || "",
          product_name_cn: p.nameCN || "",
          brand: p.brand || "",
          size: p.size || "",
          unit: p.unit || "CTN",
          sanlyn_price: p.price || 0,
          cbm: p.cbm || 0,
          net_weight: p.netWeight || 0,
          gross_weight: p.grossWeight || 0,
          barcode: p.barcode || "",
          hs_code: (p.raw && p.raw.hsCode) || "",
        };
      });
      log.push("Mapped " + products.length + " products from OSS");
    } else {
      // GET without source: just run ALTER to add columns + return current stats
      var count = await pool.query("SELECT COUNT(*) as total FROM products WHERE active = true");
      var sample = await pool.query("SELECT sku, product_name, brand, factory_price, sanlyn_price, tax_rate, rebate_rate, cat1, cat2, cat3 FROM products WHERE active = true LIMIT 5");
      log.push("Schema updated. Total active: " + count.rows[0].total);
      return res.status(200).json({ success: true, action: "schema_update", total: parseInt(count.rows[0].total), sample: sample.rows, log: log });
    }

    // Step 3: Upsert all products
    log.push("=== Step 3: Upserting " + products.length + " products ===");
    var ok = 0, errors = [];
    for (var p of products) {
      try {
        var sku = (p.sku || "").trim();
        if (!sku) continue;
        await pool.query(`
          INSERT INTO products (
            sku, product_name, product_name_cn, brand, size, unit, price, cbm,
            net_weight, gross_weight, barcode, hs_code, active,
            factory_price, sanlyn_price, price_usd, tax_rate, rebate_rate, profit,
            cat1, cat2, cat3, cat1_cn, cat2_cn, cat3_cn,
            trade_terms, declaration_name, declaration_elements, bl_description,
            factory_name, declaration_amount, bg_bx, flavor, moq, jdy_id, raw
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
            $14,$15,$16,$17,$18,$19,
            $20,$21,$22,$23,$24,$25,
            $26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
          )
          ON CONFLICT (sku) DO UPDATE SET
            product_name    = COALESCE(NULLIF(EXCLUDED.product_name,''),    products.product_name),
            product_name_cn = COALESCE(NULLIF(EXCLUDED.product_name_cn,''), products.product_name_cn),
            brand           = COALESCE(NULLIF(EXCLUDED.brand,''),           products.brand),
            size            = COALESCE(NULLIF(EXCLUDED.size,''),            products.size),
            unit            = COALESCE(NULLIF(EXCLUDED.unit,''),            products.unit),
            price           = CASE WHEN EXCLUDED.price > 0 THEN EXCLUDED.price ELSE products.price END,
            cbm             = CASE WHEN EXCLUDED.cbm > 0 THEN EXCLUDED.cbm ELSE products.cbm END,
            net_weight      = CASE WHEN EXCLUDED.net_weight > 0 THEN EXCLUDED.net_weight ELSE products.net_weight END,
            gross_weight    = CASE WHEN EXCLUDED.gross_weight > 0 THEN EXCLUDED.gross_weight ELSE products.gross_weight END,
            barcode         = COALESCE(NULLIF(EXCLUDED.barcode,''),         products.barcode),
            hs_code         = COALESCE(NULLIF(EXCLUDED.hs_code,''),        products.hs_code),
            factory_price   = COALESCE(EXCLUDED.factory_price,             products.factory_price),
            sanlyn_price    = COALESCE(EXCLUDED.sanlyn_price,              products.sanlyn_price),
            price_usd       = COALESCE(EXCLUDED.price_usd,                products.price_usd),
            tax_rate        = CASE WHEN EXCLUDED.tax_rate > 0 THEN EXCLUDED.tax_rate ELSE products.tax_rate END,
            rebate_rate     = CASE WHEN EXCLUDED.rebate_rate > 0 THEN EXCLUDED.rebate_rate ELSE products.rebate_rate END,
            profit          = COALESCE(EXCLUDED.profit,                    products.profit),
            cat1            = COALESCE(NULLIF(EXCLUDED.cat1,''),           products.cat1),
            cat2            = COALESCE(NULLIF(EXCLUDED.cat2,''),           products.cat2),
            cat3            = COALESCE(NULLIF(EXCLUDED.cat3,''),           products.cat3),
            cat1_cn         = COALESCE(NULLIF(EXCLUDED.cat1_cn,''),        products.cat1_cn),
            cat2_cn         = COALESCE(NULLIF(EXCLUDED.cat2_cn,''),        products.cat2_cn),
            cat3_cn         = COALESCE(NULLIF(EXCLUDED.cat3_cn,''),        products.cat3_cn),
            trade_terms     = COALESCE(NULLIF(EXCLUDED.trade_terms,''),    products.trade_terms),
            declaration_name = COALESCE(NULLIF(EXCLUDED.declaration_name,''), products.declaration_name),
            declaration_elements = COALESCE(NULLIF(EXCLUDED.declaration_elements,''), products.declaration_elements),
            bl_description  = COALESCE(NULLIF(EXCLUDED.bl_description,''), products.bl_description),
            factory_name    = COALESCE(NULLIF(EXCLUDED.factory_name,''),   products.factory_name),
            declaration_amount = COALESCE(EXCLUDED.declaration_amount,     products.declaration_amount),
            bg_bx           = COALESCE(EXCLUDED.bg_bx,                    products.bg_bx),
            flavor          = COALESCE(NULLIF(EXCLUDED.flavor,''),         products.flavor),
            moq             = COALESCE(NULLIF(EXCLUDED.moq,''),            products.moq),
            jdy_id          = COALESCE(NULLIF(EXCLUDED.jdy_id,''),         products.jdy_id),
            active          = true,
            updated_at      = NOW()
        `, [
          sku,
          p.product_name || "",
          p.product_name_cn || "",
          p.brand || "",
          p.size || "",
          p.unit || "CTN",
          p.sanlyn_price || p.price || 0,
          p.cbm || 0,
          p.net_weight || 0,
          p.gross_weight || 0,
          p.barcode || "",
          p.hs_code || "",
          true,
          p.factory_price || null,
          p.sanlyn_price || null,
          p.price_usd || null,
          p.tax_rate || 0,
          p.rebate_rate || 0,
          p.profit || null,
          p.cat1 || "",
          p.cat2 || "",
          p.cat3 || "",
          p.cat1_cn || "",
          p.cat2_cn || "",
          p.cat3_cn || "",
          p.trade_terms || "",
          p.declaration_name || "",
          p.declaration_elements || "",
          p.bl_description || "",
          p.factory_name || "",
          p.declaration_amount || null,
          p.bg_bx || null,
          p.flavor || "",
          p.moq || "",
          p.jdy_id || "",
          JSON.stringify(p.raw || {}),
        ]);
        ok++;
      } catch (e) {
        errors.push({ sku: (p.sku || "?"), error: e.message });
      }
    }
    log.push("Upserted: " + ok + ", Errors: " + errors.length);
    if (errors.length > 0) log.push("First 5 errors: " + JSON.stringify(errors.slice(0, 5)));

    // Step 4: Verify
    log.push("=== Step 4: Verification ===");
    var count = await pool.query("SELECT COUNT(*) as total FROM products WHERE active = true");
    log.push("Total active products: " + count.rows[0].total);

    var withFP = await pool.query("SELECT COUNT(*) as c FROM products WHERE factory_price IS NOT NULL AND factory_price > 0");
    log.push("With factory_price: " + withFP.rows[0].c);

    var withTax = await pool.query("SELECT COUNT(*) as c FROM products WHERE tax_rate > 0");
    log.push("With tax_rate > 0: " + withTax.rows[0].c);

    var cats = await pool.query("SELECT cat1, COUNT(*) as cnt FROM products WHERE active = true AND cat1 != '' GROUP BY cat1 ORDER BY cnt DESC");
    for (var c of cats.rows) {
      log.push("  " + c.cat1 + ": " + c.cnt);
    }

    return res.status(200).json({ success: true, imported: ok, errors: errors.length, log: log });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
