import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { loadConfig } from "./recon/recon-config-loader.js";
import { runReadonly } from "./recon/recon-engine.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);
const COMPARE_TEMPLATE = "customs_invoice";
const STATUSES = [
  "need_amount",
  "pending_confirm",
  "confirmed_wait_invoice",
  "matched",
  "partial_uploaded",
  "over_issued",
  "completed",
];

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseMonth(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12 ? s : null;
}

function addMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function rangeFromQuery(query) {
  const now = new Date();
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const from = parseMonth(query?.from) || current;
  const to = parseMonth(query?.to) || from;
  if (from > to) return null;

  return {
    from,
    to,
    start: `${from}-01`,
    end: addMonth(to),
  };
}

function summarizeOld(rows) {
  const out = {
    customs_count: rows.length,
    expected_total: 0,
    uploaded_total: 0,
    diff_total: 0,
  };

  for (const status of STATUSES) out[status] = 0;

  for (const row of rows) {
    if (row.status) out[row.status] = (out[row.status] || 0) + 1;
    out.expected_total = money(out.expected_total + (money(row.effective_expected_amount) || 0)) || 0;
    out.uploaded_total = money(out.uploaded_total + (money(row.uploaded_amount) || 0)) || 0;
    out.diff_total = money(out.diff_total + (money(row.diff_amount) || 0)) || 0;
  }

  return out;
}

function summarizeNew(summary) {
  const out = {
    customs_count: summary.customs_count || 0,
    expected_total: money(summary.expected_amount) || 0,
    uploaded_total: money(summary.uploaded_amount) || 0,
    diff_total: money(summary.diff_amount) || 0,
  };

  for (const status of STATUSES) out[status] = Number(summary[status] || summary.status_counts?.[status] || 0);
  return out;
}

function compareSummary(oldSummary, newSummary) {
  const fields = [
    "customs_count",
    "expected_total",
    "uploaded_total",
    "diff_total",
    ...STATUSES,
  ];
  const diffs = [];

  for (const field of fields) {
    const oldValue = oldSummary[field] ?? 0;
    const newValue = newSummary[field] ?? 0;
    const same = typeof oldValue === "number" && typeof newValue === "number"
      ? Math.abs(oldValue - newValue) < 0.01
      : oldValue === newValue;

    if (!same) diffs.push(`${field}: ${oldValue} vs ${newValue}`);
  }

  return {
    match: diffs.length === 0,
    diffs,
  };
}

async function handleShadow(req, res) {
  const template = String(req.query?.template || "").trim();
  if (!template) return json(res, 400, { error: "template required" });

  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });

  const config = loadConfig(template);
  const out = await runReadonly(getPool(), config, { start: range.start, end: range.end });

  return res.json({
    success: true,
    template,
    period: { from: range.from, to: range.to, start: range.start, end: range.end },
    ...out,
  });
}

async function handleCompare(req, res) {
  const template = String(req.query?.template || "").trim();
  if (template !== COMPARE_TEMPLATE) {
    return json(res, 400, { error: "compare only supports template=customs_invoice" });
  }

  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });

  const config = loadConfig(template);
  const [newOut, oldMod] = await Promise.all([
    runReadonly(getPool(), config, { start: range.start, end: range.end }),
    import("./customs-collab.js"),
  ]);

  if (typeof oldMod.fetchRows !== "function") {
    throw new Error("customs-collab.js must export fetchRows for compare action");
  }

  const oldRows = await oldMod.fetchRows(getPool(), {
    start: range.start,
    end: range.end,
  });

  const oldSummary = summarizeOld(oldRows);
  const newSummary = summarizeNew(newOut.summary);
  const compared = compareSummary(oldSummary, newSummary);

  return res.json({
    success: true,
    template,
    period: { from: range.from, to: range.to, start: range.start, end: range.end },
    old: oldSummary,
    new: newSummary,
    match: compared.match,
    diffs: compared.diffs,
  });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (!requireAuth(req, res)) return;
    if (!FINANCE_ROLES.has(req.user?.role)) {
      return json(res, 403, { error: "Forbidden", message: "仅财务/管理员可操作" });
    }

    const action = String(req.query?.action || "").trim();
    if (action === "shadow") return handleShadow(req, res);
    if (action === "compare") return handleCompare(req, res);

    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[recon-shadow]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
