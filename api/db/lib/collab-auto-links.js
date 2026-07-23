import crypto from "node:crypto";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";
const SHORT_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}
function genShortRaw() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += SHORT_ALPHABET[b % SHORT_ALPHABET.length];
  return out;
}
function refOf(plan) {
  return plan.shipment_no || plan._id || plan.contract_no || String(plan.id);
}
function shortUrl(raw) {
  return `${APP_BASE}/kp?c=${encodeURIComponent(raw)}`;
}
async function ensureNotifications(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      type VARCHAR(32), level VARCHAR(12) DEFAULT 'info', title VARCHAR(200), body TEXT,
      payload JSONB, scope VARCHAR(24), scope_id VARCHAR(64), recipients TEXT[],
      recipient_roles TEXT[], channels TEXT[] DEFAULT ARRAY['inapp'],
      delivery_status JSONB DEFAULT '{}'::jsonb, read_by JSONB DEFAULT '{}'::jsonb,
      pinned_by TEXT[], archived_at TIMESTAMPTZ, related_op BIGINT,
      related_summary BIGINT, related_task VARCHAR(32), created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
}
async function ensureCollabColumns(pool) {
  await pool.query(`
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS raw JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS collab_status TEXT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS factory_token TEXT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS customer_token TEXT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS order_nos TEXT[];
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS contract_nos TEXT[];
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS order_contract_nos TEXT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS total_cartons NUMERIC;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS gross_weight_kg NUMERIC;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS total_cbm NUMERIC;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS forwarder_company_id INT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS forwarder_cn TEXT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS customer_en TEXT;
    ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS customer_cn TEXT;
  `);
}
async function companyLabel(pool, id, fallback) {
  if (!id) return fallback || "";
  const r = await pool.query(
    `SELECT COALESCE(name_cn, name_en, code, id::text) AS label FROM companies WHERE id = $1 LIMIT 1`,
    [id]
  ).catch(() => ({ rows: [] }));
  return r.rows[0]?.label || fallback || "";
}
async function enqueueDraft(pool, plan, item) {
  await ensureNotifications(pool);
  const ref = refOf(plan);
  const title = `待批外发: ${ref} ${item.recipient_label}`;
  const body = `${item.recipient_label}\n${item.url}\n\n${item.copy}`;
  await pool.query(
    `INSERT INTO notifications
       (type, level, title, body, payload, scope, scope_id, recipient_roles, channels, delivery_status)
     VALUES ('collab_outbound_draft', 'info', $1, $2, $3::jsonb, 'shipping_plan', $4,
             ARRAY['admin'], ARRAY['inapp'], '{"external":"pending_approval"}'::jsonb)`,
    [title, body, JSON.stringify({ ...item, shipment_id: plan.id, plan_business_id: plan._id }), String(plan.id)]
  );
}
async function insertMagicLink(pool, role, meta) {
  for (let i = 0; i < 3; i += 1) {
    const raw = genShortRaw();
    try {
      await pool.query(
        `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
        [rawToHash(raw), role, JSON.stringify(meta)]
      );
      return raw;
    } catch (e) {
      if (e && e.code === "23505") continue;
      throw e;
    }
  }
  throw new Error("magic_link_short_code_collision");
}
async function issueSupplier(pool, plan, party) {
  const segment = party === "customs" ? "customs" : party === "truck" ? "truck" : "ocean";
  const companyId = segment === "ocean" ? plan.forwarder_company_id : null;
  const fallback = segment === "customs" ? "报关行" : segment === "truck" ? "车队" : (plan.forwarder_cn || "货代");
  const label = await companyLabel(pool, companyId, fallback);
  const fieldProfile = segment === "ocean" && !companyId ? "shipping_booking" : undefined;
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1
        AND COALESCE(meta->>'auto_party','') = $2
        AND revoked_at IS NULL`,
    [plan.id, party]
  );
  const meta = {
    shipment_id: plan.id, plan_business_id: plan._id, segments: [segment],
    company_label: String(label || fallback).slice(0, 60), issued_via: "auto_collab",
    auto_party: party,
  };
  if (companyId) meta.company_id = companyId;
  if (fieldProfile) meta.field_profile = fieldProfile;
  const raw = await insertMagicLink(pool, "supplier_portal", meta);
  return {
    recipient_role: "supplier_portal", recipient_label: `${fallback} ${label || ""}`.trim(),
    token: raw, url: shortUrl(raw),
    direct_url: `${APP_BASE}/public/collab-portal.html?token=${encodeURIComponent(raw)}`,
    copy: `请填写/确认 ${refOf(plan)} 的${segment === "customs" ? "报关" : segment === "truck" ? "车队" : "海运订舱"}协同资料，完成后提交。`,
  };
}
async function issueFactory(pool, plan) {
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'factory_booking'
        AND (meta->>'shipment_id')::int = $1
        AND meta->'factory_scope' IS NULL AND revoked_at IS NULL`,
    [plan.id]
  );
  const raw = await insertMagicLink(pool, "factory_booking", {
    shipment_id: plan.id, plan_business_id: plan._id, issued_via: "auto_collab",
  });
  await pool.query(`UPDATE shipping_plans SET factory_token = $1, collab_status = 'collab_open' WHERE id = $2`, [rawToHash(raw), plan.id]);
  return {
    recipient_role: "factory_booking", recipient_label: "工厂",
    token: raw, url: shortUrl(raw),
    direct_url: `${APP_BASE}/public/collab-factory.html?token=${encodeURIComponent(raw)}`,
    copy: `请填写/确认 ${refOf(plan)} 的工厂装柜与出货协同资料，完成后提交。`,
  };
}
async function issueCustomer(pool, plan) {
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'customer_booking'
        AND (meta->>'shipment_id')::int = $1 AND revoked_at IS NULL`,
    [plan.id]
  );
  const raw = await insertMagicLink(pool, "customer_booking", {
    shipment_id: plan.id, plan_business_id: plan._id, issued_via: "auto_collab",
  });
  await pool.query(`UPDATE shipping_plans SET customer_token = $1, collab_status = 'collab_open' WHERE id = $2`, [rawToHash(raw), plan.id]);
  return {
    recipient_role: "customer_booking", recipient_label: "客户",
    token: raw, url: shortUrl(raw),
    direct_url: `${APP_BASE}/public/collab-customer.html?token=${encodeURIComponent(raw)}`,
    copy: `请填写/确认 ${refOf(plan)} 的客户订舱协同资料，完成后提交。`,
  };
}
async function loadPlan(pool, planOrId) {
  const r = typeof planOrId === "object" ? { rows: [planOrId] } : await pool.query(
    `SELECT id, _id, shipment_no, contract_no, forwarder_company_id, forwarder_cn FROM shipping_plans WHERE id = $1 LIMIT 1`,
    [planOrId]
  );
  return r.rows[0] || null;
}
export async function autoIssueCollabLinks(pool, planOrId, roles = ["forwarder", "factory", "customer", "customs"]) {
  await ensureCollabColumns(pool).catch(() => {});
  const plan = await loadPlan(pool, planOrId);
  if (!plan) return [];
  await pool.query(`UPDATE shipping_plans SET collab_status = 'collab_open' WHERE id = $1`, [plan.id]).catch(() => {});
  const issued = [];
  if (roles.includes("forwarder") || roles.includes("supplier") || roles.includes("ocean")) issued.push(await issueSupplier(pool, plan, "forwarder"));
  if (roles.includes("truck") || roles.includes("trucking")) issued.push(await issueSupplier(pool, plan, "truck"));
  if (roles.includes("customs") || roles.includes("broker")) issued.push(await issueSupplier(pool, plan, "customs"));
  if (roles.includes("factory")) issued.push(await issueFactory(pool, plan));
  if (roles.includes("customer")) issued.push(await issueCustomer(pool, plan));
  for (const item of issued.filter(Boolean)) await enqueueDraft(pool, plan, item);
  return issued.filter(Boolean);
}

export async function ensureOrderCollabOpen(pool, orderId, actor = "auto") {
  await ensureCollabColumns(pool);
  const { rows: ordRows } = await pool.query(
    `SELECT id, order_no, contract_no, company_code, company_name_en, company_name_cn,
            destination_port, pol, container_type, container_qty, total_qty, total_cbm,
            gross_weight, factory, issuing_company, shipping_plan_id
       FROM orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  const order = ordRows[0];
  if (!order || !order.order_no) return { plan: null, links: [] };
  let plan = null;
  if (order.shipping_plan_id) {
    const r = await pool.query(`SELECT id, _id, shipment_no, forwarder_company_id, forwarder_cn FROM shipping_plans WHERE id = $1 LIMIT 1`, [order.shipping_plan_id]);
    plan = r.rows[0] || null;
  }
  if (!plan) {
    const r = await pool.query(
      `SELECT id, _id, shipment_no, forwarder_company_id, forwarder_cn
         FROM shipping_plans
        WHERE $1 = ANY(COALESCE(order_nos, ARRAY[]::text[]))
           OR $2 = ANY(COALESCE(contract_nos, ARRAY[]::text[]))
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1`,
      [order.order_no, order.contract_no || ""]
    );
    plan = r.rows[0] || null;
  }
  if (!plan) {
    const sNoRes = await pool.query(
      "SELECT COALESCE(MAX(CAST(substring(shipment_no from 3) AS int)),145) + 1 AS n FROM shipping_plans WHERE shipment_no LIKE 'CY%' AND substring(shipment_no from 3) ~ '^[0-9]+$'"
    ).catch(() => ({ rows: [{ n: Math.floor(Date.now() / 1000) % 90000 }] }));
    const sNo = "CY" + String(Number(sNoRes.rows[0]?.n || 146)).padStart(5, "0");
    const portalId = "sp_order_" + order.id + "_" + Date.now();
    const ins = await pool.query(
      `INSERT INTO shipping_plans
         (_id, shipment_no, customer, customer_en, customer_cn, company_code,
          order_nos, contract_nos, order_contract_nos, pol, pod, container_type,
          container_qty, total_cartons, gross_weight_kg, total_cbm, flow_status,
          collab_status, raw, created_by, created_at, updated_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13,$14,$15,$16,
          '待订舱','collab_open',$17::jsonb,$18,NOW(),NOW())
       RETURNING id, _id, shipment_no, forwarder_company_id, forwarder_cn`,
      [
        portalId, sNo, order.company_name_en || order.company_name_cn || order.company_code || "",
        order.company_name_en || null, order.company_name_cn || null, order.company_code || null,
        [order.order_no], order.contract_no ? [order.contract_no] : [], order.contract_no || null,
        order.pol || null, order.destination_port || null, order.container_type || null,
        Number(order.container_qty) || 1, Number(order.total_qty) || null,
        Number(order.gross_weight) || null, Number(order.total_cbm) || null,
        JSON.stringify({ auto_created_from_order_id: order.id, factory: order.factory || null, issuing_company: order.issuing_company || null }),
        actor,
      ]
    );
    plan = ins.rows[0];
  } else {
    await pool.query(
      `UPDATE shipping_plans
          SET collab_status = 'collab_open',
              order_nos = CASE WHEN $2 = ANY(COALESCE(order_nos, ARRAY[]::text[])) THEN order_nos ELSE array_append(COALESCE(order_nos, ARRAY[]::text[]), $2) END,
              contract_nos = CASE WHEN COALESCE($3,'') = '' OR $3 = ANY(COALESCE(contract_nos, ARRAY[]::text[])) THEN contract_nos ELSE array_append(COALESCE(contract_nos, ARRAY[]::text[]), $3) END,
              updated_at = NOW()
        WHERE id = $1`,
      [plan.id, order.order_no, order.contract_no || ""]
    );
  }
  await pool.query(`UPDATE orders SET shipping_plan_id = COALESCE(shipping_plan_id, $1), status = COALESCE(NULLIF(status,''), 'pending') WHERE id = $2`, [plan.id, order.id]);
  const links = await autoIssueCollabLinks(pool, plan.id, ["factory", "forwarder", "customs", "customer"]);
  return { plan, links };
}
