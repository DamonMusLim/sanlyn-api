import crypto from "node:crypto";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
function genRaw() {
  return crypto.randomBytes(24).toString("hex");
}
function refOf(plan) {
  return plan.shipment_no || plan._id || plan.contract_no || String(plan.id);
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
async function issueForwarder(pool, plan) {
  if (!plan.forwarder_company_id) return null;
  const label = await companyLabel(pool, plan.forwarder_company_id, plan.forwarder_cn || "货代");
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1
        AND (meta->>'company_id')::int = $2
        AND revoked_at IS NULL`,
    [plan.id, plan.forwarder_company_id]
  );
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'supplier_portal', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({
      shipment_id: plan.id, plan_business_id: plan._id, segments: ["ocean"],
      company_label: String(label).slice(0, 60), company_id: plan.forwarder_company_id,
      issued_via: "auto_collab",
    })]
  );
  return {
    recipient_role: "supplier_portal", recipient_label: `货代 ${label}`,
    token: raw, url: `${APP_BASE}/public/collab-portal.html?token=${raw}`,
    copy: `请填写/确认 ${refOf(plan)} 的海运订舱协同资料，完成后提交。`,
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
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'factory_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({ shipment_id: plan.id, plan_business_id: plan._id, issued_via: "auto_collab" })]
  );
  await pool.query(`UPDATE shipping_plans SET factory_token = $1, collab_status = 'collab_open' WHERE id = $2`, [rawToHash(raw), plan.id]);
  return {
    recipient_role: "factory_booking", recipient_label: "工厂",
    token: raw, url: `${APP_BASE}/public/collab-factory.html?token=${raw}`,
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
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'customer_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({ shipment_id: plan.id, plan_business_id: plan._id, issued_via: "auto_collab" })]
  );
  await pool.query(`UPDATE shipping_plans SET customer_token = $1 WHERE id = $2`, [rawToHash(raw), plan.id]);
  return {
    recipient_role: "customer_booking", recipient_label: "客户",
    token: raw, url: `${APP_BASE}/public/collab-customer.html?token=${raw}`,
    copy: `请填写/确认 ${refOf(plan)} 的客户订舱协同资料，完成后提交。`,
  };
}
export async function autoIssueCollabLinks(pool, planOrId, roles = ["forwarder", "factory", "customer"]) {
  const r = typeof planOrId === "object" ? { rows: [planOrId] } : await pool.query(
    `SELECT id, _id, shipment_no, contract_no, forwarder_company_id, forwarder_cn FROM shipping_plans WHERE id = $1 LIMIT 1`,
    [planOrId]
  );
  const plan = r.rows[0];
  if (!plan) return [];
  const issued = [];
  if (roles.includes("forwarder")) issued.push(await issueForwarder(pool, plan));
  if (roles.includes("factory")) issued.push(await issueFactory(pool, plan));
  if (roles.includes("customer")) issued.push(await issueCustomer(pool, plan));
  for (const item of issued.filter(Boolean)) await enqueueDraft(pool, plan, item);
  return issued.filter(Boolean);
}
