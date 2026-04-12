import pg from "pg";
var { Pool } = pg;
var pool = new Pool({
  host: "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432, database: "sanlyn_db",
  user: "sanlyn_admin", password: "SanlynRDS2026!",
  ssl: false, max: 2,
});
async function run() {
  // Check portal_role distribution
  var r = await pool.query("SELECT portal_role, count(*) FROM customers GROUP BY portal_role ORDER BY count DESC");
  console.log("Portal roles:");
  r.rows.forEach(function(row) { console.log("  " + (row.portal_role || "NULL") + ": " + row.count); });

  // Check what non-customer entries look like
  var nc = await pool.query("SELECT id, company_code, name_en, name_cn, portal_role, grade FROM customers WHERE portal_role IS NOT NULL AND portal_role != 'customer' LIMIT 10");
  console.log("\nNon-customer entries:");
  nc.rows.forEach(function(row) { console.log("  " + (row.name_en || row.name_cn || row.company_code) + " | role=" + row.portal_role + " | grade=" + (row.grade || "-")); });

  // Check actual customers
  var c = await pool.query("SELECT id, company_code, name_en, name_cn, portal_role, grade FROM customers WHERE portal_role = 'customer' OR grade IS NOT NULL AND grade != '' ORDER BY name_en LIMIT 20");
  console.log("\nCustomers:");
  c.rows.forEach(function(row) { console.log("  " + (row.name_en || row.name_cn || row.company_code) + " | role=" + (row.portal_role || "-") + " | grade=" + (row.grade || "-")); });

  console.log("\nTotal rows:", (await pool.query("SELECT count(*) FROM customers")).rows[0].count);
  await pool.end();
}
run().catch(function(e) { console.error(e); process.exit(1); });
