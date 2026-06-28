// scripts/apply-migrations.js — 按文件名顺序跑 migrations/M*.sql 里未应用的。
// 用法: 在 repo 根目录 `node scripts/apply-migrations.js`  (读 .env 取 DB 连接)
// 规则: 幂等记录到 schema_migrations;checksum 不一致直接报错(防偷改已跑的);已跑跳过。
// 只扫 migrations/M*.sql;数据修正(migrations/data/D*.sql)不在此跑(一次性,勿重跑)。
import "dotenv/config";
import { readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getPool } from "../api/db/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "migrations");
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function main() {
  const pool = getPool();
  const c = await pool.connect();
  try {
    // 确保跟踪表(等价 M000,自举)
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text NOT NULL DEFAULT current_user)`);

    const files = readdirSync(MIG_DIR).filter(f => /^M\d.*\.sql$/.test(f)).sort();
    const applied = new Map((await c.query("SELECT filename,checksum FROM schema_migrations")).rows.map(r => [r.filename, r.checksum]));

    let ran = 0, skipped = 0;
    for (const f of files) {
      const sql = readFileSync(join(MIG_DIR, f), "utf8");
      const sum = sha(sql);
      if (applied.has(f)) {
        if (applied.get(f) !== sum) {
          throw new Error(`❌ ${f} 已应用但内容被改(checksum不一致)。已跑的 migration 不可改,请新建 MXXX。`);
        }
        skipped++; continue;
      }
      console.log(`▶ 应用 ${f} ...`);
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)", [f, sum]);
        await c.query("COMMIT");
        console.log(`  ✅ ${f} 完成`);
        ran++;
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`❌ ${f} 失败已回滚: ${e.message}`);
      }
    }
    console.log(`\n完成: 新跑 ${ran}, 跳过(已应用) ${skipped}, 共 ${files.length}`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
