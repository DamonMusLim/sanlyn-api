// backfill-june-fer.js — 一次性回填 2026-06 九票报关单入 finance_export_rebates
// 数据源：海关电子口岸解密XML（20260703 下载，Damon 手动解密），货值已与报关单PDF核对一致。
// 幂等：customs_no 已存在则 skip，绝不 update。
//
// Usage:
//   node scripts/backfill-june-fer.js          # dry-run
//   node scripts/backfill-june-fer.js --apply  # insert missing rows
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const APPLY = process.argv.includes("--apply");
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const NOTE = "backfill 海关解密XML 20260703";
const SOURCE = "eport_xml_20260703";

const ROWS = [
  { customs_no: "422720260000660838", contract_no: "FS20260603088", export_date: "2026-06-08", fob_cny: "38710.00" },
  { customs_no: "422720260000660860", contract_no: "CP26031606-2 / FS20260603076", export_date: "2026-06-08", fob_cny: "212800.57" },
  { customs_no: "371120260000285458", contract_no: "FS20260609002", export_date: "2026-06-17", fob_cny: "292809.60" },
  { customs_no: "425820260000878686", contract_no: "FS20260603001 / FS20260611001 /", export_date: "2026-06-17", fob_cny: "325533.40" },
  { customs_no: "422720260000699787", contract_no: "FS20260522001", export_date: "2026-06-20", fob_cny: "91200.00" },
  { customs_no: "371120260000301690", contract_no: "FS20260622766", export_date: "2026-06-24", fob_cny: "71500.00" },
  { customs_no: "422720260000729893", contract_no: "FS20260522002", export_date: "2026-06-24", fob_cny: "96000.00" },
  { customs_no: "422720260000729898", contract_no: "FS20260609001", export_date: "2026-06-24", fob_cny: "309760.00" },
  { customs_no: "370520260000030559", contract_no: "详见备注", export_date: "2026-06-26", fob_cny: "71240.16" },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  let inserted = 0;
  let skipped = 0;

  console.log(APPLY ? "[APPLY] inserting missing FER rows" : "[DRY RUN] no writes");

  for (const row of ROWS) {
    const exists = await pool.query(
      "SELECT 1 FROM finance_export_rebates WHERE customs_no=$1 LIMIT 1",
      [row.customs_no]
    );

    if (exists.rows.length) {
      skipped++;
      console.log(`skip existing ${row.customs_no}`);
      continue;
    }

    const raw = { source: SOURCE, ht_no_raw: row.contract_no };

    if (!APPLY) {
      console.log("would insert", { ...row, raw });
      inserted++;
      continue;
    }

    await pool.query(
      `INSERT INTO finance_export_rebates
         (customs_no, contract_no, export_date,
          fob_foreign, exchange_rate, fob_cny, rebate_rate, rebate_expected,
          currency, status, rebate_lifecycle_status, note, raw)
       VALUES
         ($1, $2, $3::date,
          NULL, NULL, $4::numeric, 0, 0,
          'CNY', 'pending', '未退税', $5, $6::jsonb)`,
      [row.customs_no, row.contract_no, row.export_date, row.fob_cny, NOTE, JSON.stringify(raw)]
    );
    inserted++;
    console.log(`inserted ${row.customs_no}`);
  }

  console.log(`inserted ${inserted} / skipped ${skipped}`);
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
