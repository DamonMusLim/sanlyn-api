const MONEY_SCALE = 100;

export function money(value) {
  const n = Number(value || 0);
  return Math.round(n * MONEY_SCALE) / MONEY_SCALE;
}

export function num(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

export function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  return raw;
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s,，.。()（）\-_/\\]+/g, "");
}

// 中英文公司别名归一（收款方常以英文名出现在水单、以中文名存于 plan.counterpart）
const COUNTERPART_ALIASES = [
  ["上海洋宝宝国际物流有限公司", "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS"],
  ["万汇恒通(厦门)国际物流有限公司", "WANHUI HENGTONG (XIAMEN) INTERNATIONAL LOGISTICS"],
];

function aliasNorm(name) {
  const n = norm(name);
  for (const pair of COUNTERPART_ALIASES) {
    if (pair.some(a => { const na = norm(a); return na && (n.includes(na) || na.includes(n)); })) return norm(pair[0]);
  }
  return n;
}

export function sameCounterpart(bankName, candidates) {
  const b = aliasNorm(bankName);
  const cs = candidates.map(aliasNorm).filter(Boolean);
  if (!b || !cs.length) return false;
  return cs.some(c => b.includes(c) || c.includes(b));
}

export function planId(plan) {
  return plan?._id ?? plan?.id ?? null;
}

export function planCounterparts(plan) {
  const raw = parseRaw(plan?.raw);
  return [
    plan?.counterpart,
    plan?.forwarder,
    plan?.forwarder_cn,
    plan?.forwarder_en,
    raw.counterpart,
    raw.forwarder,
    raw.forwarder_cn,
    raw.forwarder_en,
    raw.supplierFreight,
  ].filter(Boolean);
}

export function extractFiAll(text) {
  const out = [];
  const re = /FI-([A-Z0-9]+)(-(\d{8}))?/g;
  let m;
  const s = String(text || "").toUpperCase();
  while ((m = re.exec(s))) {
    const issueDate = m[3] ? `${m[3].slice(0,4)}-${m[3].slice(4,6)}-${m[3].slice(6,8)}` : null;
    out.push({ invoiceNo: `FI-${m[1]}${m[2] || ""}`, core: m[1], issueDate });
  }
  return out;
}

// 按 FI 票面开票日重建当日汇率（复刻 shipping-plan-pdf.js L1198: 当日最新 rate + 0.1, 4位舍入）
export async function fxAtDate(db, dateStr) {
  if (!dateStr) return null;
  const r = await db.query(
    `SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' AND fetched_at < ($1::date + INTERVAL '1 day') ORDER BY fetched_at DESC LIMIT 1`,
    [dateStr]);
  if (!r.rows.length) return null;
  return Math.round((Number(r.rows[0].rate) + 0.1) * 10000) / 10000;
}

export async function ensureExceptionTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS finance_recon_exceptions (
      id bigserial PRIMARY KEY,
      source_type text,
      source_id text,
      invoice_no text,
      expected_amount numeric,
      actual_amount numeric,
      diff_amount numeric,
      currency text,
      exception_type text,
      suggestion text,
      status text default 'pending',
      raw jsonb,
      created_at timestamptz default now(),
      resolved_at timestamptz,
      resolved_by text
    )
  `);
}

export async function writeException(db, ex, dryRun) {
  const row = {
    source_type: ex.source_type || "bank_slip_link",
    source_id: ex.source_id || null,
    invoice_no: ex.invoice_no || null,
    expected_amount: ex.expected_amount == null ? null : money(ex.expected_amount),
    actual_amount: ex.actual_amount == null ? null : money(ex.actual_amount),
    diff_amount: ex.diff_amount == null ? null : money(ex.diff_amount),
    currency: ex.currency || "CNY",
    exception_type: ex.exception_type || "recon_exception",
    suggestion: ex.suggestion || "",
    raw: ex.raw || {},
  };
  if (!dryRun) {
    const inserted = await db.query(
      `INSERT INTO finance_recon_exceptions
       (source_type, source_id, invoice_no, expected_amount, actual_amount, diff_amount, currency, exception_type, suggestion, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING id`,
      [row.source_type, row.source_id, row.invoice_no, row.expected_amount, row.actual_amount, row.diff_amount, row.currency, row.exception_type, row.suggestion, JSON.stringify(row.raw)]
    );
    row.id = inserted.rows[0]?.id || null;
  }
  return { status: "exception", ...row };
}

async function writeSideEffectFailure(db, label, err) {
  try {
    await writeException(db, {
      source_type: "freight_recon_side_effect",
      source_id: label,
      exception_type: "side_effect_failed",
      suggestion: `${label}写入失败，主流程已继续；请核查该副作用表。`,
      raw: { label, error: err.message || String(err), at: new Date().toISOString() },
    }, false);
  } catch (logErr) {
    console.warn(`[freight-recon:${label}:log_failed]`, logErr.message);
  }
}

async function safeSideEffect(db, label, fn, useSavepoint = false) {
  const sp = `finance_p0_${Math.random().toString(16).slice(2)}`;
  try {
    if (useSavepoint) await db.query(`SAVEPOINT ${sp}`);
    const result = await fn();
    if (useSavepoint) await db.query(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    if (useSavepoint) {
      try { await db.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) {}
      try { await db.query(`RELEASE SAVEPOINT ${sp}`); } catch (_) {}
    }
    // Side-effect failures must leave queryable evidence instead of vanishing in console.warn only.
    await writeSideEffectFailure(db, label, err);
    console.warn(`[freight-recon:${label}]`, err.message);
    return { __side_effect_failed: true, label, error: err.message || String(err) };
  }
}

export async function writeFinanceAudit(db, row, useSavepoint = false) {
  return safeSideEffect(db, "audit", async () => {
    await db.query(
      `INSERT INTO finance_audit_log
       (table_name, row_id, field, old_value, new_value, actor, source, reason, op_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.table_name,
        String(row.row_id),
        row.field || null,
        row.old_value == null ? null : String(row.old_value),
        row.new_value == null ? null : String(row.new_value),
        row.actor || "freight-recon-auto",
        row.source || "reconcile",
        row.reason || null,
        row.op_id || null,
      ]
    );
  }, useSavepoint);
}

export async function writeExceptionAudit(db, exRow, opId, useSavepoint = false) {
  if (!exRow?.id) return;
  await writeFinanceAudit(db, {
    table_name: "finance_recon_exceptions",
    row_id: exRow.id,
    field: "created",
    old_value: null,
    new_value: exRow.exception_type || "recon_exception",
    actor: "freight-recon-auto",
    source: "reconcile",
    reason: exRow.suggestion || null,
    op_id: opId,
  }, useSavepoint);
}

export async function writeSettlementAndAudit(db, { link, paymentId, invoiceNo, amount, reconChange, opId }, useSavepoint = false) {
  const settlement = await safeSideEffect(db, "settlement_links", async () => {
    const inserted = await db.query(
      `INSERT INTO finance_settlement_links
       (payment_id, target_type, target_id, amount_applied, currency, source, created_by)
       VALUES ($1,'invoice_out',$2,$3,'CNY','freight-recon','auto')
       RETURNING id`,
      [paymentId, invoiceNo, amount]
    );
    return inserted.rows[0] || null;
  }, useSavepoint);
  const settlementFailed = settlement?.__side_effect_failed === true;
  const settlementLinkId = settlementFailed ? null : settlement?.id || null;
  await writeFinanceAudit(db, {
    table_name: "bank_slip_links",
    row_id: link.id,
    field: "payment_id",
    old_value: null,
    new_value: paymentId,
    actor: "freight-recon-auto",
    source: "reconcile",
    op_id: opId,
  }, useSavepoint);
  await writeFinanceAudit(db, {
    table_name: "finance_invoices_out",
    row_id: invoiceNo,
    field: "raw.recon.status",
    old_value: reconChange?.oldStatus || null,
    new_value: reconChange?.newStatus || null,
    actor: "freight-recon-auto",
    source: "reconcile",
    reason: settlementLinkId ? `finance_settlement_links.id=${settlementLinkId}` : null,
    op_id: opId,
  }, useSavepoint);
  return { settlement_link_id: settlementLinkId, side_effect_failures: settlementFailed ? 1 : 0 };
}
