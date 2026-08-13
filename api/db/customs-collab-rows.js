// api/db/customs-collab-rows.js — list/query layer (fetchRows + list handlers)
// split out of customs-collab.js (2026-07-14, ≤500-line rule).
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { money } from "./customs-collab-status.js";
import { rangeFromQuery, requireFinance, resolveFactory, rateLimit, json, failClosed } from "./customs-collab-shared.js";
import { scrubFactoryCustomsPayload } from "./lib/collab-field-profiles.js";

export async function fetchRows(pool, opts) {
  const params = [opts.start, opts.end];
  const where = [`b.export_date >= $1::date`, `b.export_date < $2::date`];
  const includeSlipDetails = !!opts.includeSlipDetails;
  const paidAmountExpr = includeSlipDetails ? "COALESCE(bl.amount_alloc,0)" : "COALESCE(bl.amount_alloc, bs.amount)";

  if (opts.factoryCode) {
    params.push(opts.factoryCode);
    where.push(`b.factory_code = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`COALESCE(s.status, CASE WHEN b.system_expected_amount IS NULL THEN 'need_amount' ELSE 'pending_confirm' END) = $${params.length}`);
  }
  if (opts.keyword) {
    params.push(`%${opts.keyword}%`);
    where.push(`(b.customs_no ILIKE $${params.length} OR b.contract_no ILIKE $${params.length})`);
  }

  const sql = `
    WITH ord AS (
      SELECT o.id AS order_id, o.order_no, o.contract_no, o.bl_no,
             o.factory_company_id,   -- 0813：给「按固化工厂收窄」那道闸用
             COALESCE(o.factory_code, c_id.code,
               (SELECT p.factory_code FROM order_line_items x JOIN products p ON p.id=x.product_id
                 WHERE x.order_id=o.id AND p.factory_code IS NOT NULL LIMIT 1)) AS factory_code,
             COALESCE(c.name_cn, c.factory_name, c_id.name_cn, c_id.factory_name, o.factory) AS factory_name,
             o.created_at::date AS order_date,
             CASE WHEN o.order_no ILIKE '%-DG-%'
                  THEN (SELECT NULLIF(SUM(oli.declare_amount_per_box*oli.qty_ctn),0) FROM order_line_items oli WHERE oli.order_id=o.id)
                  ELSE NULL END AS declare_value,
             (SELECT COALESCE(NULLIF(SUM(oli.factory_subtotal),0), NULLIF(SUM(oli.qty_ctn*oli.bg_bx*p.factory_price),0), NULLIF(SUM(oli.qty_ctn*p.factory_price),0)) FROM order_line_items oli LEFT JOIN products p ON p.id=oli.product_id WHERE oli.order_id=o.id) AS factory_expected_value,
             COALESCE((SELECT NULLIF(SUM(oli.factory_subtotal),0) FROM order_line_items oli WHERE oli.order_id=o.id),
                      NULLIF(o.total_amount_factory,0)) AS purchase_value,
             (SELECT NULLIF(SUM(oli.qty_ctn),0) FROM order_line_items oli WHERE oli.order_id=o.id) AS qty_oli,
             (SELECT NULLIF(SUM(oli.subtotal),0) FROM order_line_items oli WHERE oli.order_id=o.id) AS sales_value
        FROM orders o
        LEFT JOIN companies c ON c.code=o.factory_code
        LEFT JOIN companies c_id ON c_id.id=o.factory_company_id
       WHERE (COALESCE(o.status,'') IN ('shipped','delivered','completed','closed','archived','done','received')
              OR COALESCE(o.bl_no,'') <> ''
              -- 🩸 0813：orders.status 靠人维护、必然滞后。40-LL-7 货 8-11 就出了、报关单
              --    422720260000958343 也在，但订单还是 pending 且 bl_no 空 → 整张订单被挡在协同页外，
              --    工厂看不到这票、也没法传票。
              --    【报关单存在 = 已出运】才是铁证，比订单状态可靠，补成第三个入口。
              OR EXISTS (SELECT 1 FROM finance_export_rebates f0
                          WHERE COALESCE(o.contract_no,'') <> ''
                            AND COALESCE(f0.contract_no,'') <> ''
                            AND f0.contract_no LIKE '%'||o.contract_no||'%'))
         AND COALESCE(o.status,'') <> 'cancelled'
    ),
    fer_base AS (
      SELECT fer.customs_no,
             MAX(fer.contract_no) AS contract_no,
             (SELECT NULLIF(array_agg(DISTINCT x.order_no) FILTER (WHERE COALESCE(x.order_no,'') <> ''), '{}'::text[])
                FROM finance_export_rebates fer2
                LEFT JOIN LATERAL jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(fer2.raw->'order_nos')='array' THEN fer2.raw->'order_nos' ELSE '[]'::jsonb END
                ) AS x(order_no) ON true
               WHERE fer2.customs_no=fer.customs_no) AS order_scope,
             MIN(fer.export_date) AS export_date,
             CASE WHEN COUNT(i.item)=0 THEN NULL
                  ELSE ROUND(SUM(NULLIF(i.item->>'amount','')::numeric), 2) END AS declare_amount,
             COALESCE(ROUND(SUM(NULLIF(i.item->>'qty_ctn','')::numeric),2), ROUND(SUM(NULLIF(i.item->>'qty2','')::numeric),2)) AS qty,
             -- 0812：订单认不回报关单时会退回用提单号当 key，同一票就出现两行
             -- （COAU6461510080 和 020220260000869856 各记一次，应开总额虚高 ¥139,285）。
             -- 把报关单自己的提单号带出来，多加一条「按提单号认」的路。
             MAX(NULLIF(sp.bl_no,'')) AS bl_no,
             MAX(NULLIF(sp.so_no,'')) AS so_no
        FROM finance_export_rebates fer
        LEFT JOIN customs_declarations cd0 ON cd0.declaration_no = fer.customs_no
        LEFT JOIN shipping_plans sp ON sp._id = cd0.shipping_plan_id
        LEFT JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
        ) AS i(item) ON true
       GROUP BY fer.customs_no
    ),
    keyed AS (
      SELECT ord.*,
             f.customs_no AS real_customs_no,
             f.declare_amount AS fer_declare,
             f.qty AS fer_qty,
             f.export_date AS fer_export_date,
             COALESCE(f.customs_no, NULLIF(ord.bl_no,''), ord.order_no) AS decl_key
        FROM ord
        LEFT JOIN fer_base f ON (
              (f.order_scope IS NOT NULL AND ord.order_no=ANY(f.order_scope))
           OR (f.order_scope IS NULL AND f.contract_no=ord.contract_no)
           -- ③ 提单号/SO 认回（订单和报关单合同号对不上时唯一能连起来的东西）
           --  🩸 0813 必须带「兄弟单排除」：一份提单常挂多张报关单（MEDUY8325498 挂了
           --     802324/802335/802346 三张），只按提单认会让每张订单同时匹配到全部兄弟单 →
           --     中砂的 40-LL-6 跑到中宠页面上、三行 PO 全被合并成同一串（Damon：「为什么会有重复」）。
           --     所以：该订单如果已经被【别的报关单】按合同号认领了，就不要再用提单号把它拉过来。
           OR (COALESCE(ord.bl_no,'') <> '' AND ord.bl_no IN (f.bl_no, f.so_no)
               AND NOT EXISTS (
                 SELECT 1 FROM finance_export_rebates f9
                  WHERE f9.customs_no <> f.customs_no
                    AND COALESCE(f9.contract_no,'') <> '' AND COALESCE(ord.contract_no,'') <> ''
                    AND f9.contract_no LIKE '%'||ord.contract_no||'%'))
        )
        -- 🔒 0813 再加一道硬闸：这张报关单的逐项工厂如果已经固化，
        --    就只认【这几家工厂】的订单。一份提单挂多张报关单、多张订单又共用同一个合同号时
        --    （FS20260625907 同时是 40-CP-6/40-CP-7 中宠 和 40-LL-6 中砂 的合同），
        --    上面三条路都会把别家工厂的订单拉进来 → 中砂的票出现在中宠页面上。
        --    报关逐项工厂是我们固化过、带依据的真值，用它收窄最可靠。
        AND (
          NOT EXISTS (
            SELECT 1 FROM customs_declarations cd8
              JOIN customs_declaration_items ci8 ON ci8.declaration_id = cd8.id AND ci8.deleted_at IS NULL
             WHERE cd8.declaration_no = f.customs_no AND ci8.factory_company_id IS NOT NULL)
          OR EXISTS (
            SELECT 1 FROM customs_declarations cd8
              JOIN customs_declaration_items ci8 ON ci8.declaration_id = cd8.id AND ci8.deleted_at IS NULL
             WHERE cd8.declaration_no = f.customs_no
               AND ci8.factory_company_id = ord.factory_company_id)
        )
    ),
    brand_rollup AS (
      SELECT k.factory_code,
             k.decl_key,
             UPPER(TRIM(COALESCE(NULLIF(TRIM(oli.brand), ''), NULLIF(TRIM(p.brand), '')))) AS brand,
             BOOL_OR(ob.company_code IS NOT NULL) AS is_own_brand,
             SUM(COALESCE(oli.factory_subtotal, 0)) AS brand_amount
        FROM keyed k
        JOIN order_line_items oli ON oli.order_id=k.order_id
        LEFT JOIN products p ON p.id=oli.product_id
        LEFT JOIN company_own_brands ob
          ON ob.company_code=k.factory_code
         AND ob.active IS NOT FALSE
         AND UPPER(TRIM(ob.brand))=UPPER(TRIM(COALESCE(NULLIF(TRIM(oli.brand), ''), NULLIF(TRIM(p.brand), ''))))
       WHERE COALESCE(NULLIF(TRIM(oli.brand), ''), NULLIF(TRIM(p.brand), '')) IS NOT NULL
       GROUP BY k.factory_code, k.decl_key,
                UPPER(TRIM(COALESCE(NULLIF(TRIM(oli.brand), ''), NULLIF(TRIM(p.brand), ''))))
    ),
    brand_pick AS (
      -- One customs row can contain multiple brands; expose the largest factory-subtotal brand as the list badge.
      SELECT DISTINCT ON (factory_code, decl_key)
             factory_code, decl_key, brand, is_own_brand
        FROM brand_rollup
       ORDER BY factory_code, decl_key, brand_amount DESC NULLS LAST, brand
    ),
    b AS (
      SELECT
        decl_key AS customs_no,
        MAX(contract_no) AS contract_no,
        COALESCE(MIN(fer_export_date), MIN(order_date)) AS export_date,
        factory_code,
        MAX(factory_name) AS factory_name,
        STRING_AGG(DISTINCT order_no, ',' ORDER BY order_no) AS order_no,
        STRING_AGG(DISTINCT order_no, ',' ORDER BY order_no) AS order_nos,
        COALESCE(NULLIF(MAX(fer_qty),0), NULLIF(SUM(qty_oli),0)) AS qty,
        -- 应开金额（Damon 2026-08-12 拍板）：读结果表 factory_invoice_expected_amounts
        -- 口径 customs_line_fob_cny_v1 = 报关逐项金额 × 行级工厂归属。
        -- 依据：报关金额源自检疫报告(厂检单)，本来就是照工厂出厂价申报的，比订单里的 factory_price 可靠。
        -- ⛔ status<>'ready'（工厂未定/超额/已锁）一律返回 NULL，页面显「待人工填」，绝不发错数给工厂。
        NULLIF(SUM(factory_expected_value),0) AS legacy_expected_amount,
        COALESCE(MAX(fer_declare), NULLIF(SUM(declare_value),0), NULLIF(SUM(purchase_value),0)) AS system_expected_amount,
        MAX(fer_declare) AS declare_amount,
        NULLIF(SUM(sales_value),0) AS sales_amount
        FROM keyed
       GROUP BY factory_code, decl_key
    )
    SELECT b.customs_no, b.contract_no, b.export_date,
           to_char(b.export_date,'YYYY-MM') AS period,
           b.factory_code, b.factory_name, b.order_no, b.order_nos, bp.brand, COALESCE(bp.is_own_brand,false) AS is_own_brand, b.qty AS qty,
           CASE
             WHEN COALESCE(s.manual_expected_amount, b.system_expected_amount) IS NOT NULL
                  AND COALESCE(s.status,'need_amount')='need_amount' THEN 'pending_confirm'
             ELSE COALESCE(s.status, CASE WHEN b.system_expected_amount IS NULL THEN 'need_amount' ELSE 'pending_confirm' END)
           END AS status,
           fie.expected_amount AS factory_expected_amount,
           b.legacy_expected_amount,
           b.system_expected_amount,
           b.sales_amount,
           CASE WHEN b.sales_amount > 0 AND COALESCE(s.manual_expected_amount, b.system_expected_amount) > b.sales_amount * 1.5
                THEN ROUND((COALESCE(s.manual_expected_amount, b.system_expected_amount) / b.sales_amount)::numeric, 2) ELSE NULL END AS ratio_alert,
           b.declare_amount,
           s.manual_expected_amount,
           -- 🩸 0813：工厂端页面读的是 effective_expected_amount，而 0812 把应开金额
           --    改成读结果表 factory_invoice_expected_amounts 后只喂了 factory_expected_amount，
           --    这里没接上 → 工厂打开协同页金额全是 ¥0.00（Damon：「没数据」）。
           --    优先级：人工填 > 结果表 > 旧的 system 估算。
           COALESCE(s.manual_expected_amount, fie.expected_amount, b.system_expected_amount) AS effective_expected_amount,
           COALESCE(u.uploaded_amount,0) AS uploaded_amount,
           COALESCE(u.valid_invoice_count,0)::int AS valid_invoice_count,
           COALESCE(ri.received_amount,0) AS received_amount,
           CASE WHEN COALESCE(s.manual_expected_amount, fie.expected_amount, b.system_expected_amount) IS NULL
                THEN NULL
                ELSE ROUND(COALESCE(s.manual_expected_amount, fie.expected_amount, b.system_expected_amount) - COALESCE(u.uploaded_amount,0), 2)
            END AS diff_amount,
           COALESCE(pay.paid_amount,0) AS paid_amount,
           COALESCE(pay.slip_count,0)::int AS slip_count
           ${includeSlipDetails ? ", COALESCE(pay.slip_details, '[]'::jsonb) AS slip_details" : ""},
           ev.created_at AS last_event_at
      FROM b
      LEFT JOIN factory_invoice_expected_amounts fie
        -- 协同页的 decl_key 可能是报关单号，也可能是提单号（正式报关单号未回填时）。
        -- 结果表两种 key 都存：报关单号行 + 'BL:<提单号>' 聚合别名行。
        ON (fie.customs_no = b.customs_no OR fie.customs_no = 'BL:'||b.customs_no
            OR fie.customs_no = 'BL:'||REPLACE(b.customs_no,'DRAFT-',''))
       AND fie.factory_name = b.factory_name AND fie.status = 'ready'
      -- 2026-07-14: 一票多厂时 status 单键会把 manual 额双计到别厂行(140601772471 案例:DS的221650曾串到春叶/中砂行),必须按厂匹配
      LEFT JOIN customs_invoice_status s ON s.customs_no=b.customs_no AND s.factory_code=b.factory_code
      LEFT JOIN brand_pick bp ON bp.factory_code=b.factory_code AND bp.decl_key=b.customs_no
      LEFT JOIN LATERAL (
        SELECT SUM(fii.amount_incl_tax) AS uploaded_amount,
               COUNT(DISTINCT fii.id) AS valid_invoice_count
          FROM invoice_customs_links l
          JOIN finance_invoices_in fii ON fii.id=l.invoice_id
         WHERE l.customs_no=b.customs_no
           AND (l.factory_code=b.factory_code OR l.factory_code IS NULL)
           AND l.link_status='active'
           AND COALESCE(fii.review_status,'') NOT IN ('void','red_ink')
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT SUM(fi.amount_incl_tax) AS received_amount
          FROM finance_invoices_in fi
         WHERE COALESCE(fi.review_status,'') NOT IN ('void','red_ink')
           AND (
             (b.contract_no IS NOT NULL AND EXISTS (
               SELECT 1
                 FROM regexp_split_to_table(b.contract_no, '[\/,，;；\s]+') c
                WHERE c <> '' AND fi.contract_nos::text ILIKE '%' || c || '%'
             ))
             OR (b.customs_no IS NOT NULL AND fi.customs_nos::text LIKE '%' || b.customs_no || '%')
           )
      ) ri ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(${paidAmountExpr}),0) AS paid_amount,
               COUNT(DISTINCT bs.id) AS slip_count
               ${includeSlipDetails ? `,
               COALESCE(jsonb_agg(jsonb_build_object(
                 'amount', COALESCE(bl.amount_alloc,0),
                 'file_url', bs.file_url,
                 'slip_date', bs.payment_date
               ) ORDER BY bs.payment_date DESC NULLS LAST, bs.id DESC), '[]'::jsonb) AS slip_details` : ""}
          FROM bank_slip_links bl
          JOIN bank_slips bs ON bs.id=bl.slip_id
         WHERE bl.bl_no = b.customs_no
            OR (b.contract_no IS NOT NULL AND bl.contract_no = b.contract_no)
            OR (b.order_no IS NOT NULL AND bl.order_no = ANY(string_to_array(b.order_no, ',')))
      ) pay ON true
      LEFT JOIN invoice_events ev ON ev.id=s.last_event_id
     WHERE ${where.join(" AND ")}
     ORDER BY b.export_date DESC NULLS LAST, b.customs_no`;

  return (await pool.query(sql, params)).rows.map((r) => ({
    ...r,
    factory_expected_amount: money(r.factory_expected_amount),
    system_expected_amount: money(r.system_expected_amount),
    declare_amount: money(r.declare_amount),
    manual_expected_amount: money(r.manual_expected_amount),
    effective_expected_amount: money(r.effective_expected_amount),
    uploaded_amount: money(r.uploaded_amount) || 0,
    received_amount: money(r.received_amount) || 0,
    diff_amount: money(r.diff_amount),
    valid_invoice_count: Number(r.valid_invoice_count) || 0,
    order_no: r.order_no || null,
    order_nos: r.order_nos || r.order_no || null,
    brand: r.brand || null,
    is_own_brand: !!r.is_own_brand,
    qty: Number(r.qty) || null,
    paid_amount: money(r.paid_amount) || 0,
    slip_count: Number(r.slip_count) || 0,
    sales_amount: money(r.sales_amount),
    ratio_alert: r.ratio_alert != null ? Number(r.ratio_alert) : null,
  }));
}

function summarize(rows) {
  const byStatus = {};
  let expected = 0, uploaded = 0, diff = 0, factoryExpected = 0, received = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    expected += r.effective_expected_amount || 0;
    uploaded += r.uploaded_amount || 0;
    diff += r.diff_amount || 0;
    factoryExpected += r.factory_expected_amount || 0;
    received += r.received_amount || 0;
  }
  return {
    customs_count: rows.length,
    ...byStatus,
    expected_amount: money(expected) || 0,
    factory_expected_total: money(factoryExpected) || 0,
    uploaded_amount: money(uploaded) || 0,
    received_total: money(received) || 0,
    diff_amount: money(diff) || 0,
  };
}

async function handleList(req, res) {
  if (!requireFinance(req, res)) return;
  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchRows(getPool(), {
    ...range,
    factoryCode: cleanString(req.query.factory_code) || null,
    status: cleanString(req.query.status) || null,
    keyword: cleanString(req.query.keyword) || null,
  });
  return res.json({ success: true, period: { from: range.from, to: range.to }, summary: summarize(rows), rows });
}

function factoryRow(r) {
  return {
    customs_no: r.customs_no,
    contract_no: r.contract_no,
    export_date: r.export_date,
    period: r.period,
    factory_code: r.factory_code,
    factory_name: r.factory_name,
    status: r.status,
    factory_expected_amount: r.factory_expected_amount,
    needs_internal_fill: r.factory_expected_amount == null,
    received_amount: r.received_amount,
    uploaded_amount: r.uploaded_amount,
    valid_invoice_count: r.valid_invoice_count,
    order_no: r.order_no,
    order_nos: r.order_nos,
    brand: r.brand,
    is_own_brand: r.is_own_brand,
    qty: r.qty,
    has_invoice: (r.valid_invoice_count || 0) > 0,
    paid_amount: r.paid_amount || 0,
    slip_count: r.slip_count || 0,
    slips: Array.isArray(r.slip_details) ? r.slip_details : [],
    last_event_at: r.last_event_at,
  };
}

async function handleFactoryList(req, res) {
  const pool = getPool();
  const scope = await resolveFactory(req, pool);
  if (!scope) return failClosed(res);
  if (!rateLimit(req, scope.factory.code)) return json(res, 429, { error: "请求过于频繁，请稍后再试" });

  const range = rangeFromQuery(req.query || {});
  if (!range) return json(res, 400, { error: "from/to 月份格式应为 YYYY-MM" });
  const rows = await fetchRows(pool, { ...range, factoryCode: scope.factory.code, status: cleanString(req.query.status), keyword: cleanString(req.query.keyword), includeSlipDetails: true });
  return res.json(scrubFactoryCustomsPayload({
    success: true,
    factory: scope.factory,
    period: { from: range.from, to: range.to },
    summary: summarize(rows),
    rows: rows.map(factoryRow),
  }));
}

export { handleList, handleFactoryList };
/*
Merge batch 1 change log:
- L204,L273,L288,L346: add factory_expected_amount from SUM(order_line_items.factory_subtotal) for factory-tax due view.
- L239-L262,L282,L357-L358,L419-L420: add primary brand/is_own_brand badge data; when multiple brands exist, choose largest factory_subtotal brand.
- L270-L271,L355-L356,L417-L418: add order_nos while preserving existing order_no for old workflows.
- L318-L330,L352,L369-L384: add received_amount/received_total using finance_invoices_in loose contract/customs matching, leaving uploaded/diff semantics unchanged.
*/
