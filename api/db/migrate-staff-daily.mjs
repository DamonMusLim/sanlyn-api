// one-shot migration — 建 staff_daily_reports 表（店员日报/日记）。自加载 .env（含特殊字符安全）。
import fs from "node:fs";
const envTxt = fs.readFileSync("/opt/sanlyn-api-test/.env", "utf8");
for (const line of envTxt.split("\n")) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && !line.trim().startsWith("#")) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
const { getPool } = await import("./db.js");
const pool = getPool();
await pool.query(`
  CREATE TABLE IF NOT EXISTS staff_daily_reports (
    id          BIGSERIAL PRIMARY KEY,
    report_date DATE        NOT NULL DEFAULT CURRENT_DATE,
    staff_name  TEXT        NOT NULL,
    store_name  TEXT,
    product     TEXT,
    work_report TEXT,
    diary       TEXT,
    checkin_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_sdr_date  ON staff_daily_reports(report_date DESC);
  CREATE INDEX IF NOT EXISTS idx_sdr_staff ON staff_daily_reports(staff_name);
`);
const c = await pool.query("SELECT count(*) FROM staff_daily_reports");
console.log("✅ staff_daily_reports ready, rows=" + c.rows[0].count);
process.exit(0);
