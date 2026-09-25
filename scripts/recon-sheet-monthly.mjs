#!/usr/bin/env node
import { request } from "node:http";
import { request as requestHttps } from "node:https";

const TEMPLATES = ["ar_customer", "ap_forwarder"];
const API_BASE = String(process.env.SANLYN_API_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const CRON_SECRET = String(process.env.CRON_SECRET || "");
const DRY_RUN = process.argv.includes("--dry-run");

function shanghaiYearMonth(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

function previousMonth(ym) {
  let year = Number(ym.slice(0, 4));
  let month = Number(ym.slice(5, 7)) - 1;
  if (month < 1) {
    year -= 1;
    month = 12;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function parsePeriod(value) {
  const period = String(value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("RECON_PERIOD must be YYYY-MM");
  const month = Number(period.slice(5, 7));
  if (month < 1 || month > 12) throw new Error("RECON_PERIOD month must be 01-12");
  return period;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? requestHttps : request;
    const req = client({
      method: "POST",
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        "x-cron-secret": CRON_SECRET,
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch (err) { return reject(new Error(`Invalid JSON response: ${raw.slice(0, 200)}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300 || json.success === false) {
          return reject(new Error(`${res.statusCode} ${json.error || json.message || raw}`));
        }
        resolve(json);
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const period = parsePeriod(process.env.RECON_PERIOD || previousMonth(shanghaiYearMonth(new Date())));
  const endpoint = `${API_BASE}/api/db/recon-persist?action=generate`;
  const jobs = TEMPLATES.map((template_key) => ({ template_key, period }));

  if (DRY_RUN) {
    console.log(JSON.stringify({ dry_run: true, endpoint, jobs }, null, 2));
    return;
  }
  if (!CRON_SECRET) throw new Error("CRON_SECRET is required");

  for (const job of jobs) {
    const result = await postJson(endpoint, job);
    console.log(JSON.stringify({ template_key: job.template_key, period, result }));
  }
}

main().catch((err) => {
  console.error(`[recon-sheet-monthly] ${err.message}`);
  process.exit(1);
});
