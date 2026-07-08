import { getPool, setCors } from "../db.js";

const MONEY_SCALE = 100;
const AUTO_MATCH_TOLERANCE = 10;

function money(value) {
  const n = Number(value || 0);
  return Math.round(n * MONEY_SCALE) / MONEY_SCALE;
}

function num(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function parseRaw(raw) {
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

function sameCounterpart(bankName, candidates) {
  const b = aliasNorm(bankName);
  const cs = candidates.map(aliasNorm).filter(Boolean);
  if (!b || !cs.length) return false;
  return cs.some(c => b.includes(c) || c.includes(b));
}

function planId(plan) {
  return plan?._id ?? plan?.id ?? null;
}

function planCounterparts(plan) {
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

function extractFiAll(text) {
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

// 按 FI 票面开票日重建当日汇率（复刻 shipping-plan-pdf.js L1198: 当日最新 rate + 0.1, 4位舍入）
async function fxAtDate(db, dateStr) {
  if (!dateStr) return null;
  const r = await db.query(
    `SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' AND fetched_at < ($1::date + INTERVAL '1 day') ORDER BY fetched_at DESC LIMIT 1`,
    [dateStr]);
  if (!r.rows.length) return null;
  return Math.round((Number(r.rows[0].rate) + 0.1) * 10000) / 10000;
}

async function ensureExceptionTable(db) {
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

async function writeException(db, ex, dryRun) {
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
    console.warn(`[freight-recon:${label}]`, err.message);
    return null;
  }
}

async function writeFinanceAudit(db, row, useSavepoint = false) {
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

async function writeExceptionAudit(db, exRow, opId, useSavepoint = false) {
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

async function writeSettlementAndAudit(db, { link, paymentId, invoiceNo, amount, reconChange, opId }, useSavepoint = false) {
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
  const settlementLinkId = settlement?.id || null;
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
}

async function latestFx(db) {
  const r = await db.query(`SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`);
  if (!r.rows.length) return null;
  return Math.round((Number(r.rows[0].rate) + 0.1) * 10000) / 10000;
}

async function findPlan(db, core) {
  const r = await db.query(
    `SELECT * FROM shipping_plans
     WHERE shipment_no = $1 OR bl_no = $1 OR id::text = $1 OR _id::text = $1
     ORDER BY container_qty DESC NULLS LAST, id ASC
     LIMIT 1`,
    [core]
  );
  return r.rows[0] || null;
}

async function findInvoice(db, invoiceNo, core) {
  const exact = await db.query(`SELECT * FROM finance_invoices_out WHERE invoice_no = $1 LIMIT 1`, [invoiceNo]);
  if (exact.rows.length) return exact.rows[0];
  const fuzzy = await db.query(
    `SELECT * FROM finance_invoices_out
     WHERE invoice_no = $1 OR invoice_no LIKE $2
     ORDER BY issue_date DESC NULLS LAST, invoice_no DESC
     LIMIT 1`,
    [`FI-${core}`, `FI-${core}-%`]
  );
  return fuzzy.rows[0] || null;
}

async function updateInvoiceRecon(db, invoiceNo, paidAmount, paymentId) {
  const inv = await findInvoice(db, invoiceNo, invoiceNo.replace(/^FI-/, "").replace(/-\d{8}$/, ""));
  if (!inv) return { invoiceNo, oldStatus: null, newStatus: null };
  const raw = parseRaw(inv.raw);
  const previous = parseRaw(raw.recon);
  const oldStatus = previous.status || null;
  const paymentIds = [...new Set([...(previous.payment_ids || []), paymentId].filter(Boolean))];
  const total = money(inv.amount_incl_tax);
  const paid = money(num(previous.paid_amount) + num(paidAmount));
  const newStatus = paid <= 0 ? "unpaid" : paid + 0.01 >= total ? "paid" : "partial";
  raw.recon = {
    status: newStatus,
    paid_amount: paid,
    payment_ids: paymentIds,
    updated_at: new Date().toISOString(),
  };
  await db.query(`UPDATE finance_invoices_out SET raw = $2::jsonb WHERE invoice_no = $1`, [inv.invoice_no, JSON.stringify(raw)]);
  return { invoiceNo: inv.invoice_no, oldStatus, newStatus };
}

async function markFreightSupplierBillsReconciled(db, { plan, invoiceNo, paymentId }) {
  const blNo = plan?.bl_no || plan?.hbl_no || null;
  if (!blNo) return 0;
  const payerCode = plan?.company_code || null;
  const colR = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'freight_supplier_bills' AND column_name = 'canonical_category' LIMIT 1`);
  const categoryCond = colR.rows.length
    ? `(cost_category ~* '海运|ocean|freight' OR COALESCE(canonical_category, '') ~* '海运|ocean|freight')`
    : `cost_category ~* '海运|ocean|freight'`;
  const params = [blNo, `auto: freight-recon ${invoiceNo || ""} payment=${paymentId || ""}`.trim()];
  const conds = [
    `bl_no = $1`,
    `COALESCE(sale_amount, 0) > 0`,
    categoryCond,
  ];
  if (payerCode) {
    params.push(payerCode);
    conds.push(`payer_company_code = $${params.length}`);
  }
  const r = await db.query(
    `UPDATE freight_supplier_bills
        SET reconciled = true,
            reconcile_note = CONCAT_WS(E'\n', NULLIF(reconcile_note, ''), $2),
            updated_at = NOW()
      WHERE ${conds.join(" AND ")}
      RETURNING id`,
    params
  );
  return r.rowCount || 0;
}

export async function recalcPlanFreightTotals(pool, planIdValue) {
  if (!planIdValue) return;
  const r = await pool.query(`SELECT * FROM shipping_plans WHERE id::text = $1::text OR _id::text = $1::text LIMIT 1`, [String(planIdValue)]);
  const plan = r.rows[0];
  if (!plan) return;

  const inv = await pool.query(
    `SELECT raw FROM finance_invoices_out
     WHERE raw->'fi'->>'shipment_no' = $1 OR raw->'fi'->>'bl_no' = $2
     ORDER BY issue_date DESC NULLS LAST, invoice_no DESC
     LIMIT 1`,
    [plan.shipment_no || "", plan.bl_no || ""]
  );
  const fi = parseRaw(parseRaw(inv.rows[0]?.raw).fi);
  const usdTotal = num(fi.usd_total) || money(num(plan.freight_sale_usd) * num(plan.container_qty || 1));
  const fx = num(fi.fx_rate);
  const saleCny = fx ? money(usdTotal * fx) : null;
  const raw = parseRaw(plan.raw);
  const rawCostTotal = Array.isArray(raw.cost_lines)
    ? raw.cost_lines.reduce((s, line) => s + num(line.cost ?? line.amount_cost ?? line.freight_cost ?? line.amount), 0)
    : 0;
  const columnCostTotal = [
    plan.freight_cost,
    plan.thc_fee,
    plan.eir_fee,
    plan.seal_fee,
    plan.bkg_fee,
    plan.doc_fee,
    plan.tlx_fee,
    plan.info_trans_fee,
    plan.customs_cost_total,
    plan.trucking_cost_total,
    plan.insurance_cost,
    plan.port_surcharge_total,
  ].reduce((s, v) => s + num(v), 0);
  const costTotal = money(rawCostTotal || columnCostTotal);
  await pool.query(
    `UPDATE shipping_plans
     SET freight_sale_cny = COALESCE($2, freight_sale_cny),
         freight_total_cny = $3
     WHERE id::text = $1::text OR _id::text = $1::text`,
    [String(planIdValue), saleCny, costTotal]
  );
}

export async function registerFreightInvoice(pool, payload) {
  await ensureExceptionTable(pool);
  const invoiceNo = payload.invoiceNo || payload.invoice_no;
  if (!invoiceNo) throw new Error("invoiceNo is required");

  const issueDate = payload.issue_date || new Date().toISOString().slice(0, 10);
  const usdTotal = money(payload.usdTotal ?? payload.usd_total);
  const cnyEquiv = money(payload.cnyEquiv ?? payload.cny_equiv);
  const cnyTotal = money(payload.cnyTotal ?? payload.cny_total);
  const amount = money(cnyEquiv + cnyTotal);
  const contractNos = asArray(payload.contract_nos);
  const fi = {
    shipment_no: payload.shipment_no || null,
    bl_no: payload.bl_no || null,
    fx_rate: payload.fxRate ?? payload.fx_rate ?? null,
    usd_total: usdTotal,
    cny_equiv: cnyEquiv,
    cost_lines_snapshot: payload.cost_lines || [],
    counterpart: payload.counterpart || null,
  };

  const existing = await pool.query(`SELECT * FROM finance_invoices_out WHERE invoice_no = $1 LIMIT 1`, [invoiceNo]);
  if (existing.rows.length) {
    const raw = parseRaw(existing.rows[0].raw);
    const recon = parseRaw(raw.recon);
    if (recon.status === "paid") {
      raw.fi = {
        ...(parseRaw(raw.fi)),
        conflict_log: [
          ...(parseRaw(raw.fi).conflict_log || []),
          { at: new Date().toISOString(), incoming: fi, incoming_amount: amount },
        ],
      };
      await pool.query(`UPDATE finance_invoices_out SET raw = $2::jsonb WHERE invoice_no = $1`, [invoiceNo, JSON.stringify(raw)]);
      return { conflict: true, invoice_no: invoiceNo };
    }
    raw.fi = fi;
    raw.recon = {
      status: recon.status || "unpaid",
      paid_amount: money(recon.paid_amount),
      payment_ids: recon.payment_ids || [],
      updated_at: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE finance_invoices_out
       SET issue_date=$2, buyer_name=$3, amount_ex_tax=$4, total_tax=0, amount_incl_tax=$4,
           tax_rate=0, currency=$5, contract_nos=$6, customs_nos=$7, remark=$8, source='shipping_plan_pdf',
           raw=$9::jsonb
       WHERE invoice_no=$1`,
      [invoiceNo, issueDate, payload.buyer_name || null, amount, payload.currency || "CNY", contractNos, payload.customs_nos || null, payload.remark || null, JSON.stringify(raw)]
    );
  } else {
    const raw = {
      fi,
      recon: { status: "unpaid", paid_amount: 0, payment_ids: [], updated_at: new Date().toISOString() },
    };
    await pool.query(
      `INSERT INTO finance_invoices_out
       (invoice_no, invoice_type, issue_date, seller_name, buyer_name, customer_id, amount_ex_tax, total_tax,
        amount_incl_tax, tax_rate, currency, contract_nos, customs_nos, remark, source, raw,
        buyer_company_code, seller_company_code, attachments)
       VALUES ($1,'freight',$2,$3,$4,$5,$6,0,$6,0,$7,$8,$9,$10,'shipping_plan_pdf',$11::jsonb,$12,$13,$14)`,
      [
        invoiceNo,
        issueDate,
        payload.seller_name || payload.counterpart || "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO.,LTD.", // 运费FI卖方=收款货代(铁律:运费款→counterpart)
        payload.buyer_name || null,
        payload.customer_id || null,
        amount,
        payload.currency || "CNY",
        contractNos,
        payload.customs_nos || null,
        payload.remark || null,
        JSON.stringify(raw),
        payload.buyer_company_code || null,
        payload.seller_company_code || null,
        payload.attachments || null,
      ]
    );
  }

  if (payload.plan_id) await recalcPlanFreightTotals(pool, payload.plan_id);
  return { conflict: false, invoice_no: invoiceNo, amount_incl_tax: amount };
}

export async function reconcile(pool, dryRun) {
  const results = [];
  const db = dryRun ? pool : await pool.connect();
  const groupPayments = new Map();
  const opId = new Date().toISOString();
  try {
    if (!dryRun) await db.query("BEGIN");
    if (!dryRun) await ensureExceptionTable(db);
    const links = await db.query(`
      SELECT l.*, s.beneficiary_reference, s.bank_reference_no, s.payment_date, s.beneficiary_name
      FROM bank_slip_links l
      JOIN bank_slips s ON s.id = l.slip_id
      WHERE l.payment_id IS NULL
      ORDER BY l.slip_id, (l.amount_alloc IS NULL), l.id
    `);

    for (const link of links.rows) {
      // note 里的 FI 号是行级真值，slip reference 是票级集合 → note 候选排前
      const candidates = [...extractFiAll(link.note), ...extractFiAll(link.beneficiary_reference)];
      // 同核心号互补开票日期（note 写 FI-CY00362、reference 写 FI-CY00362-20260608 → 借日期）
      for (const cand of candidates) {
        if (!cand.issueDate) {
          const dated = candidates.find(x => x.core === cand.core && x.issueDate);
          if (dated) { cand.issueDate = dated.issueDate; cand.invoiceNo = dated.invoiceNo; }
        }
      }
      if (!candidates.length) {
        results.push({ status: "skipped", link_id: link.id, reason: "no_fi_reference" });
        continue;
      }
      // 择优：候选解析出的 plan 与 link 的 bl_no 一致，或票号出现在 note 里
      let fiRef = null, plan = null;
      const noteUp = String(link.note || "").toUpperCase();
      for (const cand of candidates) {
        const pl = await findPlan(db, cand.core);
        if (!pl) continue;
        const blMatch = link.bl_no && pl.bl_no && String(pl.bl_no).toUpperCase() === String(link.bl_no).toUpperCase();
        const noteMatch = pl.shipment_no && noteUp.includes(String(pl.shipment_no).toUpperCase());
        if (blMatch || noteMatch) { fiRef = cand; plan = pl; break; }
        if (!fiRef) { fiRef = cand; plan = pl; } // 兜底：第一个能解析的
      }
      if (!fiRef) fiRef = candidates[0];
      if (!plan) {
        const exRow = await writeException(db, {
          source_id: link.id,
          invoice_no: fiRef.invoiceNo,
          exception_type: "plan_not_found",
          suggestion: "FI号对不上任何海运计划，核对票号/提单号/计划ID。",
          raw: { link },
        }, dryRun);
        if (!dryRun) await writeExceptionAudit(db, exRow, opId, true);
        results.push(exRow);
        continue;
      }
      const _invForCp = await findInvoice(db, fiRef.invoiceNo, fiRef.core);
      // 收款方合法集合 = plan 货代 + FI 卖方 + 自有收款主体(seller_profiles，数据驱动不硬编码)
      if (!global.__sellerNames) {
        const sp = await db.query("SELECT name_cn, name_en FROM seller_profiles");
        global.__sellerNames = sp.rows.flatMap(r => [r.name_cn, r.name_en]).filter(Boolean);
      }
      const _cpCandidates = [...planCounterparts(plan), _invForCp?.seller_name, ...global.__sellerNames].filter(Boolean);
      if (!sameCounterpart(link.beneficiary_name, _cpCandidates)) {
        const exRow = await writeException(db, {
          source_id: link.id,
          invoice_no: fiRef.invoiceNo,
          exception_type: "counterpart_mismatch",
          suggestion: "水单收款方与海运计划货代/收款主体不一致，人工核对。",
          raw: { link, plan_id: planId(plan), expected_counterparts: planCounterparts(plan) },
        }, dryRun);
        if (!dryRun) await writeExceptionAudit(db, exRow, opId, true);
        results.push(exRow);
        continue;
      }

      const invoice = await findInvoice(db, fiRef.invoiceNo, fiRef.core);
      const usd = money(num(plan.freight_sale_usd) * num(plan.container_qty || 1));
      // fx 优先级：①票面日期重建（最权威，可独立验证）②FI raw 快照
      // 绝不允许「实付/usd」推断出的 fx 参与核销判定——那会让 diff 恒为 0，差异永远抓不到
      let fx = await fxAtDate(db, fiRef.issueDate);
      let fxSource = fx ? "ref_date_rebuild" : null;
      if (!fx) {
        fx = num(parseRaw(parseRaw(invoice?.raw).fi).fx_rate);
        if (fx) fxSource = "fi_snapshot";
      }
      const inferred = false;
      if (!fx || !usd) {
        const exRow = await writeException(db, {
          source_id: link.id,
          invoice_no: fiRef.invoiceNo,
          expected_amount: null,
          actual_amount: link.amount_alloc,
          exception_type: "missing_fx_or_usd",
          suggestion: "先登记FI应收，或补全海运卖价/柜数后重跑核销。",
          raw: { link, plan_id: planId(plan) },
        }, dryRun);
        if (!dryRun) await writeExceptionAudit(db, exRow, opId, true);
        results.push(exRow);
        continue;
      }

      const expected = money(usd * fx);
      const groupKey = `${link.slip_id}:${fiRef.invoiceNo}`;
      if (link.amount_alloc == null) {
        const existingPayment = groupPayments.get(groupKey);
        if (existingPayment) {
          if (!dryRun) await db.query(`UPDATE bank_slip_links SET payment_id=$1 WHERE id=$2`, [existingPayment, link.id]);
          results.push({ status: "matched", link_id: link.id, invoice_no: fiRef.invoiceNo, payment_id: existingPayment, grouped: true });
        } else {
          results.push({ status: "skipped", link_id: link.id, invoice_no: fiRef.invoiceNo, reason: "group_payment_not_ready" });
        }
        continue;
      }

      const actual = money(link.amount_alloc);
      const diff = money(actual - expected);
      if (Math.abs(diff) > AUTO_MATCH_TOLERANCE) {
        const exRow = await writeException(db, {
          source_id: link.id,
          invoice_no: fiRef.invoiceNo,
          expected_amount: expected,
          actual_amount: actual,
          diff_amount: diff,
          exception_type: "amount_mismatch",
          suggestion: "禁止自动调账：核对FI应收金额与水单分配，确认差额原因（如电放费/文件费漏记）后人工处理。",
          raw: { link, plan_id: planId(plan), usd_total: usd, fx_rate: fx, inferred_fx: inferred },
        }, dryRun);
        if (!dryRun) await writeExceptionAudit(db, exRow, opId, true);
        results.push(exRow);
        continue;
      }

      let paymentId = `dry-${link.id}`;
      if (!dryRun) {
        const pay = await db.query(
          `INSERT INTO finance_payments
           (_id, plan_id, contract_no, order_no, amount, currency, this_amount, paid_amount, pending_amount,
            bank_ref, payment_date, pay_type, pay_item, type, direction, status, forwarder_cn, freight_recv, raw, company_code)
           VALUES ('pay_' || extract(epoch from now())::bigint || '_' || substr(md5(random()::text),1,6),$1,$2,$3,$4,'CNY',$4,$4,0,$5,$6,'freight','ocean_freight','freight','in','confirmed',$7,$4,$8::jsonb,$9)
           RETURNING id`,
          [
            planId(plan),
            link.contract_no || null,
            link.order_no || null,
            actual,
            link.bank_reference_no || null,
            link.payment_date || null,
            link.beneficiary_name || null,
            JSON.stringify({ slip_id: link.slip_id, link_id: link.id }),
            plan.company_code || null,
          ]
        );
        paymentId = pay.rows[0].id;
        await db.query(`UPDATE bank_slip_links SET payment_id=$1 WHERE id=$2`, [paymentId, link.id]);
        const invoiceNo = invoice?.invoice_no || fiRef.invoiceNo;
        const reconChange = await updateInvoiceRecon(db, invoiceNo, actual, paymentId);
        await writeSettlementAndAudit(db, { link, paymentId, invoiceNo, amount: actual, reconChange, opId }, true);
        await markFreightSupplierBillsReconciled(db, { plan, invoiceNo, paymentId });
        await recalcPlanFreightTotals(db, planId(plan));
      }
      groupPayments.set(groupKey, paymentId);
      results.push({
        status: "matched",
        link_id: link.id,
        invoice_no: invoice?.invoice_no || fiRef.invoiceNo,
        plan_id: planId(plan),
        expected_amount: expected,
        actual_amount: actual,
        diff_amount: diff,
        fx_rate: fx,
        fx_source: fxSource,
        payment_id: paymentId,
      });
    }

    if (!dryRun) await db.query("COMMIT");
  } catch (e) {
    if (!dryRun) await db.query("ROLLBACK");
    throw e;
  } finally {
    if (!dryRun) db.release();
  }
  return results;
}

async function registerBackfill(pool) {
  const results = [];
  await ensureExceptionTable(pool);
  const fx = await latestFx(pool);
  if (!fx) return [{ status: "exception", exception_type: "missing_fx_rate", suggestion: "查无USD_CNY汇率，检查exchange_rates表。" }];
  const plans = await pool.query(`
    SELECT *
    FROM shipping_plans p
    WHERE p.raw->'cost_lines' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM finance_invoices_out f
        WHERE f.invoice_no LIKE 'FI-' || COALESCE(p.shipment_no, p.bl_no, p.id::text) || '-%'
           OR f.raw->'fi'->>'shipment_no' = p.shipment_no
           OR f.raw->'fi'->>'bl_no' = p.bl_no
      )
    ORDER BY p.id
  `);
  const today = new Date().toISOString().slice(0, 10);
  for (const plan of plans.rows) {
    const raw = parseRaw(plan.raw);
    const usdTotal = money(num(plan.freight_sale_usd) * num(plan.container_qty || 1));
    if (!usdTotal) {
      results.push(await writeException(pool, {
        source_type: "shipping_plan",
        source_id: planId(plan),
        exception_type: "missing_usd_total",
        suggestion: "海运计划缺卖价USD或柜数，补全后重跑backfill。",
        raw: { shipment_no: plan.shipment_no, bl_no: plan.bl_no },
      }, false));
      continue;
    }
    const invoiceNo = `FI-${plan.shipment_no || plan.bl_no || String(plan.id)}-${today.replace(/-/g, "")}`;
    const r = await registerFreightInvoice(pool, {
      invoiceNo,
      issue_date: today,
      plan_id: planId(plan),
      shipment_no: plan.shipment_no,
      bl_no: plan.bl_no,
      fxRate: fx,
      usdTotal,
      cnyEquiv: money(usdTotal * fx),
      cnyTotal: 0,
      cost_lines: raw.cost_lines || [],
      counterpart: plan.counterpart || plan.forwarder_cn || plan.forwarder_en || raw.counterpart || raw.forwarder || raw.supplierFreight || null,
      buyer_name: plan.customer_en || plan.customer_cn || plan.customer || null,
      contract_nos: asArray(plan.contract_nos || plan.order_nos || plan.contract_no),
      currency: "CNY",
    });
    await recalcPlanFreightTotals(pool, planId(plan));
    results.push({ status: "registered", plan_id: planId(plan), ...r });
  }
  return results;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!req.user || ["customer", "factory"].includes(req.user.role)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  try {
    const pool = getPool();
    const { action, dry_run: dryRun = false } = req.body || {};
    if (action === "reconcile") {
      const results = await reconcile(pool, !!dryRun);
      return res.status(200).json({ ok: true, dry_run: !!dryRun, results });
    }
    if (action === "register_backfill") {
      const results = await registerBackfill(pool);
      return res.status(200).json({ ok: true, results });
    }
    return res.status(400).json({ ok: false, error: "bad_action" });
  } catch (e) {
    console.error("[freight-recon]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/*
Changed lines:
- 283-307: added matched-FI helper to mark matching freight_supplier_bills rows reconciled=true with auto note.
- 595: call the helper only after automatic matched payment/invoice settlement succeeds.
*/
