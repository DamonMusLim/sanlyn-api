// api/db/factory-invoice-gaps.js
// 工厂进项票门户的读查询层（从 factory-portal.js 抽出，遵守单文件 ≤500 行铁律）。
//   - getFactoryInfo：按 companies.code 取工厂/销售方信息
//   - fetchGaps：按工厂拉「缺进项票」的退税缺口 + 开票行计算（购买方=issuing_company）
//   - fetchUploaded：拉该工厂已通过门户上传的进项票
// 纯读层：只接收 pool 参数，不依赖路由/鉴权，无副作用。

export async function getFactoryInfo(pool, factoryCode) {
  const code = String(factoryCode || "").trim();
  if (!code) return null;
  const r = await pool.query(
    `SELECT id, code, name_cn, factory_name, tax_id, address, contact_phone, bank_name, bank_account
       FROM companies
      WHERE code = $1
      LIMIT 1`,
    [code]
  );
  const row = r.rows[0];
  if (!row) return null;
  const name = row.name_cn || row.factory_name || code;
  return {
    id: row.id,
    code: row.code || code,
    name,
    tax_id: row.tax_id || null,
    address: row.address || null,
    contact_phone: row.contact_phone || null,
    bank_name: row.bank_name || null,
    bank_account: row.bank_account || null,
  };
}

function normalizeItems(raw) {
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  return items.map((it) => ({
    name_cn: it.name_cn || it.name || it.product_name || "",
    qty1_kg: it.qty1 ?? it.qty_kg ?? it.weight_kg ?? null,
    qty2_ctn: it.qty2 ?? it.qty_ctn ?? it.cartons ?? null,
  }));
}

export async function fetchGaps(pool, factoryCode, factoryName) {
  const sellerInfo = await getFactoryInfo(pool, factoryCode);
  const r = await pool.query(
    `WITH gap_rows AS (
       SELECT r.contract_no, r.customs_no, r.raw, r.rebate_expected, r.fob_cny,
              MAX(NULLIF(BTRIM(o.issuing_company), '')) AS issuing_company
         FROM finance_export_rebates r
         JOIN orders o ON o.contract_no = r.contract_no
        WHERE (o.factory_code = $1 OR o.factory = $2)
          AND (r.invoice_nos IS NULL OR cardinality(r.invoice_nos) = 0)
        GROUP BY r.contract_no, r.customs_no, r.raw, r.rebate_expected, r.fob_cny
     ),
     line_rows AS (
       SELECT o.contract_no,
              oli.hs_code,
              oli.declaration_name,
              SUM(COALESCE(oli.qty_ctn, 0)) AS qty_ctn,
              MAX(COALESCE(oli.factory_price, oli.unit_price, 0)) AS unit_price_incl_tax,
              SUM(COALESCE(
                oli.factory_subtotal,
                oli.subtotal,
                COALESCE(oli.qty_ctn, 0) * COALESCE(oli.factory_price, oli.unit_price, 0),
                0
              )) AS subtotal_incl_tax,
              CASE WHEN COALESCE(oli.hs_code, '') LIKE '2309%' THEN 0.09 ELSE 0.13 END AS tax_rate,
              MIN(oli.sort_order) AS sort_min,
              MIN(oli.id) AS id_min
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         JOIN gap_rows g ON g.contract_no = o.contract_no
        GROUP BY o.contract_no, oli.hs_code, oli.declaration_name
     ),
     invoice_line_rows AS (
       SELECT o.contract_no,
              oli.declaration_name,
              CASE WHEN COALESCE(oli.hs_code, '') LIKE '2309%' THEN 0.09 ELSE 0.13 END AS tax_rate,
              SUM(COALESCE(oli.qty_ctn, 0) * COALESCE(NULLIF(oli.bg_bx, 0), 1)) AS qty_bags,
              MIN(oli.sort_order) AS sort_min,
              MIN(oli.id) AS id_min
         FROM order_line_items oli
         JOIN orders o ON o.id = oli.order_id
         JOIN gap_rows g ON g.contract_no = o.contract_no
        GROUP BY o.contract_no, oli.declaration_name,
                 CASE WHEN COALESCE(oli.hs_code, '') LIKE '2309%' THEN 0.09 ELSE 0.13 END
     )
     SELECT g.contract_no, g.customs_no, g.raw, g.rebate_expected, g.fob_cny,
            g.issuing_company,
            bc.id AS buyer_company_id, bc.name_cn AS buyer_name, bc.tax_id AS buyer_tax_id,
            bc.address AS buyer_address,
            COALESCE(SUM(l.subtotal_incl_tax), 0) AS total_incl_tax,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'hs_code', l.hs_code,
                  'declaration_name', l.declaration_name,
                  'qty_ctn', l.qty_ctn,
                  'unit_price_incl_tax', l.unit_price_incl_tax,
                  'subtotal_incl_tax', l.subtotal_incl_tax,
                  'tax_rate', l.tax_rate
                )
                ORDER BY l.sort_min, l.id_min
              ) FILTER (WHERE l.contract_no IS NOT NULL),
              '[]'::jsonb
            ) AS lines,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object(
                  'goods_name', il.declaration_name,
                  'unit', '包',
                  'qty_bags', il.qty_bags,
                  'tax_rate', il.tax_rate
                )
                ORDER BY il.sort_min, il.id_min
              )
              FROM invoice_line_rows il
              WHERE il.contract_no = g.contract_no
            ), '[]'::jsonb) AS invoice_lines
       FROM gap_rows g
       LEFT JOIN line_rows l ON l.contract_no = g.contract_no
       LEFT JOIN companies bc ON bc.name_cn = g.issuing_company
      GROUP BY g.contract_no, g.customs_no, g.raw, g.rebate_expected, g.fob_cny,
               g.issuing_company, bc.id, bc.name_cn, bc.tax_id, bc.address
      ORDER BY g.contract_no DESC`,
    [factoryCode, factoryName]
  );

  return r.rows.map((row) => {
    const raw = row.raw || {};
    const lines = Array.isArray(row.lines) ? row.lines : [];
    const rawInvoiceLines = Array.isArray(row.invoice_lines) ? row.invoice_lines : [];
    const totalInclTax = Number(row.total_incl_tax) || 0;
    const fobCny = Number(row.fob_cny) || 0;
    const amountWarning = fobCny > 0 && Math.abs(totalInclTax - fobCny) > 5;
    const totalIncl = fobCny;
    const qtyTotal = rawInvoiceLines.reduce((s, l) => s + Math.max(Number(l.qty_bags) || 0, 0), 0);
    const invoiceLines = rawInvoiceLines.map((l, idx) => {
      const qty = Math.max(Number(l.qty_bags) || 0, 0);
      const rate = Number(l.tax_rate) || 0.13;
      const lineIncl = qtyTotal > 0
        ? (idx === rawInvoiceLines.length - 1
          ? totalIncl - rawInvoiceLines.slice(0, idx).reduce((s, x) => s + (Math.max(Number(x.qty_bags) || 0, 0) / qtyTotal) * totalIncl, 0)
          : totalIncl * qty / qtyTotal)
        : 0;
      const subtotalEx = Math.round((lineIncl / (1 + rate)) * 100) / 100;
      const taxAmount = Math.round((lineIncl - subtotalEx) * 100) / 100;
      return {
        goods_name: l.goods_name || "",
        unit: "包",
        qty_bags: qty,
        tax_rate: rate,
        subtotal_ex: subtotalEx,
        tax_amount: taxAmount,
        unit_price_ex: qty > 0 ? subtotalEx / qty : null,
      };
    });
    const amountEx = invoiceLines.reduce((s, l) => s + (Number(l.subtotal_ex) || 0), 0);
    const taxAmount = Math.round((totalIncl - amountEx) * 100) / 100;
    const buyerMissing = !row.issuing_company || !row.buyer_company_id || !row.buyer_tax_id;
    const sellerMissing = !sellerInfo || !sellerInfo.tax_id;
    return {
      contract_no: row.contract_no,
      customs_no: row.customs_no,
      issuing_company: row.issuing_company || null,
      goods: normalizeItems(raw),
      lines,
      invoice_lines: invoiceLines,
      buyer: buyerMissing ? null : {
        name: row.buyer_name,
        tax_id: row.buyer_tax_id,
        address: row.buyer_address || null,
      },
      buyer_missing: buyerMissing,
      seller: sellerInfo ? {
        name: sellerInfo.name,
        tax_id: sellerInfo.tax_id,
        address: sellerInfo.address,
        bank_name: sellerInfo.bank_name,
        bank_account: sellerInfo.bank_account,
      } : null,
      seller_missing: sellerMissing,
      total_incl: totalIncl,
      amount_ex: Math.round(amountEx * 100) / 100,
      tax_amount: taxAmount,
      total_incl_tax: totalInclTax,
      amount_incl_tax: totalIncl || null,
      amount_warning: amountWarning,
      can_invoice: !buyerMissing && !sellerMissing && totalIncl > 0,
      tax_rate: invoiceLines.length ? invoiceLines[0].tax_rate : null,
      tax_rate_label: "按货物适用税率(中宠类9%其余13%)",
      rebate_expected: row.rebate_expected,
    };
  });
}

export async function fetchUploaded(pool, factoryCode) {
  try {
    const r = await pool.query(
      `SELECT id, invoice_no, amount_incl_tax, amount_ex_tax, tax_rate,
              contract_nos, customs_nos, review_status, created_at, attachments
         FROM finance_invoices_in
        WHERE seller_company_code = $1
          AND COALESCE(source, 'factory_portal') = 'factory_portal'
        ORDER BY created_at DESC
        LIMIT 100`,
      [factoryCode]
    );
    return r.rows.map((row) => ({
      id: row.id,
      invoice_no: row.invoice_no,
      amount_ex_tax: row.amount_ex_tax,
      amount_incl_tax: row.amount_incl_tax,
      tax_rate: row.tax_rate,
      contract_nos: row.contract_nos || [],
      customs_nos: row.customs_nos || [],
      review_status: row.review_status || "pending",
      created_at: row.created_at,
      attachments: row.attachments || [],
    }));
  } catch (e) {
    // 老库缺 source 或 attachments 时兜底读取核心字段。
    if (e.code !== "42703") throw e;
    const r = await pool.query(
      `SELECT id, invoice_no, amount_incl_tax, amount_ex_tax, tax_rate,
              contract_nos, customs_nos, review_status, created_at
         FROM finance_invoices_in
        WHERE seller_company_code = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [factoryCode]
    );
    return r.rows.map((row) => ({
      id: row.id,
      invoice_no: row.invoice_no,
      amount_ex_tax: row.amount_ex_tax,
      amount_incl_tax: row.amount_incl_tax,
      tax_rate: row.tax_rate,
      contract_nos: row.contract_nos || [],
      customs_nos: row.customs_nos || [],
      review_status: row.review_status || "pending",
      created_at: row.created_at,
      attachments: [],
    }));
  }
}
// 本次改动：fetchGaps 返回 issuing_company 供工厂确认门户过滤巴匕单。
