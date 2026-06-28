import "dotenv/config";
import { getPool } from "../api/db.js";
const pool = getPool();
const updates = [
  [3, "禁止自动调账：核对FI应收金额与水单分配，确认差额原因（疑似电放费/文件费漏记cost_lines）后人工处理。"],
  [2, "海运计划缺卖价USD或柜数，补全后重跑backfill。"],
  [1, "海运计划缺卖价USD或柜数，补全后重跑backfill。"],
];
for (const [id, cn] of updates) {
  const old = await pool.query("SELECT suggestion FROM finance_recon_exceptions WHERE id=$1", [id]);
  await pool.query("UPDATE finance_recon_exceptions SET suggestion=$1 WHERE id=$2", [cn, id]);
  await pool.query(
    "INSERT INTO finance_audit_log (table_name,row_id,field,old_value,new_value,actor,source,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["finance_recon_exceptions", String(id), "suggestion", old.rows[0]?.suggestion || null, cn, "claude-monitor", "i18n-cn", "财务页中文化(Damon指示)"]);
  console.log("id", id, "OK");
}
await pool.end();
