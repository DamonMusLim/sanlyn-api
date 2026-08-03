// 结算线付款明细:点击对账行弹窗用。返回该订单/合同/BL 关联的 finance_payments 付款记录 + bank_slips 水单(含文件与日期)。
// 货代线额外支持按货代名取最近付款(挂链欠账期的兜底视角,标注 scope 供前端说明)。
export async function linePayments(pool, query = {}) {
  const orderNo = String(query.order_no || "").trim();
  const contractNo = String(query.contract_no || "").trim();
  const blNo = String(query.bl_no || "").trim();
  const forwarder = String(query.forwarder || "").trim();

  const payments = [];
  if (orderNo || contractNo) {
    const r = await pool.query(
      `SELECT COALESCE(payment_date, paid_date, created_at)::date AS pay_date, direction,
              COALESCE(this_amount, amount) AS amount, COALESCE(currency,'CNY') AS currency,
              COALESCE(customer_en, customer, customer_cn) AS counterparty, forwarder_cn,
              pay_item, bank_ref, tt_slip_url, contract_no, order_no
         FROM finance_payments
        WHERE ($1 <> '' AND (order_no = $1 OR contract_no = $1))
           OR ($2 <> '' AND (contract_no = $2 OR order_no = $2))
        ORDER BY 1 DESC NULLS LAST LIMIT 50`, [orderNo, contractNo]);
    for (const x of r.rows) payments.push({ ...x, scope: "matched" });
  }
  if (!payments.length && forwarder) {
    const r = await pool.query(
      `SELECT COALESCE(payment_date, paid_date, created_at)::date AS pay_date, direction,
              COALESCE(this_amount, amount) AS amount, COALESCE(currency,'CNY') AS currency,
              forwarder_cn AS counterparty, pay_item, bank_ref, tt_slip_url, contract_no, order_no
         FROM finance_payments
        WHERE direction = 'out' AND forwarder_cn ILIKE '%' || $1 || '%'
        ORDER BY 1 DESC NULLS LAST LIMIT 15`, [forwarder.slice(0, 8)]);
    for (const x of r.rows) payments.push({ ...x, scope: "forwarder_recent" });
  }

  const slips = (orderNo || contractNo || blNo) ? (await pool.query(
    `SELECT bs.id, bs.payment_date::date AS pay_date, bs.amount, bs.currency,
            bs.sender_name, bs.beneficiary_name, bs.file_url, l.amount_alloc, l.order_no, l.contract_no, l.bl_no
       FROM bank_slip_links l JOIN bank_slips bs ON bs.id = l.slip_id
      WHERE ($1 <> '' AND l.order_no = $1) OR ($2 <> '' AND l.contract_no = $2) OR ($3 <> '' AND l.bl_no = $3)
      ORDER BY bs.payment_date DESC NULLS LAST LIMIT 20`, [orderNo, contractNo, blNo])).rows : [];

  // 银行流水侧(洋宝宝等 bank_flows,含汇款日期;摘要常带单号,便于人工核对)
  const flows = (orderNo || contractNo || blNo) ? (await pool.query(
    `SELECT entity_code, tx_date, direction, amount, currency, counterparty_name, memo, ref_no
       FROM bank_flows
      WHERE ($1 <> '' AND memo ILIKE '%' || $1 || '%')
         OR ($2 <> '' AND memo ILIKE '%' || $2 || '%')
         OR ($3 <> '' AND memo ILIKE '%' || $3 || '%')
      ORDER BY tx_date DESC LIMIT 15`, [orderNo, contractNo, blNo])).rows : [];

  return { success: true, payments, slips, flows };
}
