import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable, requireVisible } from "../moduleGate.js";

const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 50;
const MAX_SIZE = 100;
const PAID_AND_AFTER = ["paid", "ready", "delivering", "shipped", "done"];
const CANCELLABLE = ["unpaid", "paid", "ready", "delivering", "shipped"];
const COMPLETABLE = ["ready", "delivering", "shipped"];

const ORDER_COLUMNS = `
  o.id,
  o.order_no,
  o.store_code,
  o.status,
  o.delivery_type,
  o.total_fen,
  o.freight_fen,
  o.pay_fen,
  o.contact_name,
  o.contact_phone,
  o.address,
  o.note,
  o.carrier,
  o.tracking_no,
  o.pickup_code,
  o.refund_fen,
  o.created_at,
  o.paid_at,
  o.shipped_at,
  o.done_at,
  m.phone AS member_phone,
  m.nickname AS member_nickname
`;

const ITEM_COLUMNS = `
  l.order_id,
  l.product_name,
  l.spec,
  l.price_fen,
  l.qty,
  l.amount_fen
`;

const ALLOWED_TABLES = new Set([
  "petstore_shop_order",
  "petstore_shop_order_line",
  "petstore_shop_order_event",
  "petstore_shop_member",
  "filtered",
  "list_rows",
  "item_rows",
  "stats",
  "updated_order",
  "event_row",
]);

let sqlChecked = false;

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

function cleanString(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function parsePositiveInt(value, fallback, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function operatorFromReq(req) {
  return cleanString(req.user?.username || req.user?.name || req.user?.account || "admin", 80) || "admin";
}

function nextActions(row) {
  if (row.status === "unpaid") return ["confirm_pay", "cancel"];
  if (row.status === "paid" && row.delivery_type === 1) return ["ship", "cancel", "refund"];
  if (row.status === "paid" && row.delivery_type === 2) return ["ready", "cancel", "refund"];
  if (row.status === "paid" && row.delivery_type === 3) return ["deliver", "cancel", "refund"];
  if (["ready", "delivering", "shipped"].includes(row.status)) return ["complete", "refund"];
  if (row.status === "done") return ["refund"];
  return [];
}

function pickupCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getCteNames(sql) {
  const names = new Set();
  const re = /(?:\bWITH|,)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
  return names;
}

function assertSqlTables(sql) {
  const cleaned = sql
    .replace(/\bDO\s+UPDATE\s+SET\b/gi, " ")
    .replace(/\bFOR\s+UPDATE\b/gi, " ");
  const legal = new Set([...ALLOWED_TABLES, ...getCteNames(cleaned)]);
  const re = /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?/gi;
  let m;
  while ((m = re.exec(cleaned))) {
    const table = m[1].toLowerCase();
    if (!legal.has(table)) throw new Error(`SQL table not allowed: ${table}`);
  }
}

function checkSqlOnce(sqls) {
  if (sqlChecked) return;
  for (const sql of sqls) assertSqlTables(sql);
  sqlChecked = true;
}

function buildListSql(query) {
  const params = [];
  const baseWhere = [];
  const listWhere = [];
  const storeCode = cleanString(query?.storeCode, 32) || "63350001";
  const deliveryType = Number.parseInt(String(query?.deliveryType ?? ""), 10);
  const status = cleanString(query?.status, 30);
  const keyword = cleanString(query?.keyword, 80);

  params.push(storeCode);
  baseWhere.push(`o.store_code = $${params.length}`);

  if ([1, 2, 3].includes(deliveryType)) {
    params.push(deliveryType);
    baseWhere.push(`o.delivery_type = $${params.length}`);
  }

  if (keyword) {
    params.push(`%${keyword}%`);
    baseWhere.push(`(
      o.order_no ILIKE $${params.length}
      OR o.contact_phone ILIKE $${params.length}
      OR o.contact_name ILIKE $${params.length}
      OR m.phone ILIKE $${params.length}
    )`);
  }

  if (status) {
    params.push(status);
    listWhere.push(`status = $${params.length}`);
  }

  const page = parsePositiveInt(query?.page, DEFAULT_PAGE, 100000);
  const size = parsePositiveInt(query?.size, DEFAULT_SIZE, MAX_SIZE);
  params.push(size);
  const limitIdx = params.length;
  params.push((page - 1) * size);
  const offsetIdx = params.length;

  const baseClause = baseWhere.length ? `WHERE ${baseWhere.join(" AND ")}` : "";
  const listClause = listWhere.length ? `WHERE ${listWhere.join(" AND ")}` : "";

  const sql = `
WITH filtered AS (
  SELECT
    ${ORDER_COLUMNS}
  FROM petstore_shop_order o
  LEFT JOIN petstore_shop_member m
    ON m.id = o.member_id
  ${baseClause}
),
stats AS (
  SELECT
    COUNT(*)::int AS all,
    COUNT(*) FILTER (WHERE status = 'unpaid')::int AS unpaid,
    COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
    COUNT(*) FILTER (WHERE status = 'ready')::int AS ready,
    COUNT(*) FILTER (WHERE status = 'delivering')::int AS delivering,
    COUNT(*) FILTER (WHERE status = 'shipped')::int AS shipped,
    COUNT(*) FILTER (WHERE status = 'done')::int AS done,
    COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
    COUNT(*) FILTER (WHERE status = 'refunded')::int AS refunded
  FROM filtered
),
list_rows AS (
  SELECT
    id,
    order_no,
    store_code,
    status,
    delivery_type,
    total_fen,
    freight_fen,
    pay_fen,
    contact_name,
    contact_phone,
    address,
    note,
    carrier,
    tracking_no,
    pickup_code,
    refund_fen,
    member_phone,
    member_nickname,
    created_at,
    paid_at,
    shipped_at,
    done_at
  FROM filtered
  ${listClause}
  ORDER BY created_at DESC, id DESC
  LIMIT $${limitIdx} OFFSET $${offsetIdx}
),
item_rows AS (
  SELECT
    ${ITEM_COLUMNS}
  FROM petstore_shop_order_line l
  JOIN list_rows r
    ON r.id = l.order_id
)
SELECT
  COALESCE(json_agg(
    json_build_object(
      'id', r.id,
      'order_no', r.order_no,
      'store_code', r.store_code,
      'status', r.status,
      'delivery_type', r.delivery_type,
      'total_fen', r.total_fen,
      'freight_fen', r.freight_fen,
      'pay_fen', r.pay_fen,
      'contact_name', r.contact_name,
      'contact_phone', r.contact_phone,
      'address', r.address,
      'note', r.note,
      'carrier', r.carrier,
      'tracking_no', r.tracking_no,
      'pickup_code', r.pickup_code,
      'refund_fen', r.refund_fen,
      'member_phone', r.member_phone,
      'member_nickname', r.member_nickname,
      'created_at', r.created_at,
      'paid_at', r.paid_at,
      'shipped_at', r.shipped_at,
      'done_at', r.done_at,
      'items', COALESCE((
        SELECT json_agg(json_build_object(
          'product_name', i.product_name,
          'spec', i.spec,
          'price_fen', i.price_fen,
          'qty', i.qty,
          'amount_fen', i.amount_fen
        ) ORDER BY i.order_id)
        FROM item_rows i
        WHERE i.order_id = r.id
      ), '[]'::json)
    )
    ORDER BY r.created_at DESC, r.id DESC
  ) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS list,
  json_build_object(
    'all', stats.all,
    'unpaid', stats.unpaid,
    'paid', stats.paid,
    'ready', stats.ready,
    'delivering', stats.delivering,
    'shipped', stats.shipped,
    'done', stats.done,
    'cancelled', stats.cancelled,
    'refunded', stats.refunded
  ) AS stats
FROM stats
LEFT JOIN list_rows r
  ON true
GROUP BY
  stats.all,
  stats.unpaid,
  stats.paid,
  stats.ready,
  stats.delivering,
  stats.shipped,
  stats.done,
  stats.cancelled,
  stats.refunded
`;

  return { sql, params, page, size, storeCode };
}

const UPDATE_SQL = {
  confirm_pay: `
UPDATE petstore_shop_order
SET
  status = 'paid',
  paid_at = now(),
  pay_method = $3,
  pay_txn_no = $4,
  operator = $5,
  updated_at = now()
WHERE id = $1
  AND status = $2
RETURNING id
`,
  ship: `
UPDATE petstore_shop_order
SET
  status = 'shipped',
  carrier = $3,
  tracking_no = $4,
  shipped_at = now(),
  operator = $5,
  updated_at = now()
WHERE id = $1
  AND status = $2
  AND delivery_type = 1
RETURNING id
`,
  ready: `
UPDATE petstore_shop_order
SET
  status = 'ready',
  pickup_code = $3,
  operator = $4,
  updated_at = now()
WHERE id = $1
  AND status = $2
  AND delivery_type = 2
RETURNING id
`,
  deliver: `
UPDATE petstore_shop_order
SET
  status = 'delivering',
  shipped_at = now(),
  operator = $3,
  updated_at = now()
WHERE id = $1
  AND status = $2
  AND delivery_type = 3
RETURNING id
`,
  complete: `
UPDATE petstore_shop_order
SET
  status = 'done',
  done_at = now(),
  operator = $3,
  updated_at = now()
WHERE id = $1
  AND status = $2
RETURNING id
`,
  completePickup: `
UPDATE petstore_shop_order
SET
  status = 'done',
  done_at = now(),
  operator = $4,
  updated_at = now()
WHERE id = $1
  AND status = $2
  AND delivery_type = 2
  AND pickup_code = $3
RETURNING id
`,
  cancel: `
UPDATE petstore_shop_order
SET
  status = 'cancelled',
  cancel_reason = $3,
  operator = $4,
  updated_at = now()
WHERE id = $1
  AND status = $2
RETURNING id
`,
  refund: `
UPDATE petstore_shop_order
SET
  status = 'refunded',
  refund_fen = $3,
  refunded_at = now(),
  cancel_reason = $4,
  operator = $5,
  updated_at = now()
WHERE id = $1
  AND status = $2
  AND $3 BETWEEN 1 AND pay_fen
RETURNING id
`,
};

const EVENT_SQL = `
INSERT INTO petstore_shop_order_event (
  order_id,
  from_status,
  to_status,
  action,
  operator,
  note,
  metadata,
  created_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
RETURNING id
`;

const CHECK_ORDER_SQL = `
SELECT
  store_code,
  status,
  delivery_type,
  pay_fen,
  pickup_code
FROM petstore_shop_order
WHERE id = $1
LIMIT 1
`;

function getSqlsForCheck() {
  return [
    buildListSql({ page: 1, size: 1 }).sql,
    ...Object.values(UPDATE_SQL),
    EVENT_SQL,
    CHECK_ORDER_SQL,
  ];
}

async function insertEvent(client, orderId, fromStatus, toStatus, action, operator, note, metadata = {}) {
  await client.query(EVENT_SQL, [
    orderId,
    fromStatus,
    toStatus,
    action,
    operator,
    note || null,
    JSON.stringify(metadata || {}),
  ]);
}

async function updateOneStatus(client, sql, params, event) {
  const r = await client.query(sql, params);
  if (!r.rowCount) return false;
  await insertEvent(
    client,
    params[0],
    event.fromStatus,
    event.toStatus,
    event.action,
    event.operator,
    event.note,
    event.metadata
  );
  return true;
}

async function tryStatuses(client, statuses, makeSqlAndParams, eventForStatus) {
  for (const status of statuses) {
    const { sql, params } = makeSqlAndParams(status);
    const ok = await updateOneStatus(client, sql, params, eventForStatus(status));
    if (ok) return true;
  }
  return false;
}

async function getOrderCheck(client, id) {
  const r = await client.query(CHECK_ORDER_SQL, [id]);
  return r.rows[0] || null;
}

async function handleGet(req, res) {
  const storeCode = cleanString(req.query?.storeCode, 32) || "63350001";
  const gate = await requireVisible(req, res, "miniapp", storeCode);
  if (!gate) return;

  const pool = getPool();
  const built = buildListSql(req.query || {});
  checkSqlOnce(getSqlsForCheck());

  const r = await pool.query(built.sql, built.params);
  const row = r.rows[0] || {};
  const list = (row.list || []).map((item) => ({
    ...item,
    nextActions: nextActions(item),
  }));

  return sendJson(res, 200, {
    ok: true,
    page: built.page,
    size: built.size,
    stats: row.stats || {
      all: 0,
      unpaid: 0,
      paid: 0,
      ready: 0,
      delivering: 0,
      shipped: 0,
      done: 0,
      cancelled: 0,
      refunded: 0,
    },
    list,
  });
}

async function handlePost(req, res) {
  const storeCode = cleanString(req.body?.storeCode, 32)
    || cleanString(req.query?.storeCode, 32) || "63350001";
  const gate = await requireWritable(req, res, "miniapp", storeCode);
  if (!gate) return;

  const b = req.body || {};
  const action = cleanString(b.action, 40);
  const id = Number.parseInt(String(b.id ?? ""), 10);
  const operator = operatorFromReq(req);
  const note = cleanString(b.note, 500) || cleanString(b.reason, 500);

  if (!Number.isFinite(id) || id <= 0) {
    return sendJson(res, 400, { ok: false, message: "订单 id 必填" });
  }

  checkSqlOnce(getSqlsForCheck());

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const owner = await getOrderCheck(client, id);
    if (!owner) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { ok: false, message: "订单不存在" });
    }
    if (owner.store_code !== storeCode) {
      await client.query("ROLLBACK");
      return sendJson(res, 403, { ok: false, message: "这笔订单不属于当前门店" });
    }

    let ok = false;

    if (action === "confirm_pay") {
      ok = await updateOneStatus(
        client,
        UPDATE_SQL.confirm_pay,
        [id, "unpaid", cleanString(b.payMethod, 40) || null, cleanString(b.payTxnNo, 80) || null, operator],
        { fromStatus: "unpaid", toStatus: "paid", action, operator, note }
      );
    } else if (action === "ship") {
      const carrier = cleanString(b.carrier, 80);
      const trackingNo = cleanString(b.trackingNo, 100);
      if (!carrier || !trackingNo) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { ok: false, message: "快递公司和快递单号都要填写" });
      }
      ok = await updateOneStatus(
        client,
        UPDATE_SQL.ship,
        [id, "paid", carrier, trackingNo, operator],
        { fromStatus: "paid", toStatus: "shipped", action, operator, note }
      );
    } else if (action === "ready") {
      const code = pickupCode();
      ok = await updateOneStatus(
        client,
        UPDATE_SQL.ready,
        [id, "paid", code, operator],
        { fromStatus: "paid", toStatus: "ready", action, operator, note, metadata: { pickup_code: code } }
      );
    } else if (action === "deliver") {
      ok = await updateOneStatus(
        client,
        UPDATE_SQL.deliver,
        [id, "paid", operator],
        { fromStatus: "paid", toStatus: "delivering", action, operator, note }
      );
    } else if (action === "complete") {
      const check = await getOrderCheck(client, id);
      if (check?.delivery_type === 2) {
        const code = cleanString(b.pickupCode, 20);
        if (!code) {
          await client.query("ROLLBACK");
          return sendJson(res, 400, { ok: false, message: "自提订单必须输入取货核销码" });
        }
        ok = await updateOneStatus(
          client,
          UPDATE_SQL.completePickup,
          [id, "ready", code, operator],
          { fromStatus: "ready", toStatus: "done", action, operator, note }
        );
        if (!ok && check?.status === "ready" && check?.pickup_code !== code) {
          await client.query("ROLLBACK");
          return sendJson(res, 400, { ok: false, message: "核销码不对,请顾客出示正确的取货码" });
        }
      } else {
        ok = await tryStatuses(
          client,
          COMPLETABLE,
          (status) => ({ sql: UPDATE_SQL.complete, params: [id, status, operator] }),
          (status) => ({ fromStatus: status, toStatus: "done", action, operator, note })
        );
      }
    } else if (action === "cancel") {
      const reason = cleanString(b.reason, 500);
      if (!reason) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { ok: false, message: "取消原因必填" });
      }
      ok = await tryStatuses(
        client,
        CANCELLABLE,
        (status) => ({ sql: UPDATE_SQL.cancel, params: [id, status, reason, operator] }),
        (status) => ({ fromStatus: status, toStatus: "cancelled", action, operator, note: reason })
      );
    } else if (action === "refund") {
      const refundFen = Number.parseInt(String(b.refundFen ?? ""), 10);
      const reason = cleanString(b.reason, 500);
      if (!Number.isFinite(refundFen) || refundFen <= 0) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { ok: false, message: "退款金额必须大于 0" });
      }
      if (!reason) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { ok: false, message: "退款原因必填" });
      }
      const check = await getOrderCheck(client, id);
      if (check && refundFen > Number(check.pay_fen || 0)) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { ok: false, message: "退款金额不能超过实付金额" });
      }
      ok = await tryStatuses(
        client,
        PAID_AND_AFTER,
        (status) => ({ sql: UPDATE_SQL.refund, params: [id, status, refundFen, reason, operator] }),
        (status) => ({ fromStatus: status, toStatus: "refunded", action, operator, note: reason, metadata: { refund_fen: refundFen } })
      );
    } else {
      await client.query("ROLLBACK");
      return sendJson(res, 400, { ok: false, message: "不支持的操作" });
    }

    if (!ok) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, { ok: false, message: "订单状态已变化,请刷新后重试" });
    }

    await client.query("COMMIT");
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("petstore-shop-orders write failed", err);
    return sendJson(res, 500, { ok: false, message: "订单处理失败,请稍后重试" });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, 405, { ok: false, message: "只允许 GET 和 POST" });
  }
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === "GET") return await handleGet(req, res);
    return await handlePost(req, res);
  } catch (err) {
    console.error("petstore-shop-orders failed", err);
    return sendJson(res, 500, { ok: false, message: "小程序订单接口暂时不可用" });
  }
}
