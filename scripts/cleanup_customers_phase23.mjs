import pg from "pg";
const pool = new pg.Pool({
  host: process.env.PG_HOST, port: process.env.PG_PORT, user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE,
});

// Phase 2/3 of customers overhaul — SAFE, reversible (see migration 023 backup).
// 1. Deactivate placeholder/no-name junk rows (0 orders, name = code or null).
// 2. Fix country for the two Chilean importers mis-labelled 中国 (SPA = Chilean S.p.A.).

const junk = await pool.query(
  `UPDATE customers SET is_active=false, updated_at=NOW()
   WHERE company_code IN ('CN-00009','CN-00063','CN-00065')
   RETURNING company_code`
);
console.log("deactivated junk rows:", junk.rows.map(r=>r.company_code).join(", "));

const chile = await pool.query(
  `UPDATE customers SET country='CHILE', updated_at=NOW()
   WHERE company_code IN ('CN-00043','CN-00045')
   RETURNING company_code`
);
console.log("country→CHILE:", chile.rows.map(r=>r.company_code).join(", "));

await pool.end();
