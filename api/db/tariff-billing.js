function normDate(v) {
  if (!v) return new Date().toISOString().slice(0, 10);
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

function normContainerType(v) {
  const s = String(v || "").toUpperCase();
  if (/20/.test(s)) return "20GP";
  if (/40/.test(s) && /(HQ|HC|HDG|HIGH)/.test(s)) return "40HQ";
  if (/40/.test(s)) return "40GP";
  return "40HQ";
}

function containerQty(p) {
  const n = Number(p?.container_qty);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export async function loadPortChargeBillingPolicy(pool, companyCode, rateDate) {
  if (!companyCode) return null;
  try {
    const r = await pool.query(
      `SELECT company_code, billing_mode, requires_official_rate, effective_from, effective_to, notes
       FROM company_billing_policies
       WHERE company_code = $1
         AND fee_domain = 'port_charge'
         AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to >= $2::date)
       ORDER BY effective_from DESC, id DESC
       LIMIT 1`,
      [companyCode, normDate(rateDate)]
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

export async function buildOfficialPortChargePricing(pool, p, companyCode) {
  const rateDate = normDate(p?.etd || p?.atd || p?.created_at);
  const policy = await loadPortChargeBillingPolicy(pool, companyCode, rateDate);
  if (!policy || policy.billing_mode !== "pass_through") return null;

  const ctype = normContainerType(p?.container_type);
  const cqty = containerQty(p);
  const q = await pool.query(
    `WITH candidates AS (
       SELECT
         cts.charge_item_code, cts.charge_item_name, cts.raw_item_name,
         cts.amount_cny, cts.unit_basis, cts.required_flag, cts.conditional_flag,
         cts.source_doc, cts.valid_from, cts.valid_to, ctv.version,
         row_number() OVER (
           PARTITION BY cts.charge_item_code
           ORDER BY cts.valid_from DESC, cts.amount_cny DESC, cts.id DESC
         ) AS rn
       FROM carrier_tariff_standards cts
       JOIN carrier_tariff_versions ctv ON ctv.id = cts.version_id
       WHERE cts.review_status = 'confirmed'
         AND ctv.import_status = 'active'
         AND cts.required_flag = true
         AND cts.conditional_flag = false
         AND cts.container_type = $3
         AND cts.valid_from <= $4::date
         AND (cts.valid_to IS NULL OR cts.valid_to >= $4::date)
         AND (CASE
           WHEN cts.carrier ~* '^(EMC|EVERGREEN|长荣)' THEN 'EMC'
           WHEN cts.carrier ~* '^(COSCO|中远|中遠)' THEN 'COSCO'
           WHEN cts.carrier ~* '^(OOCL|东方海外|東方海外)' THEN 'OOCL'
           WHEN cts.carrier ~* '^(MSK|MAERSK|马士基|馬士基)' THEN 'MSK'
           WHEN cts.carrier ~* '^(CMA|达飞|達飛)' THEN 'CMA'
           WHEN cts.carrier ~* '^(ONE|Ocean Network Express)' THEN 'ONE'
           WHEN cts.carrier ~* '^(YML|YANG MING|阳明|陽明)' THEN 'YML'
           WHEN cts.carrier ~* '^(HMM|现代|現代)' THEN 'HMM'
           WHEN cts.carrier ~* '^(HPL|HAPAG|赫伯罗特|赫伯羅特)' THEN 'HPL'
           WHEN cts.carrier ~* '^(MSC|地中海)' THEN 'MSC'
           ELSE UPPER(NULLIF(cts.carrier,''))
         END) = (CASE
           WHEN $1 ~* '^(EMC|EVERGREEN|长荣)' THEN 'EMC'
           WHEN $1 ~* '^(COSCO|中远|中遠)' THEN 'COSCO'
           WHEN $1 ~* '^(OOCL|东方海外|東方海外)' THEN 'OOCL'
           WHEN $1 ~* '^(MSK|MAERSK|马士基|馬士基)' THEN 'MSK'
           WHEN $1 ~* '^(CMA|达飞|達飛)' THEN 'CMA'
           WHEN $1 ~* '^(ONE|Ocean Network Express)' THEN 'ONE'
           WHEN $1 ~* '^(YML|YANG MING|阳明|陽明)' THEN 'YML'
           WHEN $1 ~* '^(HMM|现代|現代)' THEN 'HMM'
           WHEN $1 ~* '^(HPL|HAPAG|赫伯罗特|赫伯羅特)' THEN 'HPL'
           WHEN $1 ~* '^(MSC|地中海)' THEN 'MSC'
           ELSE UPPER(NULLIF($1,''))
         END)
         AND (CASE
           WHEN cts.port ~* '青岛|青島|QINGDAO|TAO' THEN 'QINGDAO'
           WHEN cts.port ~* '厦门|廈門|XIAMEN|XMN' THEN 'XIAMEN'
           WHEN cts.port ~* '上海|SHANGHAI|SHA' THEN 'SHANGHAI'
           WHEN cts.port ~* '宁波|寧波|NINGBO|NGB' THEN 'NINGBO'
           WHEN cts.port ~* '深圳|SHEKOU|YANTIAN|SHENZHEN|蛇口|盐田|鹽田' THEN 'SHENZHEN'
           WHEN cts.port ~* '广州|廣州|NANSHA|GUANGZHOU|南沙' THEN 'GUANGZHOU'
           WHEN cts.port ~* '天津|TIANJIN|XINGANG|新港' THEN 'TIANJIN'
           ELSE UPPER(NULLIF(cts.port,''))
         END) = (CASE
           WHEN $2 ~* '青岛|青島|QINGDAO|TAO' THEN 'QINGDAO'
           WHEN $2 ~* '厦门|廈門|XIAMEN|XMN' THEN 'XIAMEN'
           WHEN $2 ~* '上海|SHANGHAI|SHA' THEN 'SHANGHAI'
           WHEN $2 ~* '宁波|寧波|NINGBO|NGB' THEN 'NINGBO'
           WHEN $2 ~* '深圳|SHEKOU|YANTIAN|SHENZHEN|蛇口|盐田|鹽田' THEN 'SHENZHEN'
           WHEN $2 ~* '广州|廣州|NANSHA|GUANGZHOU|南沙' THEN 'GUANGZHOU'
           WHEN $2 ~* '天津|TIANJIN|XINGANG|新港' THEN 'TIANJIN'
           ELSE UPPER(NULLIF($2,''))
         END)
     )
     SELECT * FROM candidates WHERE rn = 1 ORDER BY charge_item_code`,
    [p?.carrier_code || p?.shipping_line || "", p?.pol || "", ctype, rateDate]
  );

  if (!q.rows.length) {
    const snapshot = {
      mode: "pass_through",
      ok: false,
      error: "missing_official_standard",
      company_code: companyCode,
      carrier: p?.carrier_code || p?.shipping_line || "",
      port: p?.pol || "",
      container_type: ctype,
      container_qty: cqty,
      rate_date: rateDate,
    };
    return { policy, rows: [], snapshot, missingOfficial: true };
  }

  const rows = q.rows.map(r => {
    const qty = r.unit_basis === "container" || r.unit_basis === "seal" ? cqty : 1;
    const unitPrice = Number(r.amount_cny);
    return {
      cost_category: r.charge_item_name || r.raw_item_name,
      charge_basis: r.unit_basis === "container" ? "每柜" : "整票",
      currency: "CNY",
      qty,
      unit_price: unitPrice,
      amount: Number((unitPrice * qty).toFixed(2)),
      official_standard: {
        charge_item_code: r.charge_item_code,
        version: r.version,
        source_doc: r.source_doc,
        valid_from: normDate(r.valid_from),
        valid_to: r.valid_to ? normDate(r.valid_to) : null,
      },
    };
  });
  const snapshot = {
    mode: "pass_through",
    ok: true,
    company_code: companyCode,
    carrier: p?.carrier_code || p?.shipping_line || "",
    port: p?.pol || "",
    container_type: ctype,
    container_qty: cqty,
    rate_date: rateDate,
    versions: [...new Set(q.rows.map(r => r.version))],
    items: rows.map(r => ({ ...r.official_standard, qty: r.qty, unit_price: r.unit_price, amount: r.amount })),
  };
  return { policy, rows, snapshot, missingOfficial: false };
}

export async function savePortChargeSnapshot(pool, planId, snapshot) {
  if (!planId || !snapshot) return;
  try {
    await pool.query(
      `UPDATE shipping_plans
       SET port_charge_pricing_mode = $2,
           port_charge_standard_version = $3,
           port_charge_standard_snapshot = $4::jsonb
       WHERE id = $1`,
      [planId, snapshot.mode || null, (snapshot.versions || [])[0] || null, JSON.stringify(snapshot)]
    );
  } catch (_) {}
}
