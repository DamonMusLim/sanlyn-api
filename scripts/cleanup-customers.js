// Cleanup: remove inactive duplicate customers, keep only active ones with grade/brands
import pg from "pg";
var { Pool } = pg;
var pool = new Pool({
  host: "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432, database: "sanlyn_db",
  user: "sanlyn_admin", password: "SanlynRDS2026!",
  ssl: false, max: 2,
});
async function run() {
  // Delete inactive duplicates (where an active version with grade exists)
  var dupes = await pool.query(`
    DELETE FROM customers
    WHERE is_active = false
    AND (grade IS NULL OR grade = '')
    AND name_en IN (
      SELECT name_en FROM customers
      WHERE is_active != false AND grade IS NOT NULL AND grade != '' AND name_en IS NOT NULL AND name_en != ''
    )
    RETURNING id, name_en
  `);
  console.log("Deleted " + dupes.rows.length + " inactive duplicates:");
  dupes.rows.forEach(function(r) { console.log("  id=" + r.id + " " + r.name_en); });

  // Show remaining
  var all = await pool.query("SELECT id, name_en, name_cn, grade, is_active, brands FROM customers ORDER BY name_en, name_cn");
  console.log("\nRemaining " + all.rows.length + " customers:");
  all.rows.forEach(function(r) {
    var name = r.name_en || r.name_cn || "?";
    var b = Array.isArray(r.brands) ? r.brands.join(",") : (r.brands || "-");
    console.log("  id=" + r.id + " | " + name + " | grade=" + (r.grade || "-") + " | active=" + (r.is_active === false ? "NO" : "yes") + " | brands=" + b);
  });
  await pool.end();
}
run().catch(function(e) { console.error(e); process.exit(1); });
