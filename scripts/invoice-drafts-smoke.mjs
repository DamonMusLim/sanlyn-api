import "dotenv/config";

const token = process.env.SMOKE_TOKEN;
const port = process.env.PORT || "3000";
const base = process.env.SMOKE_BASE_URL || `http://localhost:${port}/api/db/invoice-drafts`;

if (!token) {
  console.error("FAIL SMOKE_TOKEN is required");
  process.exit(1);
}

async function call(action, { method = "GET", body, query = {}, expectStatus } = {}) {
  const url = new URL(base);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (expectStatus && res.status === expectStatus) return data;
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

let beforeCount = 0;
let confirmedId = null;
let cancelledId = null;

await step("scan dry_run", async () => {
  const r = await call("scan", { method: "POST", body: { dry_run: true } });
  return `rows=${r.rows?.length || 0} skipped=${r.skipped?.length || 0}`;
});

await step("scan write", async () => {
  const r = await call("scan", { method: "POST", body: {} });
  return `scanned=${r.scanned} written=${r.written} skipped=${r.skipped?.length || 0}`;
});

const listed = await step("list drafts", async () => {
  const r = await call("list");
  beforeCount = r.rows?.length || 0;
  if (!beforeCount) throw new Error("no drafts generated");
  return r;
});

await step("confirm one draft", async () => {
  const rows = listed.rows || [];
  const pending = rows.find(row => row.status === "pending");
  if (pending) {
    const r = await call("confirm", { method: "POST", body: { id: pending.id, remark: "invoice-drafts-smoke" } });
    confirmedId = r.draft?.id;
    if (r.draft?.status !== "confirmed") throw new Error("pending draft was not confirmed");
    return `id=${confirmedId}`;
  }
  const blocked = rows.find(row => row.status === "blocked");
  if (!blocked) throw new Error("no pending or blocked draft available");
  const rejected = await call("confirm", { method: "POST", body: { id: blocked.id }, expectStatus: 400 });
  if (!String(rejected.error || "").includes("报关金额缺失")) throw new Error("blocked confirmation did not reject missing amount");
  return `blocked_rejected=${blocked.id}`;
});

await step("cancel one draft", async () => {
  const r = await call("list");
  const target = (r.rows || []).find(row => ["pending", "blocked"].includes(row.status) && row.id !== confirmedId);
  if (!target) return "skip=no cancellable draft";
  const c = await call("cancel", { method: "POST", body: { id: target.id, reason: "invoice-drafts-smoke" } });
  cancelledId = c.draft?.id;
  if (c.draft?.status !== "cancelled") throw new Error("draft was not cancelled");
  return `id=${cancelledId}`;
});

await step("scan rerun idempotent", async () => {
  await call("scan", { method: "POST", body: {} });
  const r = await call("list");
  if ((r.rows?.length || 0) !== beforeCount) throw new Error(`row count changed ${beforeCount} -> ${r.rows?.length || 0}`);
  if (confirmedId) {
    const row = r.rows.find(x => x.id === confirmedId);
    if (!row || row.status !== "confirmed") throw new Error("confirmed draft was refreshed or lost");
  }
  return `rows=${r.rows.length} confirmed=${confirmedId || "none"} cancelled=${cancelledId || "none"}`;
});

if (!process.exitCode) console.log("PASS invoice-drafts smoke complete");
