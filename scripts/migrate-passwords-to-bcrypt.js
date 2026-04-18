// scripts/migrate-passwords-to-bcrypt.js
// Migrates all plaintext passwords in accounts table to bcrypt hashes.
// Run: node scripts/migrate-passwords-to-bcrypt.js
// Dry-run (no DB writes): DRY_RUN=1 node scripts/migrate-passwords-to-bcrypt.js
import "dotenv/config";
import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;
const DRY_RUN = process.env.DRY_RUN === "1";

const pool = new Pool({
  host: process.env.PG_HOST || "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432,
  database: process.env.PG_DB || "sanlyn_db",
  user: process.env.PG_USER || "sanlyn_admin",
  password: process.env.PG_PASSWORD,
  ssl: false,
});

async function run() {
  if (DRY_RUN) console.log("[DRY RUN] No changes will be written to DB.\n");

  const { rows } = await pool.query(
    "SELECT id, username, password FROM accounts ORDER BY id"
  );

  console.log(`Found ${rows.length} accounts.\n`);

  let upgraded = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const { id, username, password } = row;

    if (!password) {
      console.log(`  [SKIP] id=${id} username=${username} — null/empty password`);
      skipped++;
      continue;
    }

    if (password.startsWith("$2b$") || password.startsWith("$2a$")) {
      console.log(`  [SKIP] id=${id} username=${username} — already hashed`);
      skipped++;
      continue;
    }

    try {
      const hash = await bcrypt.hash(password, 12);
      if (DRY_RUN) {
        console.log(`  [DRY]  id=${id} username=${username} — would hash "${password}" → ${hash.slice(0, 20)}...`);
      } else {
        await pool.query("UPDATE accounts SET password = $1 WHERE id = $2", [hash, id]);
        console.log(`  [DONE] id=${id} username=${username} — hashed`);
      }
      upgraded++;
    } catch (err) {
      console.error(`  [FAIL] id=${id} username=${username} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nSummary: ${upgraded} upgraded, ${skipped} skipped, ${failed} failed.`);
  await pool.end();
}

run().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
