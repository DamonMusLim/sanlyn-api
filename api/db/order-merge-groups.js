import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 实测 orders.status 仅: shipped/pending/confirmed/draft/ready/cancelled (无 in_transit/customs/delivered)。
// 已发货=shipped。出口报关在装船前完成,shipped 已隐含已报关。报关级独立锁(查 customs 表)留作后续。
const LOCKED_STATUSES = ["shipped"];
const ORDER_COLS = [
  "id", "_id", "order_no", "contract_no", "customer", "issuing_company",
  "status", "version", "updated_at",
];

function clean(v) {
  return String(v ?? "").trim();
}

function norm(v) {
  return clean(v).replace(/\s+/g, " ").toLowerCase();
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = clean(v);
    if (!s) continue;
    const k = norm(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function actor(req) {
  return clean(req.user?.email || req.user?.username || req.user?.account || req.user?.uid || req.user?.id) || "system";
}

async function orderColumns(client) {
  const r = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='orders'
        AND column_name = ANY($1::text[])`,
    [ORDER_COLS]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function orderSelect(cols) {
  return ORDER_COLS.filter((c) => cols.has(c)).join(", ");
}

function orderIdOf(row) {
  return clean(row.id ?? row._id ?? row.order_no ?? row.contract_no);
}

function refConds(cols, startAt) {
  const parts = [];
  let n = startAt;
  for (const c of ["id", "_id", "order_no", "contract_no"]) {
    if (!cols.has(c)) continue;
    parts.push(c === "id" ? `id::text = ANY($${n}::text[])` : `${c}::text = ANY($${n}::text[])`);
  }
  return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
}

async function loadOrders(client, refs) {
  const ids = uniq(refs);
  if (!ids.length) return { rows: [], cols: new Set() };
  const cols = await orderColumns(client);
  const select = orderSelect(cols);
  if (!select) return { rows: [], cols };
  const sql = `SELECT ${select} FROM orders WHERE ${refConds(cols, 1)} FOR UPDATE`;
  const r = await client.query(sql, [ids]);
  return { rows: r.rows, cols };
}

function assertSameHeader(orders) {
  if (!orders.length) {
    const e = new Error("orders required");
    e.status = 400;
    throw e;
  }
  const customer = norm(orders[0].customer);
  const issuing = norm(orders[0].issuing_company);
  const bad = orders.find((o) => norm(o.customer) !== customer || norm(o.issuing_company) !== issuing);
  if (bad) {
    const e = new Error("customer and issuing_company must be identical");
    e.status = 422;
    e.code = "header_mismatch";
    throw e;
  }
}

function pickMaster(orders, masterOrderId) {
  if (masterOrderId) {
    const want = norm(masterOrderId);
    const found = orders.find((o) => [o.id, o._id, o.order_no, o.contract_no].some((v) => norm(v) === want));
    if (!found) {
      const e = new Error("masterOrderId must be one of orderIds");
      e.status = 422;
      throw e;
    }
    return found;
  }
  return [...orders].sort((a, b) => clean(a.contract_no || a.order_no || orderIdOf(a))
    .localeCompare(clean(b.contract_no || b.order_no || orderIdOf(b)), "en"))[0];
}

function checkExpectedVersions(orders, expected, cols) {
  if (!expected) return;
  if (!cols.has("version")) {
    const e = new Error("orders.version is not available for expectedOrderVersions");
    e.status = 400;
    throw e;
  }
  for (const o of orders) {
    const keys = [o.id, o._id, o.order_no, o.contract_no].map(clean).filter(Boolean);
    const supplied = keys.map((k) => expected[k]).find((v) => v !== undefined);
    if (supplied !== undefined && Number(supplied) !== Number(o.version)) {
      const e = new Error("order version conflict");
      e.status = 409;
      e.code = "order_version_conflict";
      throw e;
    }
  }
}

async function assertNoActiveMembership(client, orderIds) {
  const r = await client.query(
    `SELECT i.order_id, g.id AS group_id
       FROM order_merge_group_items i
       JOIN order_merge_groups g ON g.id = i.group_id
      WHERE i.order_id = ANY($1::text[]) AND g.status = 'active'
      FOR UPDATE OF i, g`,
    [orderIds]
  );
  if (r.rows.length) {
    const e = new Error("order already belongs to active merge group");
    e.status = 409;
    e.details = r.rows;
    throw e;
  }
}

async function fetchGroup(client, id) {
  const g = await client.query("SELECT * FROM order_merge_groups WHERE id=$1", [id]);
  if (!g.rows[0]) return null;
  const items = await client.query(
    `SELECT * FROM order_merge_group_items
      WHERE group_id=$1 ORDER BY is_master DESC, id ASC`,
    [id]
  );
  return { ...g.rows[0], items: items.rows };
}

async function createGroup(req, res) {
  const body = req.body || {};
  const orderRefs = uniq(Array.isArray(body.orderIds) ? body.orderIds : []);
  if (body.masterOrderId && !orderRefs.some((x) => norm(x) === norm(body.masterOrderId))) {
    return res.status(422).json({ error: "masterOrderId must be included in orderIds" });
  }
  const refs = uniq([...orderRefs, body.masterOrderId]);
  if (refs.length < 2) return res.status(400).json({ error: "at least two orderIds required" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const loaded = await loadOrders(client, refs);
    const orders = loaded.rows;
    if (orders.length !== refs.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "some orders not found", expected: refs.length, found: orders.length });
    }
    assertSameHeader(orders);
    checkExpectedVersions(orders, body.expectedOrderVersions, loaded.cols);

    const master = pickMaster(orders, body.masterOrderId);
    const ids = orders.map(orderIdOf);
    await assertNoActiveMembership(client, ids);

    const gr = await client.query(
      `INSERT INTO order_merge_groups
        (master_order_id, master_contract_no, customer, issuing_company, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orderIdOf(master), master.contract_no || master.order_no || orderIdOf(master),
       orders[0].customer || null, orders[0].issuing_company || null, actor(req)]
    );
    const group = gr.rows[0];
    for (const o of orders) {
      await client.query(
        `INSERT INTO order_merge_group_items
          (group_id, order_id, order_no, contract_no, is_master)
         VALUES ($1,$2,$3,$4,$5)`,
        [group.id, orderIdOf(o), o.order_no || null, o.contract_no || null, orderIdOf(o) === orderIdOf(master)]
      );
    }
    const full = await fetchGroup(client, group.id);
    await client.query(
      `INSERT INTO order_merge_group_audit_logs(group_id, action, before_json, after_json, operator)
       VALUES ($1,'create',NULL,$2::jsonb,$3)`,
      [group.id, JSON.stringify(full), actor(req)]
    );
    await client.query("COMMIT");
    return res.status(201).json({ success: true, group: full });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(err.status || 500).json({ error: err.code || err.message, message: err.message, details: err.details });
  } finally {
    client.release();
  }
}

async function dissolveGroup(req, res) {
  const id = req.params?.id || (req.path.match(/order-merge-groups\/([^/]+)\/dissolve/) || [])[1];
  const expected = req.body?.expectedVersion;
  if (!id) return res.status(400).json({ error: "id required" });
  if (expected === undefined) return res.status(400).json({ error: "expectedVersion required" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT * FROM order_merge_groups WHERE id=$1 FOR UPDATE", [id]);
    const group = cur.rows[0];
    if (!group) throw Object.assign(new Error("group not found"), { status: 404 });
    if (group.status !== "active") throw Object.assign(new Error("group is not active"), { status: 409 });
    if (Number(group.version) !== Number(expected)) throw Object.assign(new Error("version conflict"), { status: 409 });
    const before = await fetchGroup(client, id);

    const items = before.items || [];
    const orderIds = items.map((x) => x.order_id);
    const loaded = await loadOrders(client, orderIds);
    const locked = loaded.rows.filter((o) => LOCKED_STATUSES.includes(norm(o.status)));
    if (locked.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "order_shipped_or_declared", lockedStatuses: LOCKED_STATUSES, orders: locked });
    }

    await client.query(
      `UPDATE order_merge_groups
          SET status='dissolved', dissolved_at=NOW(), updated_at=NOW(), version=version+1
        WHERE id=$1`,
      [id]
    );
    const after = await fetchGroup(client, id);
    await client.query(
      `INSERT INTO order_merge_group_audit_logs(group_id, action, before_json, after_json, operator)
       VALUES ($1,'dissolve',$2::jsonb,$3::jsonb,$4)`,
      [id, JSON.stringify(before), JSON.stringify(after), actor(req)]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, group: after });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
}

async function removeItem(req, res) {
  const id = req.params?.id || (req.path.match(/order-merge-groups\/([^/]+)\/remove-item/) || [])[1];
  const orderId = clean(req.body?.orderId);
  const expected = req.body?.expectedVersion;
  if (!id) return res.status(400).json({ error: "id required" });
  if (!orderId) return res.status(400).json({ error: "orderId required" });
  if (expected === undefined) return res.status(400).json({ error: "expectedVersion required" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT * FROM order_merge_groups WHERE id=$1 FOR UPDATE", [id]);
    const group = cur.rows[0];
    if (!group) throw Object.assign(new Error("group not found"), { status: 404 });
    if (group.status !== "active") throw Object.assign(new Error("group is not active"), { status: 409 });
    if (Number(group.version) !== Number(expected)) throw Object.assign(new Error("version conflict"), { status: 409 });
    const before = await fetchGroup(client, id);
    const items = before.items || [];
    const item = items.find((x) => [x.order_id, x.order_no, x.contract_no].some((v) => norm(v) === norm(orderId)));
    if (!item) throw Object.assign(new Error("order is not in merge group"), { status: 404 });

    const loaded = await loadOrders(client, [orderId, item.order_id, item.order_no, item.contract_no]);
    const locked = loaded.rows.filter((o) => LOCKED_STATUSES.includes(norm(o.status)));
    if (locked.length) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "order_shipped_or_declared", lockedStatuses: LOCKED_STATUSES, orders: locked });
    }

    await client.query(
      `DELETE FROM order_merge_group_items
        WHERE group_id=$1
          AND (order_id=$2 OR order_no=$2 OR contract_no=$2
               OR order_id=$3 OR order_no=$3 OR contract_no=$3)`,
      [id, orderId, item.order_id]
    );

    const remaining = items
      .filter((x) => x.id !== item.id)
      .sort((a, b) => clean(a.contract_no || a.order_no || a.order_id)
        .localeCompare(clean(b.contract_no || b.order_no || b.order_id), "en"));
    if (item.is_master && remaining.length) {
      const nextMaster = remaining[0];
      await client.query("UPDATE order_merge_group_items SET is_master=FALSE WHERE group_id=$1", [id]);
      await client.query("UPDATE order_merge_group_items SET is_master=TRUE WHERE id=$1", [nextMaster.id]);
      await client.query(
        `UPDATE order_merge_groups
            SET master_order_id=$2, master_contract_no=$3, updated_at=NOW()
          WHERE id=$1`,
        [id, nextMaster.order_id, nextMaster.contract_no || nextMaster.order_no || nextMaster.order_id]
      );
    }

    const dissolved = remaining.length < 2;
    await client.query(
      `UPDATE order_merge_groups
          SET status=CASE WHEN $2 THEN 'dissolved' ELSE status END,
              dissolved_at=CASE WHEN $2 THEN NOW() ELSE dissolved_at END,
              updated_at=NOW(),
              version=version+1
        WHERE id=$1`,
      [id, dissolved]
    );
    const after = await fetchGroup(client, id);
    await client.query(
      `INSERT INTO order_merge_group_audit_logs(group_id, action, before_json, after_json, operator)
       VALUES ($1,'remove_item',$2::jsonb,$3::jsonb,$4)`,
      [id, JSON.stringify(before), JSON.stringify(after), actor(req)]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, group: after, dissolved });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
}

async function getGroup(req, res) {
  const pool = getPool();
  const id = clean(req.query?.id);
  const orderId = clean(req.query?.order_id);
  if (!id && !orderId) return res.status(400).json({ error: "id or order_id required" });
  try {
    if (id) {
      const group = await fetchGroup(pool, id);
      if (!group) return res.status(404).json({ error: "group not found" });
      return res.status(200).json({ success: true, group });
    }
    const r = await pool.query(
      `SELECT g.id
         FROM order_merge_groups g
         JOIN order_merge_group_items i ON i.group_id = g.id
        WHERE g.status='active' AND (i.order_id=$1 OR i.order_no=$1 OR i.contract_no=$1)
        LIMIT 1`,
      [orderId]
    );
    if (!r.rows[0]) return res.status(200).json({ success: true, group: null });
    const group = await fetchGroup(pool, r.rows[0].id);
    return res.status(200).json({ success: true, group });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method === "GET") return getGroup(req, res);
  if (req.method === "POST" && req.path.includes("/remove-item")) return removeItem(req, res);
  if (req.method === "POST" && req.path.includes("/dissolve")) return dissolveGroup(req, res);
  if (req.method === "POST") return createGroup(req, res);
  return res.status(405).json({ error: "method not allowed" });
}

export { assertSameHeader };
