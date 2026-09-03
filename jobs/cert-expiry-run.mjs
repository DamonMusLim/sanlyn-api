// Local cron runner for cert expiry checks. Bypasses HTTP auth and uses the shared DB logic.
import { readFileSync } from "fs";
import pg from "pg";
import { runCertExpiryCheck } from "../api/db/cert-expiry-check.js";

function loadEnv() {
  try {
    const env = readFileSync("/opt/sanlyn-api-test/.env", "utf-8");
    for (const line of env.split("\n")) {
      const [k, ...vs] = line.split("=");
      if (k && !k.startsWith("#")) process.env[k.trim()] = vs.join("=").trim();
    }
  } catch (e) {
    console.error("[cert-expiry-run] env load failed:", e.message);
    process.exitCode = 1;
    throw e;
  }
}

function fmtDate(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function label(item) {
  const company = item.company_name || item.company_code || "";
  const product = item.product_label || item.product_key || item.cert_name_cn || "";
  const days = Number(item.days_left);
  const dayText = Number.isFinite(days) ? String(days) : "";
  return [
    company,
    product,
    fmtDate(item.expire_date),
    dayText,
    item.task_id || "",
    item.action || "",
  ].join(" | ");
}

async function main() {
  const write = process.argv.includes("--write");
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing in /opt/sanlyn-api-test/.env");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runCertExpiryCheck(pool, { write });
    console.log(`mode=${result.mode} total=${result.total} created=${result.created} skipped=${result.skipped}`);
    if (!result.items.length) {
      console.log("all_clear: no expiring certificates");
      return;
    }
    console.log("公司 | 品名/证书 | 到期 | 剩余天数 | 卡号 | 动作");
    for (const item of result.items) console.log(label(item));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[cert-expiry-run]", e);
  process.exitCode = 1;
});
