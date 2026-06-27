import "dotenv/config";
import { getPool } from "../api/db.js";

const enumRows = [
  ["payment_status", "paid", "paid"],
  ["payment_status", "已付/待核销", "paid"],
  ["payment_status", "已收/待核销", "paid"],
  ["payment_status", "已记录", "paid"],
  ["payment_status", "已到账", "paid"],
  ["payment_status", "confirmed", "confirmed"],
  ["payment_status", "pending", "pending"],
  ["payment_status", "imported", "imported"],
  ["payment_status", "已退回/已冲销", "reversed"],

  ["invoice_type_in", "电子发票(增值税专用发票)", "vat_special_e"],
  ["invoice_type_in", "增值税专用发票", "vat_special"],
  ["invoice_type_in", "增值税专票", "vat_special"],
  ["invoice_type_in", "增值税普票", "vat_general"],
  ["invoice_type_in", "freight", "freight"],
  ["invoice_type_in", "freight_ocean", "freight"],
  ["invoice_type_in", "freight_unlabeled", "freight"],
  ["invoice_type_in", "port_charges", "port_charges"],
  ["invoice_type_in", "trucking", "trucking"],

  ["pay_item", "goods", "goods"],
  ["pay_item", "货款", "goods"],
  ["pay_item", "全款", "goods"],
  ["pay_item", "freight", "ocean_freight"],
  ["pay_item", "运费", "ocean_freight"],
  ["pay_item", "ocean_freight", "ocean_freight"],
  ["pay_item", "海运费", "ocean_freight"],
  ["pay_item", "海运费用", "ocean_freight"],
  ["pay_item", "出口海运费", "ocean_freight"],
  ["pay_item", "海运港杂费", "port_charges"],
  ["pay_item", "港杂费", "port_charges"],
  ["pay_item", "港口费", "port_charges"],
  ["pay_item", "拖车费", "trucking"],
  ["pay_item", "陆运费", "trucking"],
  ["pay_item", "运输费", "trucking"],
  ["pay_item", "物流费", "trucking"],
  ["pay_item", "报关费", "customs"],
  ["pay_item", "货运险保费", "insurance"],
  ["pay_item", "对公国内发电电讯费", "bank_fee"],
  ["pay_item", "行内对公外汇汇款手续费", "bank_fee"],
  ["pay_item", "跨行对公外汇汇款手续费", "bank_fee"],
  ["pay_item", "对公账户维护费", "bank_fee"],
  ["pay_item", "银行创业套餐服务费", "bank_fee"],
  ["pay_item", "财务服务费", "bank_fee"],
  ["pay_item", "外贸服务费", "service_fee"],
];

async function main() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_enum_map (
      id BIGSERIAL PRIMARY KEY,
      domain TEXT NOT NULL,
      raw_value TEXT NOT NULL,
      canonical_value TEXT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(domain, raw_value)
    )
  `);

  for (const row of enumRows) {
    await pool.query(
      `INSERT INTO finance_enum_map (domain, raw_value, canonical_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (domain, raw_value) DO NOTHING`,
      row
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_settlement_links (
      id BIGSERIAL PRIMARY KEY,
      payment_id BIGINT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('ar','invoice_out','invoice_in','rebate')),
      target_id TEXT NOT NULL,
      amount_applied NUMERIC(14,2),
      currency CHAR(3) DEFAULT 'CNY',
      status TEXT DEFAULT 'applied' CHECK (status IN ('applied','reversed')),
      reversal_of BIGINT,
      source TEXT,
      created_by TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fsl_payment ON finance_settlement_links(payment_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fsl_target ON finance_settlement_links(target_type, target_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_audit_log (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      source TEXT,
      reason TEXT,
      op_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fal_row ON finance_audit_log(table_name, row_id)`);

  await pool.query(`
    CREATE OR REPLACE VIEW v_finance_payments_norm AS
    SELECT
      p.*,
      CASE
        WHEN sm.canonical_value IS NOT NULL THEN sm.canonical_value
        WHEN p.status IS NULL OR p.status = '' THEN 'needs_review'
        ELSE 'unmapped'
      END AS status_norm,
      CASE
        WHEN pm.canonical_value IS NOT NULL THEN pm.canonical_value
        WHEN p.pay_item ILIKE '%港杂%' OR p.pay_item ILIKE '%港口费%' THEN 'port_charges'
        WHEN p.pay_item ILIKE '%海运%' OR p.pay_item ILIKE '%freight%' THEN 'ocean_freight'
        WHEN p.pay_item ILIKE '%拖车%' OR p.pay_item ILIKE '%陆运%' OR p.pay_item ILIKE '%运输%' OR p.pay_item ILIKE '%物流%' THEN 'trucking'
        WHEN p.pay_item ILIKE '%报关%' OR p.pay_item ILIKE '%报检%' THEN 'customs'
        WHEN p.pay_item ILIKE '%手续费%' OR p.pay_item ILIKE '%电讯费%' OR p.pay_item ILIKE '%账户维护%' OR p.pay_item ILIKE '%套餐%' THEN 'bank_fee'
        WHEN p.pay_item ILIKE '%保费%' OR p.pay_item ILIKE '%保险%' THEN 'insurance'
        WHEN p.pay_item ILIKE '%服务费%' THEN 'service_fee'
        WHEN p.pay_item ILIKE '%退款%' OR p.pay_item ILIKE '%退回%' THEN 'refund_related'
        WHEN p.pay_item IS NULL OR p.pay_item = '' THEN NULL
        ELSE 'unmapped'
      END AS pay_item_norm,
      (p.direction IS NULL OR p.direction = '') AS missing_direction,
      COALESCE(p.pay_item ~ 'BL:|PB[A-Z]+', false) AS has_embedded_ref,
      COALESCE((
        SELECT SUM(l.amount_applied)
        FROM finance_settlement_links l
        WHERE l.payment_id = p.id AND l.status = 'applied'
      ), 0) AS settled_amount
    FROM finance_payments p
    LEFT JOIN finance_enum_map sm ON sm.domain = 'payment_status' AND sm.raw_value = p.status
    LEFT JOIN finance_enum_map pm ON pm.domain = 'pay_item' AND pm.raw_value = p.pay_item
  `);

  await pool.query(`
    CREATE OR REPLACE VIEW v_finance_invoices_in_norm AS
    SELECT
      i.*,
      COALESCE(im.canonical_value, 'other') AS invoice_type_norm,
      (i.amount_incl_tax > 100000) AS needs_review
    FROM finance_invoices_in i
    LEFT JOIN finance_enum_map im ON im.domain = 'invoice_type_in' AND im.raw_value = i.invoice_type
  `);

  const checks = [
    ["finance_enum_map", "SELECT COUNT(*)::int AS n FROM finance_enum_map"],
    ["finance_settlement_links", "SELECT COUNT(*)::int AS n FROM finance_settlement_links"],
    ["finance_audit_log", "SELECT COUNT(*)::int AS n FROM finance_audit_log"],
    ["v_finance_payments_norm", "SELECT COUNT(*)::int AS n FROM v_finance_payments_norm"],
    ["v_finance_invoices_in_norm", "SELECT COUNT(*)::int AS n FROM v_finance_invoices_in_norm"],
  ];
  for (const [name, sql] of checks) {
    const r = await pool.query(sql);
    console.log(`${name}: ${r.rows[0].n}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await getPool().end(); } catch (_) {}
  process.exit(1);
});
