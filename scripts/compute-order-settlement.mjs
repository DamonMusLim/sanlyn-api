import pg from 'pg';

const { Pool } = pg;
const MAX_BATCH = 500;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const force = args.includes('--force');
const orderIdArg = args.find((arg) => arg.startsWith('--order-id='));
const orderId = orderIdArg ? orderIdArg.slice('--order-id='.length) : null;

if (args.some((arg) => !['--apply', '--force'].includes(arg) && !arg.startsWith('--order-id='))) {
  console.error('未知参数。仅支持 --apply, --force, --order-id=<id>');
  process.exit(1);
}

if (orderId !== null && !/^\d+$/.test(orderId)) {
  console.error('--order-id 必须是数字');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 3,
  connectionTimeoutMillis: 5000,
  options: '-c statement_timeout=15000',
});

const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2);

const selectOrders = async (client) => {
  const params = [];
  let where = 'paid_at IS NOT NULL';
  if (orderId !== null) {
    params.push(orderId);
    where += ` AND id = $${params.length}`;
  }

  const sql = `
    SELECT id, order_no, store_code, status, total_fen, freight_fen, pay_fen,
           paid_at, refund_fen, refunded_at,
           (paid_at AT TIME ZONE 'Asia/Shanghai')::date AS paid_date
      FROM petstore_shop_order
     WHERE ${where}
     ORDER BY id
  `;
  const result = await client.query(sql, params);
  return result.rows;
};

const findRule = async (client, order) => {
  const result = await client.query(
    `
      SELECT id, store_code, settle_entity_name, entity_type, merchant_no,
             platform_fee_mode, platform_fee_rate_bp, platform_fee_fixed_fen,
             freight_bearer, effective_from, effective_to
        FROM petstore_store_settle_rule
       WHERE store_code = $1
         AND effective_from <= $2
         AND (effective_to IS NULL OR effective_to >= $2)
       LIMIT 1
    `,
    [order.store_code, order.paid_date],
  );
  return result.rows[0] || null;
};

const computeSettlement = (order, rule) => {
  const basisFen = Number(order.pay_fen || 0);
  const goodsFen = Number(order.total_fen || 0);
  const freightFen = Number(order.freight_fen || 0);
  const refundFen = Number(order.refund_fen || 0);

  let serviceFee = 0;
  if (rule.platform_fee_mode === 'rate') {
    serviceFee = Math.round((basisFen * Number(rule.platform_fee_rate_bp || 0)) / 10000);
  } else if (rule.platform_fee_mode === 'fixed') {
    serviceFee = Math.min(Number(rule.platform_fee_fixed_fen || 0), basisFen);
  }

  const platformFreight = rule.freight_bearer === 'platform' ? freightFen : 0;
  const platformFeeFen = Math.min(serviceFee + platformFreight, basisFen);
  const storeAmountFen = basisFen - platformFeeFen;

  let refundPlatformFen = 0;
  let refundStoreFen = refundFen;
  if (basisFen !== 0) {
    refundPlatformFen = Math.round((refundFen * platformFeeFen) / basisFen);
    refundStoreFen = refundFen - refundPlatformFen;
  }

  return {
    order_id: order.id,
    store_code: order.store_code,
    settle_entity_name: rule.settle_entity_name,
    merchant_no: rule.merchant_no,
    rule_id: rule.id,
    basis_fen: basisFen,
    goods_fen: goodsFen,
    freight_fen: freightFen,
    platform_fee_fen: platformFeeFen,
    store_amount_fen: storeAmountFen,
    refund_fen: refundFen,
    refund_platform_fen: refundPlatformFen,
    refund_store_fen: refundStoreFen,
    order_paid_at: order.paid_at,
    status: order.status === 'cancelled' ? 'void' : 'pending',
  };
};

const upsertSettlement = async (client, row) => {
  const values = [
    row.order_id,
    row.store_code,
    row.settle_entity_name,
    row.merchant_no,
    row.rule_id,
    row.basis_fen,
    row.goods_fen,
    row.freight_fen,
    row.platform_fee_fen,
    row.store_amount_fen,
    row.refund_fen,
    row.refund_platform_fen,
    row.refund_store_fen,
    row.order_paid_at,
    row.status,
  ];

  const result = await client.query(
    `
      INSERT INTO petstore_order_settlement (
        order_id, store_code, settle_entity_name, merchant_no, rule_id,
        basis_fen, goods_fen, freight_fen, platform_fee_fen, store_amount_fen,
        refund_fen, refund_platform_fen, refund_store_fen, order_paid_at,
        status, computed_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, now(), now(), now()
      )
      ON CONFLICT (order_id) DO UPDATE SET
        store_code = EXCLUDED.store_code,
        settle_entity_name = EXCLUDED.settle_entity_name,
        merchant_no = EXCLUDED.merchant_no,
        rule_id = EXCLUDED.rule_id,
        basis_fen = EXCLUDED.basis_fen,
        goods_fen = EXCLUDED.goods_fen,
        freight_fen = EXCLUDED.freight_fen,
        platform_fee_fen = EXCLUDED.platform_fee_fen,
        store_amount_fen = EXCLUDED.store_amount_fen,
        refund_fen = EXCLUDED.refund_fen,
        refund_platform_fen = EXCLUDED.refund_platform_fen,
        refund_store_fen = EXCLUDED.refund_store_fen,
        order_paid_at = EXCLUDED.order_paid_at,
        status = EXCLUDED.status,
        settled_at = NULL,
        settle_txn_no = NULL,
        computed_at = now(),
        updated_at = now()
      WHERE petstore_order_settlement.status <> 'settled'
      RETURNING (xmax = 0) AS inserted
    `,
    values,
  );

  if (result.rowCount === 0) return 'settled';
  return result.rows[0].inserted ? 'inserted' : 'updated';
};

const addSummary = (summary, row) => {
  if (!summary.has(row.store_code)) {
    summary.set(row.store_code, {
      count: 0,
      basis: 0,
      platform: 0,
      store: 0,
    });
  }
  const item = summary.get(row.store_code);
  item.count += 1;
  item.basis += row.basis_fen;
  item.platform += row.platform_fee_fen;
  item.store += row.store_amount_fen;
};

const printReport = (stats, summary) => {
  console.log(`mode: ${apply ? 'apply' : 'dry-run'}`);
  console.log(`扫描订单数: ${stats.scanned}`);
  console.log(`新增: ${stats.inserted}`);
  console.log(`更新: ${stats.updated}`);
  console.log(`已结算跳过: ${stats.settledSkipped}`);
  console.log(`缺规则跳过: ${stats.missingRuleSkipped}`);

  for (const [storeCode, item] of summary.entries()) {
    console.log(
      `${storeCode}: 单数 ${item.count}, 基数合计 ${yuan(item.basis)}, ` +
        `平台留存合计 ${yuan(item.platform)}, 应分门店合计 ${yuan(item.store)}`,
    );
  }

  if (stats.missingRuleSkipped > 0) {
    console.error(`缺规则跳过 ${stats.missingRuleSkipped} 单，请补齐规则后重跑`);
  }
};

let exitCode = 0;
let client;

try {
  client = await pool.connect();
  const orders = await selectOrders(client);

  if (orders.length > MAX_BATCH && !force) {
    console.error(`本次命中 ${orders.length} 单超过单次上限,已中止,一单没动`);
    exitCode = 2;
  } else {
    const stats = {
      scanned: orders.length,
      inserted: 0,
      updated: 0,
      settledSkipped: 0,
      missingRuleSkipped: 0,
    };
    const summary = new Map();

    await client.query('BEGIN');

    try {
      for (const order of orders) {
        const rule = await findRule(client, order);
        if (!rule) {
          stats.missingRuleSkipped += 1;
          continue;
        }

        const row = computeSettlement(order, rule);
        const result = await upsertSettlement(client, row);

        if (result === 'inserted') {
          stats.inserted += 1;
          addSummary(summary, row);
        } else if (result === 'updated') {
          stats.updated += 1;
          addSummary(summary, row);
        } else {
          stats.settledSkipped += 1;
        }
      }

      if (apply) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }

      printReport(stats, summary);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  if (client) client.release();
  await pool.end();
}

process.exit(exitCode);
