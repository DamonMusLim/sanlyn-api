const ORDER_PREFIX = "SE";
const SNOWFLAKE_EPOCH_MS = Date.UTC(2026, 0, 1);
const NODE_ID = BigInt(Number(process.env.ORDER_SNOWFLAKE_NODE_ID || 1) & 0x3ff);
let lastMs = 0n;
let seq = 0n;

function clean(v) { return String(v ?? "").trim(); }

function nextSnowflakeId() {
  let now = BigInt(Date.now() - SNOWFLAKE_EPOCH_MS);
  if (now < 0n) now = 0n;
  if (now === lastMs) {
    seq = (seq + 1n) & 0xfffn;
    if (seq === 0n) {
      while (BigInt(Date.now() - SNOWFLAKE_EPOCH_MS) <= lastMs) {}
      now = BigInt(Date.now() - SNOWFLAKE_EPOCH_MS);
    }
  } else {
    seq = 0n;
  }
  lastMs = now;
  return ((now & 0x1ffffffffffn) << 22n) | (NODE_ID << 12n) | seq;
}

export async function allocateOrderIdentifiers(client) {
  const r = await client.query(
    `INSERT INTO order_number_sequences(prefix, biz_date, last_seq)
       VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (prefix, biz_date)
       DO UPDATE SET last_seq = order_number_sequences.last_seq + 1,
                     updated_at = now()
     RETURNING to_char(biz_date, 'YYYYMMDD') AS ymd, last_seq`,
    [ORDER_PREFIX]
  );
  const row = r.rows[0];
  return {
    public_order_no: ORDER_PREFIX + row.ymd + String(row.last_seq).padStart(4, "0"),
    internal_snowflake_id: nextSnowflakeId().toString(),
  };
}

export async function orderIdentifierStats(pool, cols) {
  const hasPublic = cols.has("public_order_no");
  const hasSnowflake = cols.has("internal_snowflake_id");
  const expr = (ok, sql, alias) => ok ? sql : "0::int AS " + alias;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total,
            ${expr(hasPublic, "COUNT(*) FILTER (WHERE NULLIF(BTRIM(public_order_no),'') IS NOT NULL)::int AS public_order_no", "public_order_no")},
            ${expr(hasSnowflake, "COUNT(*) FILTER (WHERE internal_snowflake_id IS NOT NULL)::int AS internal_snowflake_id", "internal_snowflake_id")}
       FROM orders`
  ).catch(() => ({ rows: [{ total: 0 }] }));
  const row = r.rows[0] || { total: 0 };
  const total = Number(row.total || 0);
  return [
    statRow("public_order_no", "对外单号", total, Number(row.public_order_no || 0), hasPublic, "SE+日期+流水"),
    statRow("internal_snowflake_id", "内部主键", total, Number(row.internal_snowflake_id || 0), hasSnowflake, "雪花ID"),
  ];
}

function statRow(field, label, total, filled, exists, policy) {
  return {
    field,
    label,
    policy,
    total,
    filled,
    fill_rate: total && filled ? Math.round(filled / total * 100) : null,
    connected: exists && total > 0 && filled > 0,
    missing: exists ? (total ? `orders.${field} filled samples` : "orders sample rows") : `orders.${field}`,
  };
}

export function identifiersFromOrder(order) {
  return {
    public_order_no: clean(order?.public_order_no || order?.order_no) || null,
    internal_snowflake_id: clean(order?.internal_snowflake_id) || null,
  };
}
