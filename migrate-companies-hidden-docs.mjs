// one-shot migration: customer collaboration hidden document config on companies.
// Default is dry-run. Use --commit to alter/update/drop.
import fs from "node:fs";

const commit = process.argv.includes("--commit");

const alterSql = `ALTER TABLE companies ADD COLUMN IF NOT EXISTS collab_hidden_docs text[] NOT NULL DEFAULT '{}';`;
const seedSql = `UPDATE companies
   SET collab_hidden_docs = ARRAY['fe','quarantine']
 WHERE group_code = 'PETSOME';`;
const dropSql = `DROP TABLE IF EXISTS collab_doc_visibility;`;

function loadEnv(file) {
  const envTxt = fs.readFileSync(file, "utf8");
  for (const line of envTxt.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function printCompanies(label, rows) {
  console.log(label);
  console.log(`rows=${rows.length}`);
  for (const row of rows) {
    const name = row.name_cn || row.name_en || row.short_name || "";
    console.log(`- ${row.code}${name ? ` ${name}` : ""}`);
  }
}

loadEnv("/opt/sanlyn-api-test/.env");
const { getPool } = await import("./api/db/db.js");
const pool = getPool();

try {
  const target = await pool.query(
    `SELECT code, name_cn, name_en, short_name
       FROM companies
      WHERE group_code = 'PETSOME'
      ORDER BY code`
  );

  if (!commit) {
    console.log("[dry-run] would alter:");
    console.log(alterSql);
    printCompanies("[dry-run] would set collab_hidden_docs=[fe,quarantine] where group_code='PETSOME':", target.rows);
    console.log("[dry-run] would drop:");
    console.log(dropSql);
  } else {
    await pool.query("BEGIN");
    try {
      await pool.query(alterSql);
      const updateRes = await pool.query(seedSql);
      await pool.query(dropSql);
      const after = await pool.query(
        `SELECT code, name_cn, name_en, short_name, collab_hidden_docs
           FROM companies
          WHERE group_code = 'PETSOME'
          ORDER BY code`
      );
      await pool.query("COMMIT");
      console.log("[commit] companies.collab_hidden_docs ready");
      console.log(`updated_rows=${updateRes.rowCount}`);
      printCompanies("[commit] PETSOME companies:", after.rows);
      console.log("[commit] dropped collab_doc_visibility if it existed");
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  }
} catch (e) {
  console.error(commit ? "[commit] failed:" : "[dry-run] failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
