import {
  auditAmountAllocation,
  auditSelectionSource,
  riskMax
} from "./slip-core.js";

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function suffixStrip(s) {
  return s
    .replace(/有限公司/g, "")
    .replace(/\b(CO|COMPANY|LTD|LIMITED|INC|CORP|CORPORATION|SDN|BHD|PTE|LLC)\b/g, "");
}

function normName(v) {
  return suffixStrip(String(v || "").toUpperCase())
    .replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, "")
    .trim();
}

function bigrams(s) {
  const out = new Set();
  const chars = [...s];
  if (chars.length <= 1) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

function similarity(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  if (x.includes(y) || y.includes(x)) return Math.min(1, Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.25);
  const bx = bigrams(x);
  const by = bigrams(y);
  const union = new Set([...bx, ...by]);
  let hit = 0;
  for (const item of bx) if (by.has(item)) hit += 1;
  return union.size ? hit / union.size : 0;
}

async function auditAmount(pool, slip) {
  return auditAmountAllocation(pool, {
    linksTable: "bank_slip_links",
    slipId: slip.id,
    slipAmount: slip.amount
  });
}

async function auditSource(pool, slip) {
  return auditSelectionSource(pool, {
    linksTable: "bank_slip_links",
    slipId: slip.id,
    raw: slip.raw
  });
}

async function auditSenderCustomer(pool, slip) {
  const r = await pool.query(
    `SELECT DISTINCT sp.shipment_no, sp.customer, sp.customer_cn, sp.customer_en
       FROM bank_slip_links l
       JOIN shipping_plans sp ON sp.shipment_no = l.shipment_no
      WHERE l.slip_id=$1 AND l.shipment_no IS NOT NULL`,
    [slip.id]
  );
  let worst = "low";
  const scores = [];
  for (const row of r.rows) {
    const names = [row.customer, row.customer_cn, row.customer_en].filter(Boolean);
    const best = names.reduce((m, name) => Math.max(m, similarity(slip.sender_name, name)), 0);
    let severity = "low";
    if (best < 0.65) severity = "high";
    else if (best < 0.85) severity = "medium";
    worst = riskMax(worst, severity);
    scores.push({ shipment_no: row.shipment_no, best_score: Math.round(best * 100) / 100, customers: names });
  }
  return {
    rule: "sender_customer_match",
    severity: worst,
    message: worst === "low" ? "汇款人与候选订单客户匹配" : "汇款人与候选订单客户相似度偏低",
    sender_name: slip.sender_name || null,
    scores
  };
}

async function auditOverCollection(pool, slip) {
  const r = await pool.query(
    `SELECT l.shipment_no, sp.freight_total_cny,
            COALESCE(SUM(l.amount_alloc),0) AS allocated_total
       FROM bank_slip_links l
       JOIN bank_slips bs ON bs.id = l.slip_id
       JOIN shipping_plans sp ON sp.shipment_no = l.shipment_no
      WHERE l.shipment_no IN (
              SELECT shipment_no FROM bank_slip_links WHERE slip_id=$1 AND shipment_no IS NOT NULL
            )
        AND bs.status IN ('confirmed','pending_review')
      GROUP BY l.shipment_no, sp.freight_total_cny`,
    [slip.id]
  );
  let worst = "low";
  const shipments = [];
  for (const row of r.rows) {
    const expected = money(row.freight_total_cny);
    const allocated = money(row.allocated_total);
    const over = money(allocated - expected);
    const threshold = money(Math.max(10, Math.abs(expected) * 0.005));
    let severity = "low";
    if (over > threshold) severity = "high";
    else if (over > 0) severity = "medium";
    worst = riskMax(worst, severity);
    shipments.push({ shipment_no: row.shipment_no, freight_total_cny: expected, allocated_total: allocated, over_amount: over, threshold, severity });
  }
  return {
    rule: "shipment_over_collection",
    severity: worst,
    message: worst === "low" ? "累计分摊未超过应收海运费" : "累计分摊超过对应 shipment 应收海运费",
    shipments
  };
}

async function auditBeneficiary(pool, slip) {
  const corrected = String(slip.raw?.confirmed_corrected_beneficiary_name || "").trim();
  if (!corrected) return null;
  const like = `%${corrected}%`;
  const r = await pool.query(
    `SELECT 'companies' AS source, code, name_cn, name_en FROM companies
      WHERE code ILIKE $1 OR name_cn ILIKE $1 OR name_en ILIKE $1
     UNION ALL
     SELECT 'seller_profiles' AS source, code, name_cn, name_en FROM seller_profiles
      WHERE code ILIKE $1 OR name_cn ILIKE $1 OR name_en ILIKE $1 OR bank_beneficiary ILIKE $1
     LIMIT 5`,
    [like]
  );
  return {
    rule: "beneficiary_entity_lookup",
    severity: r.rows.length ? "low" : "high",
    message: r.rows.length ? "修正后的收款主体可在主数据中查到" : "修正后的收款主体在公司主数据中查不到",
    corrected_beneficiary_name: corrected,
    matches: r.rows
  };
}

export async function auditBankSlipConfirmation(pool, slipId) {
  const s = await pool.query("SELECT id, amount, sender_name, raw FROM bank_slips WHERE id=$1", [slipId]);
  const slip = s.rows[0];
  if (!slip) throw new Error("bank slip not found");
  const findings = [
    await auditAmount(pool, slip),
    await auditSource(pool, slip),
    await auditSenderCustomer(pool, slip),
    await auditOverCollection(pool, slip),
    await auditBeneficiary(pool, slip)
  ].filter(Boolean);
  const risk_level = findings.reduce((risk, f) => riskMax(risk, f.severity), "low");
  return { risk_level, findings };
}
