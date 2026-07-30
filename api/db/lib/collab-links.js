// collab-links.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import { requireAuth } from "../../auth.js";
import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";

// ── POST /send-factory-link ────────────────────────────────────
async function handleSendFactoryLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, factory_label, container_seqs } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });
  // 多工厂分柜：factory_label=工厂名/代号, container_seqs=[1,2] 该厂负责的柜
  const scopeLabel = factory_label ? String(factory_label).slice(0, 60) : "";
  const scopeSeqs = Array.isArray(container_seqs)
    ? container_seqs.map(n => parseInt(n, 10)).filter(n => n > 0).slice(0, 50)
    : [];
  const scope = scopeLabel
    ? { label: scopeLabel, ...(scopeSeqs.length ? { seqs: scopeSeqs } : {}) }
    : null;

  if (!scope || !scope.label) {
    return res.status(400).json({ ok: false, error: "factory_scope_required" });
  }

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;

  // Revoke：factory_booking 必须有 scope，只撤同一工厂旧链接（多厂互不影响）
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'factory_booking'
        AND (meta->>'shipment_id')::int = $1
        AND meta->'factory_scope'->>'label' = $2
        AND revoked_at IS NULL`,
    [numericId, scope.label]
  );

  const raw = genRaw();
  const hash = rawToHash(raw);
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'factory_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id,
                            factory_scope: scope || undefined })]
  );
  await pool.query(
    `UPDATE shipping_plans SET factory_token = $1, collab_status = 'collab_open' WHERE id = $2`,
    [hash, numericId]
  );

  const link = `${APP_BASE}/kp?c=${raw}`;
  return res.json({ ok: true, magic_link: link });
}

// ── POST /send-customer-link ───────────────────────────────────
async function handleSendCustomerLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;

  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'customer_booking'
        AND (meta->>'shipment_id')::int = $1
        AND revoked_at IS NULL`,
    [numericId]
  );

  const raw = genRaw();
  const hash = rawToHash(raw);
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'customer_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id })]
  );
  await pool.query(
    `UPDATE shipping_plans SET customer_token = $1 WHERE id = $2`,
    [hash, numericId]
  );

  const link = `${APP_BASE}/kp?c=${raw}`;
  return res.json({ ok: true, magic_link: link });
}

// ── Main handler ──────────────────────────────────────────────
// ── POST /send-trucking-link | /send-broker-link ──────────────
// 车队/报关行单任务链接。自拖自报时由客户转发给他们自己的车队/报关行。
async function handleSendRoleLink(req, res, pool, role) {
  if (!requireAuth(req, res)) return;
  const { plan_id } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;
  const recipientRole = role + "_booking";

  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = $1
        AND (meta->>'shipment_id')::int = $2
        AND revoked_at IS NULL`,
    [recipientRole, numericId]
  );

  const raw = genRaw();
  const hash = rawToHash(raw);
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, recipientRole, JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id })]
  );

  const page = role === "trucking" ? "collab-trucking.html" : "collab-broker.html";
  const link = `${APP_BASE}/kp?c=${raw}`;
  return res.json({ ok: true, magic_link: link });
}

// ── POST /send-portal-link — 供应链端口（一司一链接，多段合一）──
// segments: ['ocean','truck','customs'] 子集；自拖自报票默认只给 ocean
async function handleSendPortalLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, segments, company_label } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;
  const segs = (Array.isArray(segments) ? segments : ["ocean", "truck", "customs"])
    .filter(s => ["ocean", "truck", "customs"].includes(s));
  if (!segs.length) return res.status(400).json({ ok: false, error: "segments 至少一段" });

  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1 AND revoked_at IS NULL
        AND COALESCE(meta->>'company_label','') = COALESCE($2,'')`,
    [numericId, company_label || ""]);

  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'supplier_portal', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id,
      segments: segs, company_label: String(company_label || "").slice(0, 60) || undefined })]);

  return res.json({ ok: true, segments: segs,
    magic_link: `${APP_BASE}/kp?c=${raw}` });
}

// ── GET|POST /master-preview-token ───────────────────────────────────────────
// Generates a short-lived magic_link so Sanlyn staff can open a party's view.
// Returns { ok: true, url: "https://ai.sanlyn.cn/public/collab-*.html?token=..." }
async function handleMasterPreviewToken(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const isPost = req.method === "POST";
  const src = isPost ? (req.body || {}) : (req.query || {});
  const { plan_id, party, segments } = src;
  // 2026-07-23 修复「👁 我代填」对工厂行报 factory_scope_required：
  // 前端工厂行传的是 factory_label（与 send-factory-link 同名），端口/发货人行传 company_label，
  // 这里两个都收，避免同一个"公司名"在两条接口上叫两个名字。
  const company_label = src.company_label || src.factory_label;
  if (!plan_id) return res.status(400).json({ ok: false, error: "plan_id 必填" });

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;

  let page = "collab-portal.html";
  let role = "supplier_portal";
  const meta = { shipment_id: numericId, plan_business_id: plan_id, preview: true };

  if (party === "customer") {
    page = "collab-customer.html";
    role = "customer_booking";
  } else if (party === "shipper") {
    // 2026-07-30 Damon 定：退役独立「发货人(shipper)」协同角色。
    // 发货人=工厂或我方贸易，非独立外部协同方；港杂费已归货代(forwarder)物流费。
    // 这是 shipper_booking magic_link 的唯一签发入口，直接拒绝，不再签发任何发货人链接。
    return res.status(410).json({ ok: false, error: "发货人角色已退役:港杂费归货代物流费" });
  } else if (party === "factory") {
    // 方案A：工厂页不再支持无 scope 全貌 preview；内部全貌走登录态 collab-hub。
    if (!company_label) {
      return res.status(400).json({ ok: false, error: "factory_scope_required" });
    }
    page = "collab-factory.html";
    role = "factory_booking";
    meta.factory_scope = { label: String(company_label).slice(0, 60) };
  } else {
    const segs = Array.isArray(segments) ? segments.filter(s => ["ocean","truck","customs","factory"].includes(s))
      : [party].filter(s => ["ocean","truck","customs"].includes(s));
    meta.segments = segs.length ? segs : ["ocean", "truck", "customs"];
    if (company_label) meta.company_label = String(company_label).slice(0, 60); else meta.field_profile = "shipping_booking";
  }

  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '2 hours', '[]'::jsonb, NOW())`,
    [rawToHash(raw), role, JSON.stringify(meta)]);

  return res.json({ ok: true, url: `${APP_BASE}/kp?c=${raw}` });
}

// ── POST /send-intermediary-link — 洋宝宝(货代居间人) / 巴匕(出口商) ──
const INTERMEDIARY_CONFIG = {
  oceanbaby: { company_label: "上海洋宝宝国际物流", segments: ["ocean"], field_profile: "shipping_booking" },
  babi: { company_label: "厦门巴匕进出口", segments: ["ocean","truck","customs","factory"], field_profile: "upstream_downstream" }
};

async function handleSendIntermediaryLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, intermediary } = req.body || {};
  if (!plan_id) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  if (!INTERMEDIARY_CONFIG[intermediary])
    return res.status(400).json({ ok: false, error: "intermediary 必须是 oceanbaby 或 babi" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;
  const cfg = INTERMEDIARY_CONFIG[intermediary];
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1 AND revoked_at IS NULL
        AND meta->>'field_profile' = $2`,
    [numericId, cfg.field_profile]);
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'supplier_portal', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({
      shipment_id: numericId, plan_business_id: plan_id,
      segments: cfg.segments, company_label: cfg.company_label,
      field_profile: cfg.field_profile,
      party_scope: { mode: "upstream_downstream" },
    })]);
  const page = "collab-portal.html";
  return res.json({ ok: true, magic_link: `${APP_BASE}/kp?c=${raw}` });
}

export { handleSendFactoryLink, handleSendCustomerLink, handleSendRoleLink, handleSendPortalLink, handleMasterPreviewToken, handleSendIntermediaryLink };
