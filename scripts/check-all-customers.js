import "dotenv/config";
import pg from "pg";
var { Pool } = pg;
var pool = new Pool({
  host: process.env.PG_HOST || "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432, database: process.env.PG_DB || "sanlyn_db",
  user: process.env.PG_USER || "sanlyn_admin", password: process.env.PG_PASSWORD,
  ssl: false, max: 2,
});
async function run() {
  var r = await pool.query("SELECT id, company_code, name_en, name_cn, portal_role, grade, brands, is_active, country, country_en FROM customers ORDER BY name_en, name_cn");
  console.log("ALL " + r.rows.length + " customers:\n");
  r.rows.forEach(function(row) {
    var name = row.name_en || row.name_cn || row.company_code || "?";
    var brands = Array.isArray(row.brands) ? row.brands.join(",") : (row.brands || "-");
    console.log("  id=" + row.id + " | " + name + " | role=" + (row.portal_role || "NULL") + " | grade=" + (row.grade || "-") + " | active=" + (row.is_active === false ? "NO" : "yes") + " | brands=" + brands + " | " + (row.country_en || row.country || "-"));
  });

  // Check duplicates
  var dupes = await pool.query("SELECT name_en, count(*) as c FROM customers WHERE name_en IS NOT NULL AND name_en != '' GROUP BY name_en HAVING count(*) > 1 ORDER BY c DESC");
  if (dupes.rows.length) {
    console.log("\nDUPLICATES:");
    dupes.rows.forEach(function(d) { console.log("  " + d.name_en + " x" + d.c); });
  }

  await pool.end();
}
run().catch(function(e) { console.error(e); process.exit(1); });
