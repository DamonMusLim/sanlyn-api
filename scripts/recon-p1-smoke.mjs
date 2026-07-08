import "dotenv/config";

const token = process.env.SMOKE_TOKEN;
const port = process.env.PORT || "3000";
const base = process.env.SMOKE_BASE_URL || `http://localhost:${port}/api/db/recon-persist`;
const period = process.env.SMOKE_PERIOD || new Date().toISOString().slice(0, 7);

if (!token) {
  console.error("FAIL SMOKE_TOKEN is required");
  process.exit(1);
}

async function call(action, { method = "GET", body, query = {} } = {}) {
  const url = new URL(base);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.success === false) throw new Error(`${action} HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function pass(label, detail = "") {
  console.log(`PASS ${label}${detail ? " - " + detail : ""}`);
}

function fail(label, err) {
  console.error(`FAIL ${label} - ${err.message}`);
  process.exitCode = 1;
}

async function step(label, fn) {
  try {
    const out = await fn();
    pass(label, out);
    return out;
  } catch (err) {
    fail(label, err);
    throw err;
  }
}

let beforeLineCount = 0;
let sheetId = null;
let lineId = null;
let confirmedStatus = null;

await step("generate ar_customer dry_run", async () => {
  const r = await call("generate", { method: "POST", body: { template_key: "ar_customer", period, dry_run: true } });
  return `sample_rows=${r.sample_rows?.length || 0}`;
});

await step("generate ar_customer write", async () => {
  const r = await call("generate", { method: "POST", body: { template_key: "ar_customer", period } });
  return `sheets=${r.sheets} lines=${r.lineCount}`;
});

await step("query sheets and lines", async () => {
  const sheets = await call("sheets", { query: { template_key: "ar_customer", period } });
  if (!sheets.rows?.length) throw new Error("no sheets generated");
  sheetId = sheets.rows[0].id;
  const sheet = await call("sheet", { query: { id: sheetId } });
  if (!sheet.lines?.length) throw new Error("no lines generated");
  beforeLineCount = sheet.lines.length;
  lineId = sheet.lines[0].id;
  return `sheets=${sheets.rows.length} lines=${beforeLineCount}`;
});

await step("confirm one line", async () => {
  const r = await call("confirm", { method: "POST", body: { id: lineId, note: "recon-p1-smoke" } });
  if (!r.line?.expected_confirmed_at) throw new Error("line not confirmed");
  confirmedStatus = r.line.status;
  return `line=${lineId} status=${confirmedStatus}`;
});

await step("settle-suggest readonly", async () => {
  const r = await call("settle-suggest", { method: "POST", body: { id: lineId } });
  return `candidates=${r.candidates?.length || 0}`;
});

await step("generate idempotent rerun", async () => {
  await call("generate", { method: "POST", body: { template_key: "ar_customer", period } });
  const sheet = await call("sheet", { query: { id: sheetId } });
  if (sheet.lines.length !== beforeLineCount) throw new Error(`line count changed ${beforeLineCount} -> ${sheet.lines.length}`);
  const line = sheet.lines.find(x => x.id === lineId);
  if (!line?.expected_confirmed_at) throw new Error("confirmed line lost expected_confirmed_at");
  if (line.status !== confirmedStatus) throw new Error(`confirmed line status changed ${confirmedStatus} -> ${line.status}`);
  return `lines=${sheet.lines.length} confirmed_status=${line.status}`;
});

if (!process.exitCode) console.log("PASS recon-p1 smoke complete");
