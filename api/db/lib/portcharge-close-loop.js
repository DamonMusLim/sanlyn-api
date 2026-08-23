const CARRIER_ALIASES = new Map([
  ["MAERSK", "MSK"],
  ["MAERSK LINE", "MSK"],
  ["EVERGREEN", "EMC"],
  ["EVERGREEN LINE", "EMC"],
]);

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function cleanText(v) {
  return String(v ?? "").trim();
}

export function normalizeCarrier(v) {
  const s = cleanText(v).toUpperCase();
  return CARRIER_ALIASES.get(s) || s;
}

export function normalizeContainerType(v) {
  const s = cleanText(v).toUpperCase();
  if (/20/.test(s)) return "20GP";
  if (/40/.test(s) && /HQ|HC|HIGH/.test(s)) return "40HQ";
  if (/40/.test(s)) return "40GP";
  return "40HQ";
}

export function docKey(v) {
  return cleanText(v || "NOBL").replace(/[^A-Z0-9]/gi, "").toUpperCase() || "NOBL";
}

function rawObj(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v) || {}; } catch (_) { return {}; }
}

function planTerm(p) {
  const raw = rawObj(p.raw);
  return cleanText(p.trade_terms || p.freight_term || p.incoterm || raw.trade_terms || raw.incoterm).toUpperCase();
}

function isPureFobPlan(p) {
  const term = planTerm(p);
  return term === "FOB" || term === "FCA";
}

export function carrierFromBl(blNo) {
  const s = docKey(blNo);
  if (!s) return "";
  const map = [
    ["COAU", "COSCO"],
    ["MEDU", "MSC"],
    ["OOLU", "OOCL"],
    ["ESLC", "ESL"],
    ["AXI", "CNC"],
    ["TSLK", "TSL"],
    ["YMJA", "YML"],
    ["UAST", "EMC"],
    ["EMIV", "ESL"],
    ["177", "MSC"],
  ];
  const hit = map.find(([prefix]) => s.startsWith(prefix));
  return hit ? hit[1] : "";
}

function chargeQty(unitBasis, containerQty) {
  const b = cleanText(unitBasis).toLowerCase();
  if (["container", "seal"].includes(b)) return Math.max(num(containerQty), 1);
  return 1;
}

function basisText(unitBasis) {
  const b = cleanText(unitBasis).toLowerCase();
  if (b === "container") return "每柜";
  if (b === "seal") return "每封";
  if (b === "day") return "每天";
  return "整票";
}

export async function normalizeChargeName(pool, rawName, carrier = "*", sampleBl = "") {
  const raw = cleanText(rawName);
  if (!raw) return { name: "", unmapped: false };
  const c = normalizeCarrier(carrier || "*") || "*";
  const r = await pool.query(
    `SELECT standard_item_name, standard_item_code
       FROM carrier_tariff_charge_items
      WHERE (normalized_carrier = $1 OR normalized_carrier = '*')
        AND lower(btrim(raw_item_name)) = lower(btrim($2))
      ORDER BY (normalized_carrier = $1) DESC, confidence DESC NULLS LAST
      LIMIT 1`,
    [c, raw]
  );
  if (r.rows.length) {
    return {
      name: r.rows[0].standard_item_name,
      code: r.rows[0].standard_item_code,
      unmapped: false,
      original_name: raw,
    };
  }
  await pool.query(
    `INSERT INTO fee_name_candidates (raw_name, occurrences, sample_bl)
     VALUES ($1, 1, $2)
     ON CONFLICT (raw_name) DO UPDATE SET
       occurrences = fee_name_candidates.occurrences + 1,
       sample_bl = COALESCE(fee_name_candidates.sample_bl, EXCLUDED.sample_bl),
       last_seen_at = now()`,
    [raw, cleanText(sampleBl) || null]
  );
  return { name: raw, unmapped: true, original_name: raw };
}

export async function issueDocNo(pool, { prefix, seed, docType, blNo, totalUsd = 0, totalCny = 0, generatedBy = null, snapshot = {}, docDate = null, noDate = false, noSeq = false }) {
  const today = String(docDate || new Date().toISOString().slice(0, 10)).slice(0, 10).replace(/-/g, ""); // 0813铁则: 单号日期段=出运日
  const base = noDate ? `${prefix}-${docKey(seed)}` : `${prefix}-${docKey(seed)}-${today}`;
  // ⚖️ 2026-08-24 Damon:「前缀 + BL 号,字段表就可以了」——对外单据号不再拼出运日与递增序号。
  //    BL 号本来就是现成字段,号即 `${prefix}-${BL}`。同一票重复出单 = 同一个号(幂等),
  //    不是每点一次生成一个新号(原来 PC-COAU9507915320-20260707-5 那个 -5 就是被点了 5 次)。
  if (noSeq) {
    const exist = await pool.query(`SELECT doc_no FROM doc_issue_log WHERE doc_no = $1 LIMIT 1`, [base]);
    if (exist.rows[0]) return exist.rows[0].doc_no;   // 幂等:已发过就返回原号
    try {
      await pool.query(
        `INSERT INTO doc_issue_log
           (doc_no, bl_no, doc_type, total_usd, total_cny, generated_by, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [base, cleanText(blNo) || null, docType, num(totalUsd), num(totalCny), generatedBy, JSON.stringify(snapshot)]
      );
    } catch (e) {
      if (e?.code !== "23505") throw e;   // 并发下别人先插了,照样返回该号
    }
    return base;
  }

  const r = await pool.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(doc_no, '^.*-([0-9]+)$', '\\1'), doc_no)::int), 0) AS n
       FROM doc_issue_log
      WHERE doc_no = $1 OR doc_no LIKE $2`,
    [base, `${base}-%`]
  );
  const seq = num(r.rows[0]?.n) + 1;
  for (let i = 0; i < 2; i += 1) {
    const docNo = `${base}-${seq + i}`;
    try {
      await pool.query(
        `INSERT INTO doc_issue_log
           (doc_no, bl_no, doc_type, total_usd, total_cny, generated_by, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [docNo, cleanText(blNo) || null, docType, num(totalUsd), num(totalCny), generatedBy, JSON.stringify(snapshot)]
      );
      return docNo;
    } catch (e) {
      if (e?.code !== "23505" || i === 1) throw e;
    }
  }
  throw new Error("doc_no_issue_failed");
}

async function loadTariffFallback(pool, p, containerQty) {
  const raw = rawObj(p.raw);
  const carrier = normalizeCarrier(p.carrier_code || p.shipping_line || p.carrier || raw.carrier || carrierFromBl(p.bl_no || p.shipment_no));
  const port = cleanText(p.pol || "青岛");
  const ct = normalizeContainerType(p.container_type);
  if (!carrier || !port) return { rows: [], warning: "carrier_unresolved" };
  const r = await pool.query(
    `SELECT charge_item_name AS cost_category, amount_cny, unit_basis
       FROM carrier_tariff_standards
      WHERE upper(carrier) = upper($1)
        AND port ILIKE $2
        AND container_type = $3
        AND COALESCE(conditional_flag,false) = false
        AND COALESCE(required_flag,true) = true
        AND review_status IN ('confirmed','pending')
        AND valid_from <= current_date
        AND (valid_to IS NULL OR valid_to >= current_date)
      ORDER BY charge_item_code, valid_from DESC, id DESC`,
    [carrier, port, ct]
  );
  const rows = r.rows.map(row => {
    const qty = chargeQty(row.unit_basis, containerQty);
    const unit = num(row.amount_cny);
    return {
      cost_category: row.cost_category,
      charge_basis: basisText(row.unit_basis),
      currency: "CNY",
      qty,
      unit_price: unit,
      amount: Number((unit * qty).toFixed(2)),
      sale_amount: Number((unit * qty).toFixed(2)),
    };
  });
  return { rows };
}

export async function loadPortChargeIssue(pool, p, opts = {}) {
  const blNo = p.bl_no || p.shipment_no || String(p.id || "");
  const planId = String(p.id || p._id || "");
  const containerQty = Math.max(num(opts.containerQty || p.container_qty), 1);
  const payerCode = cleanText(opts.payerCode);
  const warnings = [];
  const payerSql = `
    SELECT payer_company_code,
           COUNT(*)::int AS line_count,
           COUNT(*) FILTER (WHERE COALESCE(sale_amount,0) > 0)::int AS billable_line_count,
           COUNT(*) FILTER (WHERE sale_amount IS NULL)::int AS missing_sale_amount_count,
           COALESCE(SUM(sale_amount),0)::numeric AS total_cny
      FROM active_freight_supplier_bills
     WHERE (bl_no = $1 OR link_plan_id = $2)
       AND (cost_category !~* '海运|ocean|freight')
       AND UPPER(COALESCE(currency,'CNY')) = 'CNY'
       AND COALESCE(rebill_status,'') NOT IN ('voided','absorbed')
       AND COALESCE(payer_company_code,'') <> ''
     GROUP BY payer_company_code
     ORDER BY payer_company_code`;
  const payers = (await pool.query(payerSql, [blNo, planId])).rows;
  const diagSql = `
    SELECT COUNT(*)::int AS line_count,
           COUNT(*) FILTER (WHERE COALESCE(payer_company_code,'') = '')::int AS missing_payer_count,
           COUNT(*) FILTER (WHERE sale_amount IS NULL)::int AS missing_sale_amount_count,
           COUNT(*) FILTER (WHERE COALESCE(sale_amount,0) > 0)::int AS billable_line_count
      FROM active_freight_supplier_bills
     WHERE (bl_no = $1 OR link_plan_id = $2)
       AND (cost_category !~* '海运|ocean|freight')
       AND UPPER(COALESCE(currency,'CNY')) = 'CNY'
       AND COALESCE(rebill_status,'') NOT IN ('voided','absorbed')`;
  const diag = (await pool.query(diagSql, [blNo, planId])).rows[0] || {};
  if (!payerCode && payers.length > 1) {
    return { needs_payer_selection: true, payers, rows: [], totalCny: 0, usedFallbackCard: false, warnings };
  }
  const selectedPayer = payerCode || payers[0]?.payer_company_code || "";
  let rows = [];
  if (selectedPayer) {
    const r = await pool.query(
      `WITH base AS (
         SELECT cost_category, sale_amount AS amount, sale_amount, currency, charge_basis,
                CASE WHEN NULLIF(raw->>'sale_qty','') ~ '^[0-9]+(\\.[0-9]+)?$'
                     THEN NULLIF(raw->>'sale_qty','')::numeric ELSE NULL END AS raw_sale_qty,
                CASE WHEN NULLIF(raw->>'unit_price','') ~ '^[0-9]+(\\.[0-9]+)?$'
                     THEN NULLIF(raw->>'unit_price','')::numeric ELSE NULL END AS raw_unit_price,
                qty AS column_qty, id
           FROM active_freight_supplier_bills
          WHERE (bl_no = $1 OR link_plan_id = $3)
            AND payer_company_code = $2
            AND (cost_category !~* '海运|ocean|freight')
            AND UPPER(COALESCE(currency,'CNY')) = 'CNY'
            AND COALESCE(sale_amount,0) > 0
            AND COALESCE(rebill_status,'') NOT IN ('voided','absorbed')
       ), normalized AS (
         SELECT *, COALESCE(raw_sale_qty, column_qty) AS bill_qty
           FROM base
       )
       SELECT cost_category, amount, sale_amount, currency, charge_basis,
              bill_qty AS qty,
              COALESCE(
                CASE WHEN bill_qty > 0
                       AND raw_unit_price IS NOT NULL
                       AND ROUND((raw_unit_price * bill_qty)::numeric,2) = ROUND(sale_amount::numeric,2)
                     THEN raw_unit_price ELSE NULL END,
                sale_amount / NULLIF(bill_qty,0)
              ) AS unit_price
         FROM normalized
        ORDER BY id`,
      [blNo, selectedPayer, planId]
    );
    rows = r.rows;
  }
  let usedFallbackCard = false;
  const term = planTerm(p);
  const needsTerms = !term;
  if (!rows.length && needsTerms) warnings.push("terms_missing");
  if (!rows.length && term && !isPureFobPlan(p)) {
    const fallback = await loadTariffFallback(pool, p, containerQty);
    rows = fallback.rows;
    if (fallback.warning) warnings.push(fallback.warning);
    usedFallbackCard = rows.length > 0;
  }
  let dataIssue = null;
  if (!rows.length) {
    const lineCount = num(diag.line_count);
    if (!lineCount) dataIssue = "no_matching_rows";
    else if (!selectedPayer || (num(diag.missing_payer_count) === lineCount && !payers.length)) dataIssue = "missing_payer";
    else if (!num(diag.billable_line_count) && num(diag.missing_sale_amount_count)) dataIssue = "missing_sale_amount";
    else dataIssue = "no_billable_rows";
    warnings.push(dataIssue);
  }
  const totalCny = rows.reduce((s, r) => s + num(r.sale_amount ?? r.amount), 0);
  return {
    factoryCode: selectedPayer,
    rows,
    payers,
    totalCny: Number(totalCny.toFixed(2)),
    usedFallbackCard,
    needs_terms: needsTerms && !rows.length,
    data_issue: dataIssue,
    data_issue_detail: !dataIssue ? null : {
      line_count: num(diag.line_count),
      missing_payer_count: num(diag.missing_payer_count),
      missing_sale_amount_count: num(diag.missing_sale_amount_count),
      billable_line_count: num(diag.billable_line_count),
    },
    warning: warnings[0] || null,
    warnings,
  };
}
