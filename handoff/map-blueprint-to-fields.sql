-- Map HGJ blueprint columns to our field_definitions.
-- Safe to preview inside an outer BEGIN/ROLLBACK.
-- Policy: explicit allowlist only; unmatched columns remain NULL.

WITH module_map(module_cn, module_key) AS (
  VALUES
    ('费用明细', 'freight_supplier_bills'),
    ('账单管理', 'freight_bills'),
    ('开票记录', 'finance_invoices_in'),
    ('收付管理', 'finance_payments'),
    ('核销管理', 'finance_settlement_links'),
    ('海运出口', 'shipping_plans'),
    ('待接单', 'orders'),
    ('报关信息', 'customs_declarations'),
    ('箱货信息', 'containers'),
    ('客户列表', 'companies'),
    ('单票报价', 'service_rates'),
    ('费用模板', 'local_charges')
)
UPDATE hgj_blueprint_columns h
SET
  mapped_module_key = NULL,
  mapped_field_key = NULL,
  note = CASE
    WHEN h.col_label_cn IN ('序号', '当前', '操作') THEN 'strategy=0 ui column; keep NULL'
    ELSE 'strategy=0 no safe match'
  END
FROM module_map mm
WHERE mm.module_cn = h.module_cn
  AND (
    h.mapped_module_key IS NOT NULL
    OR h.mapped_field_key IS NOT NULL
    OR h.note IS DISTINCT FROM CASE
      WHEN h.col_label_cn IN ('序号', '当前', '操作') THEN 'strategy=0 ui column; keep NULL'
      ELSE 'strategy=0 no safe match'
    END
  );

WITH module_map(module_cn, module_key) AS (
  VALUES
    ('费用明细', 'freight_supplier_bills'),
    ('账单管理', 'freight_bills'),
    ('开票记录', 'finance_invoices_in'),
    ('收付管理', 'finance_payments'),
    ('核销管理', 'finance_settlement_links'),
    ('海运出口', 'shipping_plans'),
    ('待接单', 'orders'),
    ('报关信息', 'customs_declarations'),
    ('箱货信息', 'containers'),
    ('客户列表', 'companies'),
    ('单票报价', 'service_rates'),
    ('费用模板', 'local_charges')
),
explicit_map(module_cn, col_label_cn, field_key) AS (
  VALUES
    -- 费用明细 -> freight_supplier_bills
    ('费用明细', '属性', 'direction'),
    ('费用明细', '主单号', 'bl_no'),
    ('费用明细', '结算单位', 'supplier'),
    ('费用明细', '费用名称', 'cost_category'),
    ('费用明细', '币种', 'currency'),
    ('费用明细', '金额', 'amount'),
    ('费用明细', '费用状态', 'fee_status'),
    ('费用明细', '汇率', 'exchange_rate'),
    ('费用明细', '税率(%)', 'tax_rate'),
    ('费用明细', '税金', 'tax_amount'),
    ('费用明细', '不含税总价', 'total_price'),

    -- 账单管理 -> freight_bills
    ('账单管理', '属性', 'direction'),
    ('账单管理', '创建时间', 'created_at'),
    ('账单管理', '创建人', 'created_by'),
    ('账单管理', '发票抬头', 'invoice_head_code'),
    ('账单管理', '状态', 'status'),
    ('账单管理', '币种', 'currency'),
    ('账单管理', '结算单位', 'settlement_company_code'),
    ('账单管理', '账单金额', 'total_amount'),
    ('账单管理', '账单编号', 'bill_no'),

    -- 开票记录 -> finance_invoices_in
    ('开票记录', '发票类型', 'invoice_type'),
    ('开票记录', '发票种类', 'invoice_format'),
    ('开票记录', '发票号码', 'invoice_no'),
    ('开票记录', '作废状态', 'void_status'),
    ('开票记录', '开票时间', 'issue_date'),
    ('开票记录', '状态', 'review_status'),
    ('开票记录', '销货单位', 'seller_name'),
    ('开票记录', '购货单位', 'buyer_name'),
    ('开票记录', '主单号', 'bl_nos'),
    ('开票记录', '账单金额', 'amount_incl_tax'),
    ('开票记录', '开票金额', 'amount_incl_tax'),
    ('开票记录', '不含税金额', 'amount_ex_tax'),
    ('开票记录', '税率', 'tax_rate'),
    ('开票记录', '税额', 'total_tax'),

    -- 待接单 -> orders
    ('待接单', '订单来源', 'source'),
    ('待接单', '订单类型', 'type'),
    ('待接单', '接单状态', 'status'),
    ('待接单', '业务类型', 'mode'),
    ('待接单', '委托单位', 'customer'),
    ('待接单', '委托日期', 'order_date'),
    ('待接单', '起运港/上货站', 'pol'),
    ('待接单', '目的港/下货站', 'destination_port'),
    ('待接单', '备注', 'remarks'),
    ('待接单', '订单编号', 'order_no'),
    ('待接单', 'ETD/班列日期', 'etd'),
    ('待接单', 'ETA', 'eta'),
    ('待接单', '主单号', 'bl_no'),

    -- 报关信息 -> customs_declarations
    ('报关信息', '报关行', 'broker_company_id'),
    ('报关信息', '报关日期', 'declared_at'),
    ('报关信息', '报关单号', 'declaration_no'),

    -- 收付管理 -> finance_payments
    ('收付管理', '收付编号', '_id'),
    ('收付管理', '收付日期', 'paid_date'),
    ('收付管理', '属性', 'direction'),
    ('收付管理', '币种', 'currency'),
    ('收付管理', '金额', 'amount'),
    ('收付管理', '已核销金额', 'paid_amount'),
    ('收付管理', '未核销金额', 'pending_amount'),
    ('收付管理', '收付方式', 'pay_type'),
    ('收付管理', '银行水单号', 'bank_ref'),

    -- 核销管理 -> finance_settlement_links
    ('核销管理', '核销金额', 'amount_applied'),
    ('核销管理', '核销币种', 'currency'),
    ('核销管理', '核销时间', 'created_at'),
    ('核销管理', '核销备注', 'reason'),

    -- 海运出口 -> shipping_plans
    ('海运出口', '订单编号', 'order_nos'),
    ('海运出口', '报价编号', 'quote_ref'),
    ('海运出口', '委托单位', 'customer'),
    ('海运出口', '客户业务编号', 'customer_reference_no'),
    ('海运出口', '创建时间', 'created_at'),
    ('海运出口', '订舱代理', 'forwarder_cn'),
    ('海运出口', '主单号', 'bl_no'),
    ('海运出口', '船公司', 'shipping_line'),
    ('海运出口', '起运港', 'pol'),
    ('海运出口', '目的港', 'pod'),
    ('海运出口', '截单时间', 'doc_cutoff_at'),
    ('海运出口', '箱型箱量', 'container_type'),
    ('海运出口', '委托总件数', 'total_cartons'),
    ('海运出口', '委托总毛重(KGS)', 'gross_weight_kg'),
    ('海运出口', '委托总体积(CBM)', 'total_cbm'),
    ('海运出口', '付款方式', 'freight_payment'),
    ('海运出口', '贸易条款', 'freight_term'),
    ('海运出口', 'ETD', 'etd'),
    ('海运出口', '箱号', 'container_no'),
    ('海运出口', '合约号', 'contract_nos'),
    ('海运出口', '操作备注', 'remarks'),
    ('海运出口', '委托单位代码', 'company_code'),
    ('海运出口', '订单状态', 'status'),
    ('海运出口', '异常', 'dq_status'),

    -- 箱货信息 -> containers
    ('箱货信息', '箱号', 'container_no'),
    ('箱货信息', '封号', 'seal_no'),
    ('箱货信息', '箱型', 'container_type'),

    -- 客户列表 -> companies
    ('客户列表', '公司抬头', 'name_cn'),
    ('客户列表', '代码', 'code'),
    ('客户列表', '创建时间', 'created_at'),
    ('客户列表', '地址', 'address'),
    ('客户列表', '性质', 'type'),
    ('客户列表', '客户端', 'client_mode'),

    -- 单票报价 -> service_rates
    ('单票报价', '业务类型', 'service'),
    ('单票报价', '起运港/上货站', 'pol'),
    ('单票报价', '目的港/下货站', 'pod'),

    -- 费用模板 -> local_charges
    ('费用模板', '订舱代理', 'company_name'),
    ('费用模板', '船公司', 'carrier'),
    ('费用模板', '创建时间', 'created_at'),
    ('费用模板', '业务类型', 'applicable_trade'),
    ('费用模板', '属性', 'charge_type'),
    ('费用模板', '结算单位', 'company_name')
),
exact_label_matches AS (
  SELECT
    h.id,
    mm.module_key,
    fd.field_key,
    2 AS strategy_rank,
    fd.field_key AS tie_breaker
  FROM hgj_blueprint_columns h
  JOIN module_map mm
    ON mm.module_cn = h.module_cn
  JOIN field_definitions fd
    ON fd.module_key = mm.module_key
   AND fd.label_cn = h.col_label_cn
  WHERE h.col_label_cn NOT IN ('序号', '当前', '操作')
),
explicit_matches AS (
  SELECT
    h.id,
    mm.module_key,
    em.field_key,
    1 AS strategy_rank,
    em.field_key AS tie_breaker
  FROM hgj_blueprint_columns h
  JOIN explicit_map em
    ON em.module_cn = h.module_cn
   AND em.col_label_cn = h.col_label_cn
  JOIN module_map mm
    ON mm.module_cn = em.module_cn
  JOIN field_definitions fd
    ON fd.module_key = mm.module_key
   AND fd.field_key = em.field_key
  WHERE h.col_label_cn NOT IN ('序号', '当前', '操作')
),
ranked AS (
  SELECT
    m.id,
    m.module_key,
    m.field_key,
    m.strategy_rank,
    row_number() OVER (
      PARTITION BY m.id
      ORDER BY m.strategy_rank, m.tie_breaker
    ) AS rn
  FROM (
    SELECT * FROM explicit_matches
    UNION ALL
    SELECT * FROM exact_label_matches
  ) m
)
UPDATE hgj_blueprint_columns h
SET
  mapped_module_key = r.module_key,
  mapped_field_key = r.field_key,
  note = CASE r.strategy_rank
    WHEN 1 THEN 'strategy=1 explicit allowlist'
    ELSE 'strategy=2 exact field_definitions.label_cn'
  END
FROM ranked r
WHERE r.rn = 1
  AND h.id = r.id
  AND (
    h.mapped_module_key IS DISTINCT FROM r.module_key
    OR h.mapped_field_key IS DISTINCT FROM r.field_key
    OR h.note IS DISTINCT FROM CASE r.strategy_rank
      WHEN 1 THEN 'strategy=1 explicit allowlist'
      ELSE 'strategy=2 exact field_definitions.label_cn'
    END
  );
