import { getPool, setCors } from "../db.js";

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
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prod_sku   ON products(sku);
CREATE INDEX IF NOT EXISTS idx_prod_brand ON products(brand);
`;

// Hardcoded product data from JDY Excel export (815 products)
// This endpoint fetches from the static JSON file we generated
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var log = [];

    // Step 1: Create table
    log.push("=== Step 1: Ensure products table ===");
    await pool.query(INIT_SQL);
    log.push("Table + indexes OK");

    // Step 2: Fetch product data from OSS
    log.push("=== Step 2: Fetching products.json ===");
    var r = await fetch("https://files.sanlynos.com/data/products.json");
    var products = await r.json();
    if (!Array.isArray(products)) throw new Error("products.json is not an array");
    log.push("Fetched " + products.length + " products");

    // Step 3: Upsert all products
    log.push("=== Step 3: Upserting products ===");
    var ok = 0, errors = [];
    for (var p of products) {
      try {
        await pool.query(`
          INSERT INTO products (sku, product_name, product_name_cn, brand, size, unit, price, cbm, net_weight, gross_weight, barcode, hs_code, active, raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
            raw             = products.raw || EXCLUDED.raw,
            active          = EXCLUDED.active,
            updated_at      = NOW()
        `, [
          p.code || "",
          p.name || "",
          p.nameCN || "",
          p.brand || "",
          p.size || "",
          p.unit || "CTN",
          p.price || 0,
          p.cbm || 0,
          p.netWeight || 0,
          p.grossWeight || 0,
          p.barcode || "",
          (p.raw && p.raw.hsCode) || "",
          p.active !== false,
          JSON.stringify(p.raw || {}),
        ]);
        ok++;
      } catch (e) {
        errors.push({ code: p.code, error: e.message });
      }
    }
    log.push("Upserted: " + ok + ", Errors: " + errors.length);
    if (errors.length > 0) log.push("First 5 errors: " + JSON.stringify(errors.slice(0, 5)));

    // Step 4: Verify
    log.push("=== Step 4: Verification ===");
    var count = await pool.query("SELECT COUNT(*) as total FROM products WHERE active = true");
    log.push("Total active products: " + count.rows[0].total);

    var brands = await pool.query("SELECT brand, COUNT(*) as cnt FROM products WHERE active = true GROUP BY brand ORDER BY cnt DESC LIMIT 10");
    for (var b of brands.rows) {
      log.push("  " + (b.brand || "(no brand)") + ": " + b.cnt);
    }

    return res.status(200).json({ success: true, imported: ok, errors: errors.length, log: log });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
