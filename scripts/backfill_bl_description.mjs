import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

// Backfill bl_description from declaration_name ONLY where declaration_name is a
// real per-SKU value (NOT the generic 宠物食品 / PET FOOD placeholder — copying
// those would re-introduce the previously-cleaned corruption).
const sql = `
  UPDATE products p
  SET bl_description = p.declaration_name, updated_at = NOW()
  WHERE p.active = true
    AND (p.bl_description IS NULL OR p.bl_description = '')
    AND p.declaration_name IS NOT NULL
    AND p.declaration_name <> ''
    AND p.declaration_name NOT IN ('PET FOOD', '宠物食品', 'PET FOOD/宠物食品')
  RETURNING sku, declaration_name
`;

const r = await pool.query(sql);
console.log("rows updated:", r.rowCount);
console.log("sample:", r.rows.slice(0, 10).map((x) => `${x.sku}=${x.declaration_name}`).join(" | "));

const left = await pool.query(
  `SELECT COUNT(*)::int AS c FROM products WHERE active=true AND (bl_description IS NULL OR bl_description='')`
);
console.log("still empty after:", left.rows[0].c);

await pool.end();
