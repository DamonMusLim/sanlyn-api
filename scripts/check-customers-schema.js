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
  var r = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'customers' ORDER BY ordinal_position");
  console.log("customers table columns:");
  r.rows.forEach(function(c) { console.log("  " + c.column_name + " (" + c.data_type + ")"); });

  // Also check a sample row
  var s = await pool.query("SELECT * FROM customers LIMIT 1");
  if (s.rows[0]) {
    console.log("\nSample row keys:", Object.keys(s.rows[0]));
    console.log("Sample:", JSON.stringify(s.rows[0]).slice(0, 500));
  }

  var cnt = await pool.query("SELECT count(*) FROM customers");
  console.log("\nTotal rows:", cnt.rows[0].count);
  await pool.end();
}
run().catch(function(e) { console.error(e); process.exit(1); });
