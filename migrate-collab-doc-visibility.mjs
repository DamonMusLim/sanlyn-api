// one-shot migration: customer collaboration document visibility config.
// Default is dry-run. Use --commit to create/update the table and PETSOME seed.
import fs from "node:fs";

const commit = process.argv.includes("--commit");

const createSql = `
CREATE TABLE IF NOT EXISTS collab_doc_visibility (
  id serial PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('company','group')),
  scope_key  text NOT NULL,
  hidden_doc_types text[] NOT NULL DEFAULT '{}',
  note text,
  updated_by text,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(scope_type, scope_key)
);`;

const seedSql = `
INSERT INTO collab_doc_visibility
  (scope_type, scope_key, hidden_doc_types, note, updated_by, updated_at)
VALUES
  ('group', 'PETSOME', ARRAY['fe','quarantine'], 'Damon 0817 这些客户不用', 'claude', now())
ON CONFLICT (scope_type, scope_key) DO UPDATE
  SET hidden_doc_types = EXCLUDED.hidden_doc_types,
      note = EXCLUDED.note,
      updated_by = EXCLUDED.updated_by,
      updated_at = now();`;

if (!commit) {
  console.log("[dry-run] would create table:");
  console.log(createSql.trim());
  console.log("[dry-run] would seed:");
  console.log("scope_type=group scope_key=PETSOME hidden_doc_types=[fe,quarantine] note=Damon 0817 这些客户不用 updated_by=claude");
  process.exit(0);
}

const envTxt = fs.readFileSync("/opt/sanlyn-api-test/.env", "utf8");
for (const line of envTxt.split("\n")) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && !line.trim().startsWith("#")) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

const { getPool } = await import("./api/db/db.js");
const pool = getPool();

await pool.query("BEGIN");
try {
  await pool.query(createSql);
  await pool.query(seedSql);
  const { rows } = await pool.query(
    `SELECT scope_type, scope_key, hidden_doc_types, note, updated_by
       FROM collab_doc_visibility
      WHERE scope_type = 'group' AND scope_key = 'PETSOME'`
  );
  await pool.query("COMMIT");
  console.log("[commit] collab_doc_visibility ready");
  console.log(JSON.stringify(rows[0] || null, null, 2));
} catch (e) {
  await pool.query("ROLLBACK");
  console.error("[commit] failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
