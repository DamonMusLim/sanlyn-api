import pg from "pg";
const pool = new pg.Pool({
  host: process.env.PG_HOST, port: process.env.PG_PORT, user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE,
});

// Phase 4 of customers overhaul — SAFE, reversible (see migration 024 backup).
// 1. Deactivate CN-00011 (Giant Mei empty dup — CN-00044 has full Taiwan address, already inactive).
// 2. Deactivate CN-00005 (Xuancheng Fuxin as customer — dup of CN-00058 factory row).
// 3. Deactivate CN-00031 AL BASHEK COMPANY (0 orders, 0 brands, 0 contact info).
// 4. Deactivate CN-00041 BIRDS PALACE (0 orders, 0 brands, 0 contact info).
// 5. Deactivate null-code JIANGSU CHONGYIN row (no company_code, no orders, no data).
// 6. Update CN-00004 FORTUNESANLYN role_type customer → trader (buy+sell, Middle East focus).

const deactivate = await pool.query(
  `UPDATE customers SET is_active=false, updated_at=NOW()
   WHERE (company_code IN ('CN-00011','CN-00005','CN-00031','CN-00041')
          OR (company_code IS NULL AND name_en ILIKE '%CHONGYIN%'))
     AND is_active = true
   RETURNING company_code, name_en`
);
console.log("deactivated:", deactivate.rows.map(r=>`${r.company_code||'(null)'} ${r.name_en}`).join(" | "));

const trader = await pool.query(
  `UPDATE customers SET role_type='trader', updated_at=NOW()
   WHERE company_code = 'CN-00004'
   RETURNING company_code, name_en, role_type`
);
console.log("role→trader:", trader.rows.map(r=>`${r.company_code} ${r.name_en}`).join(", "));

await pool.end();
