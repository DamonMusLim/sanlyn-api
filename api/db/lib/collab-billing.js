// collab-billing.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import { requireAuth } from "../../auth.js";
import { derivePlanFactories } from "../booking-collab-view.js";
import { rawToHash } from "./collab-shared.js";

// ── POST /set-factory-bill (Sanlyn内部) ───────────────────────
async function handleSetFactoryBill(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, amount_cny, pdf_url, note, sent_by } = req.body || {};
  if (!plan_id) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  if (amount_cny === undefined || amount_cny === null || amount_cny === "")
    return res.status(400).json({ ok: false, error: "amount_cny 必填" });

  const amount = Number(amount_cny);
  if (!Number.isFinite(amount))
    return res.status(400).json({ ok: false, error: "amount_cny 无效" });

  const planRow = await pool.query(
    `SELECT id, raw->>'factory_bill_current_version' AS factory_bill_current_version
       FROM shipping_plans
      WHERE _id = $1 OR id::text = $1
      LIMIT 1`,
    [String(plan_id)]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const numericId = planRow.rows[0].id;
  const currentVersion = parseInt(planRow.rows[0].factory_bill_current_version || "0", 10) || 0;
  const newVersion = currentVersion + 1;
  const billVersion = {
    version: newVersion,
    amount_cny: amount,
    pdf_url: pdf_url || null,
    note: note || null,
    sent_by: sent_by || null,
    sent_at: new Date().toISOString(),
  };

  await pool.query(
    `UPDATE shipping_plans SET raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object(
       'factory_bill_versions', COALESCE(raw->'factory_bill_versions','[]'::jsonb) || jsonb_build_array($1::jsonb),
       'factory_bill_current_version', $2::text,
       'finance_bill_sent_at', to_char(now(),'YYYY-MM-DD HH24:MI'),
       'finance_bill_sent_by', $3::text
     ), updated_at = now()
     WHERE id = $4`,
    [JSON.stringify(billVersion), String(newVersion), sent_by || null, numericId]
  );

  await emitBillTask(pool, numericId, newVersion, amount);
  return res.json({ ok: true, version: newVersion });
}

// ── POST /confirm-factory-bill (工厂 token) ───────────────────
async function handleConfirmFactoryBill(req, res, pool) {
  const { token, version } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'factory_booking'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!rows.length)
    return res.status(403).json({ ok: false, error: "链接无效或已过期" });

  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(500).json({ ok: false, error: "链接数据异常" });

  const billRes = await pool.query(
    `SELECT raw->>'factory_bill_current_version' AS factory_bill_current_version,
            raw->'factory_bill_versions' AS factory_bill_versions
       FROM shipping_plans
      WHERE id = $1
      LIMIT 1`,
    [planId]
  );
  if (!billRes.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const currentVersion = parseInt(billRes.rows[0].factory_bill_current_version || "0", 10) || 0;
  const confirmVersion = parseInt(version || currentVersion, 10);
  if (!confirmVersion) return res.status(400).json({ ok: false, error: "无可确认账单版本" });

  const versions = Array.isArray(billRes.rows[0].factory_bill_versions)
    ? billRes.rows[0].factory_bill_versions
    : [];
  const idx = versions.findIndex(v => parseInt(v && v.version, 10) === confirmVersion);
  if (idx < 0) return res.status(404).json({ ok: false, error: "找不到账单版本" });

  const confirmedAt = new Date().toISOString();
  const nextVersions = versions.map((v, i) => i === idx
    ? { ...v, confirmed_at: confirmedAt, confirmed_by: "factory" }
    : v);

  await pool.query(
    `UPDATE shipping_plans
        SET raw = jsonb_set(COALESCE(raw,'{}'::jsonb), '{factory_bill_versions}', $1::jsonb, true) ||
                  jsonb_build_object(
                    'factory_bill_confirmed_at', to_char(now(),'YYYY-MM-DD HH24:MI'),
                    'factory_bill_confirmed_by', 'factory'
                  ),
            updated_at = now()
      WHERE id = $2`,
    [JSON.stringify(nextVersions), planId]
  );

  await pool.query(
    `UPDATE tasks
        SET status = 'done', updated_at = NOW()
      WHERE raw->>'plan_id' = $1
        AND task_type = '账单确认'
        AND status <> 'done'`,
    [String(planId)]
  );

  return res.json({ ok: true });
}

async function emitBillTask(pool, planId, version, amountCny) {
  try {
    const { rows } = await pool.query(
      `SELECT _id, shipment_no FROM shipping_plans WHERE id = $1 LIMIT 1`, [planId]);
    if (!rows.length) return;
    const { _id, shipment_no } = rows[0];
    const taskId = 't-bill-' + Date.now().toString(36);
    await pool.query(
      `INSERT INTO tasks (id, title, task_type, level, status, risk_level, raw, created_at, updated_at)
       VALUES ($1, $2, '账单确认', 'logi', 'open', 'mid', $3::jsonb, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [taskId,
       `待确认账单 · ${shipment_no || _id} · CNY ${Number(amountCny).toLocaleString()}`,
       JSON.stringify({ plan_id: String(planId), plan_business_id: _id, version, amount_cny: amountCny })
      ]
    );
  } catch (e) {
    console.error('[emitBillTask]', e.message);
  }
}

// ── GET /party-defaults ──────────────────────────────────────────────────────
// Returns per-party default company from collab_party_defaults.
async function handlePartyDefaults(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const r = await pool.query(
    `SELECT party_type, company_id, company_cn FROM collab_party_defaults ORDER BY updated_at DESC`
  );
  const defaults = {};
  for (const row of r.rows) {
    if (!defaults[row.party_type]) {
      defaults[row.party_type] = { id: row.company_id, cn: row.company_cn };
    }
  }
  return res.json({ ok: true, defaults });
}

// ── POST /set-party-default ──────────────────────────────────────────────────
// Upsert a default party company into collab_party_defaults.
async function handleSetPartyDefault(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { party_type, company_id, company_cn } = req.body || {};
  if (!party_type || !company_id) return res.status(400).json({ ok: false, error: "party_type/company_id 必填" });
  await pool.query(
    `INSERT INTO collab_party_defaults (party_type, company_id, company_cn, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (party_type) DO UPDATE
       SET company_id = EXCLUDED.company_id,
           company_cn = EXCLUDED.company_cn,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
    [party_type, company_id, company_cn || "", req.user && req.user.username ? req.user.username : "admin"]
  );
  return res.json({ ok: true });
}

function normBillCode(v) { return String(v || "").trim(); }

function uniqBillVals(arr) { return [...new Set(arr.map(normBillCode).filter(Boolean))]; }

function noBillSummary(direction) {
  return {
    status: "no_bill", label: "无账单", tone: "gray",
    line_count: 0, total: 0, confirmed_at: null,
    paid_status: "unpaid", reconciled: false, direction,
  };
}

function billHasCollabPending(row) {
  const pending = row && row.collab_pending;
  if (!pending) return false;
  if (typeof pending === "string") return pending.trim() !== "" && pending.trim() !== "{}";
  if (typeof pending === "object") return Object.keys(pending).length > 0;
  return true;
}

function partyBillSummary(rows, direction) {
  const totalField = direction === "receivable" ? "sale_amount" : "amount";
  const statusField = direction === "receivable" ? "ar_status" : "ap_status";
  const amountRows = rows.filter(r => Number(r[totalField] || 0) > 0);
  const lineCount = amountRows.length;
  if (!lineCount) return noBillSummary(direction);

  const total = amountRows.reduce((sum, r) => sum + Number(r[totalField] || 0), 0);
  const confirmed = amountRows.filter(r => r.confirmed_at && !billHasCollabPending(r)).length;
  const reconciledCount = amountRows.filter(r => r.reconciled === true).length;
  const paidCount = amountRows.filter(r => String(r[statusField] || "").toLowerCase() === "paid").length;
  const rawStatuses = uniqBillVals(amountRows.map(r => String(r[statusField] || "unpaid").toLowerCase() || "unpaid"));
  const paidStatus = paidCount === lineCount ? "paid" : paidCount > 0 ? "partial" : (rawStatuses.length === 1 ? rawStatuses[0] : "partial");

  let status;
  let label;
  let tone;
  if (paidCount === lineCount) {
    status = direction === "receivable" ? "received" : "paid";
    label = direction === "receivable" ? "已收款" : "已付款";
    tone = "green";
  } else if (confirmed < lineCount) {
    status = "pending_confirm";
    label = confirmed > 0 ? `${confirmed}/${lineCount}已确认` : "待确认";
    tone = "yellow";
  } else if (reconciledCount === lineCount) {
    status = "reconciled";
    label = "已核对";
    tone = "green";
  } else {
    status = "confirmed";
    label = "对方已确认";
    tone = "yellow";
  }

  return {
    status, label, tone,
    line_count: lineCount,
    total,
    confirmed_at: amountRows.map(r => r.confirmed_at).filter(Boolean).sort().at(-1) || null,
    paid_status: paidStatus,
    reconciled: lineCount > 0 && reconciledCount === lineCount,
    direction,
  };
}

function partyKeyFromFactoryLabel(label) {
  const s = String(label || "").trim();
  return s ? `factory_${s}` : "factory";
}

function companyCodeMatches(a, b) {
  return normBillCode(a) && normBillCode(a) === normBillCode(b);
}

// ── GET /party-billing-status?plan_id=xxx ───────────────────────────────────
// Read-only billing badges from active_freight_supplier_bills; shipping_plans.party_billing is ignored.
async function handlePartyBillingStatus(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const spColR = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'shipping_plans'`);
  const spCols = new Set(spColR.rows.map(row => row.column_name));
  const spCol = (name) => spCols.has(name) ? `sp.${name}` : `NULL`;
  const companyJoin = (alias, col) => spCols.has(col) ? `LEFT JOIN companies ${alias} ON ${alias}.id = sp.${col}` : `LEFT JOIN companies ${alias} ON false`;
  const r = await pool.query(
    `SELECT sp.id, sp._id, sp.bl_no, sp.hbl_no,
            ${spCol("forwarder_company_id")} AS forwarder_company_id,
            ${spCol("trucking_company_id")} AS trucking_company_id,
            ${spCol("customs_broker_id")} AS customs_broker_id,
            ${spCol("customer_company_id")} AS customer_company_id,
            ${spCol("intermediary_company_id")} AS intermediary_company_id,
            ${spCol("exporter_company_id")} AS exporter_company_id,
            cf.code AS forwarder_code, ct.code AS trucking_code, cb.code AS broker_code,
            cc.code AS customer_code, ci.code AS intermediary_code, ce.code AS exporter_code,
            COALESCE(ce.name_cn, ce.name_en) AS exporter_name
       FROM shipping_plans sp
       ${companyJoin("cf", "forwarder_company_id")}
       ${companyJoin("ct", "trucking_company_id")}
       ${companyJoin("cb", "customs_broker_id")}
       ${companyJoin("cc", "customer_company_id")}
       ${companyJoin("ci", "intermediary_company_id")}
       ${companyJoin("ce", "exporter_company_id")}
      WHERE sp._id = $1 OR sp.id::text = $1
      LIMIT 1`, [String(planId)]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const plan = r.rows[0];
  const blNo = plan.bl_no || plan.hbl_no;
  if (!blNo) return res.json({ ok: true, party_billing: {} });

  const fsbColR = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'freight_supplier_bills'`);
  const fsbCols = new Set(fsbColR.rows.map(row => row.column_name));
  const optional = (name, fallback = "NULL") => fsbCols.has(name) ? `b.${name}` : `${fallback} AS ${name}`;
  const bills = await pool.query(
    `SELECT b.id, b.bl_no, b.cost_category, b.amount, b.sale_amount,
            b.supplier_company_code, b.payer_company_code,
            b.confirmed_at, b.reconciled, b.ap_status, b.ap_paid_amount, b.ar_status, b.ar_paid_amount,
            ${optional("rebill_to_type")}, ${optional("rebill_to_name")}, ${optional("rebill_to_code")},
            b.raw->'collab_pending' AS collab_pending
       FROM active_freight_supplier_bills b
      WHERE b.bl_no = $1
      ORDER BY b.id`, [blNo]);
  const rows = bills.rows;

  const factoryCodeR = await pool.query(
    `SELECT DISTINCT
            COALESCE(c_id.code, NULLIF(o.factory_code, ''), c_name.code) AS code,
            COALESCE(c_id.name_cn, c_id.name_en, c_name.name_cn, c_name.name_en, o.factory) AS label
       FROM orders o
       LEFT JOIN companies c_id ON c_id.id = o.factory_company_id
       LEFT JOIN companies c_name ON c_name.name_cn = o.factory OR c_name.name_en = o.factory
      WHERE o.shipping_plan_id = $1`, [plan.id]);
  const factoryCodes = factoryCodeR.rows.map(row => ({ code: normBillCode(row.code), label: String(row.label || "").trim() })).filter(row => row.code || row.label);
  let factoryRows = [];
  try {
    factoryRows = await derivePlanFactories(pool, plan.id);
  } catch (_) {
    factoryRows = [];
  }
  const supplierRows = (code) => rows.filter(row => code && companyCodeMatches(row.supplier_company_code, code) && Number(row.amount || 0) > 0);
  const payerRows = (code) => rows.filter(row => code && companyCodeMatches(row.payer_company_code, code) && Number(row.sale_amount || 0) > 0);
  const factorySupplierCodes = uniqBillVals(factoryCodes.map(row => row.code));
  const party_billing = {
    factory: partyBillSummary(rows.filter(row => factorySupplierCodes.includes(normBillCode(row.supplier_company_code)) && Number(row.amount || 0) > 0), "payable"),
    ocean: partyBillSummary(supplierRows(plan.forwarder_code), "payable"),
    trucking: partyBillSummary(supplierRows(plan.trucking_code), "payable"),
    broker: partyBillSummary(supplierRows(plan.broker_code), "payable"),
    intermediary: partyBillSummary(supplierRows(plan.intermediary_code), "payable"),
    customer: partyBillSummary(payerRows(plan.customer_code), "receivable"),
    exporter: noBillSummary("receivable"),
  };

  for (const f of factoryRows) {
    const label = String(f.label || "").trim();
    const hit = factoryCodes.find(row => row.label === label) || factoryCodes.find(row => label && row.label && (row.label.includes(label) || label.includes(row.label)));
    party_billing[partyKeyFromFactoryLabel(label)] = partyBillSummary(hit && hit.code ? supplierRows(hit.code) : [], "payable");
  }

  if (plan.exporter_code) {
    const exporterName = String(plan.exporter_name || "").trim();
    const exporterRows = payerRows(plan.exporter_code).filter(row =>
      companyCodeMatches(row.rebill_to_code, plan.exporter_code) ||
      (exporterName && String(row.rebill_to_name || "").includes(exporterName)) ||
      String(row.rebill_to_type || "").toLowerCase() === "exporter"
    );
    party_billing.exporter = partyBillSummary(exporterRows, "receivable");
  }

  return res.json({ ok: true, party_billing });
}

// ── POST /set-party-billing ─────────────────────────────────────────────────
async function handleSetPartyBilling(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, party, billed, paid } = req.body || {};
  const allowed = new Set(["factory", "ocean", "customer", "trucking", "broker", "intermediary", "exporter"]);
  if (!plan_id || !party) return res.status(400).json({ ok: false, error: "plan_id/party 必填" });
  if (!allowed.has(party)) return res.status(400).json({ ok: false, error: "party 无效" });

  const r = await pool.query(
    `SELECT id, COALESCE(party_billing, '{}'::jsonb) AS party_billing
       FROM shipping_plans
      WHERE _id = $1 OR id::text = $1
      LIMIT 1`, [String(plan_id)]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const partyBilling = (typeof r.rows[0].party_billing === "string"
    ? JSON.parse(r.rows[0].party_billing)
    : r.rows[0].party_billing) || {};
  partyBilling[party] = {
    billed: !!billed,
    paid: !!paid,
    amount: null,
    source: "manual",
    updated_at: new Date().toISOString(),
    updated_by: req.user && req.user.username ? req.user.username : "admin",
  };
  await pool.query(
    `UPDATE shipping_plans
        SET party_billing = $2::jsonb
      WHERE id = $1`,
    [r.rows[0].id, JSON.stringify(partyBilling)]
  );
  return res.json({ ok: true, party_billing: partyBilling });
}

export { handleSetFactoryBill, handleConfirmFactoryBill, handlePartyDefaults, handleSetPartyDefault, handlePartyBillingStatus, handleSetPartyBilling };
