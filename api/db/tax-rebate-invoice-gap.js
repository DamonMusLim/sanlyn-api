// tax-rebate-invoice-gap.js — 催票差额计算（应开金额=Σ工厂含税小计 vs 已收进项票）
// 由 tax-rebate.js GET 调用；一次性批量算，禁止 N+1。
// 契约字段（前端协同表依赖，不可改名）：
//   invoice_due_amount / invoice_received_amount / invoice_gap / invoice_gap_factories

function splitFerContracts(contractNo) {
  return [...new Set(String(contractNo || "")
    .split(/[\/,，;；\s]+/)
    .map(s => s.trim())
    .filter(Boolean))];
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function addFactory(factoryMap, factory, factoryCode, brand, isOwnBrand, due) {
  const key = JSON.stringify([factory || "", factoryCode || "", brand || ""]);
  if (!factoryMap.has(key)) {
    factoryMap.set(key, { factory: factory || null, factory_code: factoryCode || null, brand: brand || null, is_own_brand: !!isOwnBrand, due: 0 });
  }
  factoryMap.get(key).due += Number(due || 0);
}

export async function loadInvoiceGapByCustoms(pool, ferRows) {
  const items = ferRows.map(r => ({
    customs_no: r.customs_no,
    contracts: splitFerContracts(r.contract_no),
  }));
  const allContracts = [...new Set(items.flatMap(x => x.contracts))];
  const allCustomsNos = [...new Set(items.map(x => x.customs_no).filter(Boolean))];

  const dueByContract = new Map();
  const factoriesByContract = new Map();
  const manualExpectedByCustoms = new Map();
  const linkedReceivedByCustoms = new Map();

  // 自有品牌集(company_own_brands): "CODE::BRAND" → 品牌产品;不在集=OEM/代工
  const ownBrandSet = new Set();
  try {
    const ob = await pool.query(`SELECT company_code, UPPER(TRIM(brand)) AS brand FROM company_own_brands WHERE active IS NOT FALSE`);
    for (const r of ob.rows) ownBrandSet.add(`${r.company_code}::${r.brand}`);
  } catch {}

  if (allCustomsNos.length) {
    const statusR = await pool.query(
      `SELECT customs_no, manual_expected_amount
         FROM customs_invoice_status
        WHERE customs_no = ANY($1::text[])
          AND manual_expected_amount IS NOT NULL`,
      [allCustomsNos]
    ).catch(() => ({ rows: [] }));

    for (const r of statusR.rows) {
      manualExpectedByCustoms.set(r.customs_no, Number(r.manual_expected_amount));
    }

    const linkedR = await pool.query(
      `SELECT l.customs_no,
              COUNT(*)::int AS link_count,
              COALESCE(SUM(
                CASE
                  WHEN l.link_status = 'active'
                   AND COALESCE(fii.review_status, '') NOT IN ('void', 'red_ink')
                  THEN COALESCE(fii.amount_incl_tax, 0)
                  ELSE 0
                END
              ), 0)::numeric AS uploaded_amount
         FROM invoice_customs_links l
         LEFT JOIN finance_invoices_in fii ON fii.id = l.invoice_id
        WHERE l.customs_no = ANY($1::text[])
        GROUP BY l.customs_no`,
      [allCustomsNos]
    ).catch(() => ({ rows: [] }));

    for (const r of linkedR.rows) {
      linkedReceivedByCustoms.set(r.customs_no, {
        hasLink: Number(r.link_count || 0) > 0,
        amount: Number(r.uploaded_amount || 0),
      });
    }
  }

  if (allContracts.length) {
    const dueR = await pool.query(
      `SELECT o.contract_no,
              o.factory,
              o.factory_code,
              UPPER(TRIM(COALESCE(NULLIF(TRIM(oli.brand), ''), NULLIF(TRIM(p.brand), '')))) AS brand,
              SUM(COALESCE(oli.factory_subtotal, 0))::numeric AS due
         FROM orders o
         JOIN order_line_items oli ON oli.order_id = o.id
         LEFT JOIN products p ON p.id = oli.product_id
        WHERE o.contract_no = ANY($1::text[])
          AND COALESCE(o.status, '') <> 'cancelled'
        GROUP BY o.contract_no, o.factory, o.factory_code,
                 UPPER(TRIM(COALESCE(NULLIF(TRIM(oli.brand), ''), NULLIF(TRIM(p.brand), ''))))`,
      [allContracts]
    );
    for (const r of dueR.rows) {
      dueByContract.set(r.contract_no, (dueByContract.get(r.contract_no) || 0) + Number(r.due || 0));
      if (!factoriesByContract.has(r.contract_no)) factoriesByContract.set(r.contract_no, []);
      factoriesByContract.get(r.contract_no).push(r);
    }
  }

  const invR = (allContracts.length || allCustomsNos.length)
    ? await pool.query(
        `SELECT amount_incl_tax,
                contract_nos::text AS contract_text,
                customs_nos::text AS customs_text
           FROM finance_invoices_in fi
          WHERE COALESCE(fi.review_status, '') NOT IN ('void', 'red_ink')
            AND (
              ($1::text[] <> '{}'::text[] AND EXISTS (
                SELECT 1 FROM unnest($1::text[]) c
                 WHERE fi.contract_nos::text ILIKE '%' || c || '%'
              ))
              OR ($2::text[] <> '{}'::text[] AND EXISTS (
                SELECT 1 FROM unnest($2::text[]) cn
                 WHERE fi.customs_nos::text LIKE '%' || cn || '%'
              ))
            )`,
        [allContracts, allCustomsNos]
      ).catch(() => ({ rows: [] }))
    : { rows: [] };

  const byCustoms = new Map();
  for (const item of items) {
    const dueContracts = item.contracts.filter(c => dueByContract.has(c));
    const systemDue = dueContracts.length
      ? round2(dueContracts.reduce((sum, c) => sum + Number(dueByContract.get(c) || 0), 0))
      : null;
    const due = manualExpectedByCustoms.has(item.customs_no)
      ? round2(manualExpectedByCustoms.get(item.customs_no))
      : systemDue;

    const factoryMap = new Map();
    for (const c of dueContracts) {
      for (const r of factoriesByContract.get(c) || []) {
        addFactory(factoryMap, r.factory, r.factory_code, r.brand, r.brand && ownBrandSet.has(`${r.factory_code}::${r.brand}`), r.due);
      }
    }
    const invoice_gap_factories = [...factoryMap.values()]
      .map(x => ({ ...x, due: round2(x.due) }))
      .sort((a, b) => String(a.factory || "").localeCompare(String(b.factory || "")));

    const linkedReceived = linkedReceivedByCustoms.get(item.customs_no);
    const received = linkedReceived?.hasLink
      ? round2(linkedReceived.amount)
      : round2(invR.rows.reduce((sum, inv) => {
          const contractText = String(inv.contract_text || "").toLowerCase();
          const customsText = String(inv.customs_text || "");
          const contractHit = item.contracts.some(c => contractText.includes(c.toLowerCase()));
          const customsHit = item.customs_no && customsText.includes(item.customs_no);
          return contractHit || customsHit ? sum + Number(inv.amount_incl_tax || 0) : sum;
        }, 0));

    byCustoms.set(item.customs_no, {
      invoice_due_amount: due,
      invoice_received_amount: received,
      invoice_gap: due == null ? null : Math.max(0, round2(due - received)),
      invoice_gap_factories,
    });
  }

  return byCustoms;
}
