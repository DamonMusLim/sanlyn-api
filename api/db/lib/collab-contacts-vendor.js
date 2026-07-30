// collab-contacts-vendor.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import { requireAuth } from "../../auth.js";
import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";

// ── GET /contacts?plan_id=<_id> — 四方联系人解析（内部用）─────
// 客户/工厂/车队/报关行：有真实手机/邮箱就返回；客户在 customers 注册过
// (phone_e164) 标 registered=true（她的手机号可直接登录主站）。
async function handleGetContacts(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });

  const planRow = await pool.query(
    `SELECT id, customer, customer_en, contract_no, order_contract_nos,
            customs_broker_id, customs_broker_cn, customs_cn,
            trucking_company_id, trucking_company_cn, trucking_cn
       FROM shipping_plans WHERE _id = $1 LIMIT 1`, [planId]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const p = planRow.rows[0];

  const out = { customer: null, factory: null, trucking: null, broker: null };

  // 客户 → customers 表（注册用户：phone_e164 即主站登录号）
  const custName = p.customer_en || p.customer;
  if (custName) {
    const r = await pool.query(
      `SELECT name, contact_name, contact_phone, contact_email, phone_e164, phone_verified
         FROM customers
        WHERE name ILIKE $1 OR name_en ILIKE $1 OR name_cn ILIKE $1
        LIMIT 1`, [custName.trim()]
    );
    const c = r.rows[0];
    if (c) out.customer = {
      name: COALESCE(c.name_cn, c.name_en), contact: c.contact_name || null,
      phone: c.phone_e164 || c.contact_phone || null,
      email: c.contact_email || null,
      registered: !!c.phone_e164,
    };
  }

  // 工厂 → 经 contract_no 找 orders.factory → companies
  const contracts = String(p.order_contract_nos || p.contract_no || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (contracts.length) {
    const r = await pool.query(
      `SELECT o.factory, c.contact_name, c.contact_phone
         FROM orders o
         LEFT JOIN companies c ON (c.name_en = o.factory OR c.name_cn = o.factory)
        WHERE o.contract_no = ANY($1) AND o.factory IS NOT NULL
        LIMIT 1`, [contracts]
    );
    const f = r.rows[0];
    if (f) out.factory = {
      name: f.factory, contact: f.contact_name || null,
      phone: f.contact_phone || null, email: null, registered: false,
    };
  }

  // 车队 / 报关行 → companies by id（内部固定供应商）
  for (const [key, id, fallbackName] of [
    ["trucking", p.trucking_company_id, p.trucking_company_cn || p.trucking_cn],
    ["broker",   p.customs_broker_id,   p.customs_broker_cn   || p.customs_cn],
  ]) {
    let row = null;
    if (id) {
      const r = await pool.query(
        `SELECT name, name_cn, contact_name, contact_phone FROM companies WHERE id = $1 LIMIT 1`, [id]);
      row = r.rows[0];
    } else if (fallbackName) {
      const r = await pool.query(
        `SELECT name, name_cn, contact_name, contact_phone FROM companies
          WHERE name_cn = $1 OR name = $1 LIMIT 1`, [fallbackName]);
      row = r.rows[0];
    }
    if (row) out[key] = {
      name: row.name_cn || row.name, contact: row.contact_name || null,
      phone: row.contact_phone || null, email: null, registered: false,
    };
    else if (fallbackName) out[key] = { name: fallbackName, contact: null, phone: null, email: null, registered: false };
  }

  return res.json({ ok: true, contacts: out });
}

// ── GET /supply-chain-options?plan_id=xxx ────────────────────────────────────
// Returns company lists by type (forwarders/trucking/brokers/factories/customers)
// for the CollabLinkPopup dropdowns.
async function handleSupplyChainOptions(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const byType = async (type) => {
    const r = await pool.query(
      `SELECT id, name_cn, COALESCE(name_en, name_cn) AS name, code
         FROM companies
        WHERE type = $1 AND (active IS NULL OR active = true)
          AND merged_into_code IS NULL
        ORDER BY name_cn NULLS LAST LIMIT 120`,
      [type]
    );
    return r.rows;
  };
  // 2026-07-06 根治: "货代"(中间人/intermediary,如上海洋宝宝)公司类型是 sanlyn_entity 不是 forwarder,
  // 之前intermediary选择器复用forwarders列表(只查type=forwarder)导致洋宝宝这类中间人永远选不到。
  const byTypeIn = async (types) => {
    const r = await pool.query(
      `SELECT id, name_cn, COALESCE(name_en, name_cn) AS name, code
         FROM companies
        WHERE type = ANY($1::text[]) AND (active IS NULL OR active = true)
          AND merged_into_code IS NULL
        ORDER BY name_cn NULLS LAST LIMIT 120`,
      [types]
    );
    return r.rows;
  };
  const [forwarders, trucking, brokers, factories, customers, intermediaries] = await Promise.all([
    byType("forwarder"),
    byType("trucking"),
    byType("customs_broker"),
    byType("factory"),
    byType("customer"),
    byTypeIn(["forwarder", "sanlyn_entity"]),
  ]);
  return res.json({ ok: true, companies: { forwarders, trucking, brokers, factories, customers, intermediaries } });
}

async function resolveUpstreamDownstreamToken(req, res, pool, raw) {
  if (!raw) {
    res.status(400).json({ ok: false, error: "token 必填" });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]
  );
  if (!rows.length) {
    res.status(403).json({ ok: false, error: "链接无效" });
    return null;
  }
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  if (meta.field_profile !== "upstream_downstream") {
    res.status(403).json({ ok: false, error: "无权操作承运方" });
    return null;
  }
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) {
    res.status(400).json({ ok: false, error: "plan 无效" });
    return null;
  }
  return { meta, planId };
}

// ── GET /collab-party-invoices?token= — godview 各方票据只读状态 ──
async function handleCollabPartyInvoices(req, res, pool) {
  const { token: raw } = req.query || {};
  const ctx = await resolveUpstreamDownstreamToken(req, res, pool, raw);
  if (!ctx) return;

  const { rows } = await pool.query(
    `SELECT sp.id, sp.contract_no, sp.order_nos, sp.factory_company_id,
            sp.customer, sp.customer_en,
            cf.code AS forwarder_code, COALESCE(cf.name_cn, cf.name_en) AS forwarder_name,
            ct.code AS trucking_code, COALESCE(ct.name_cn, ct.name_en) AS trucking_name,
            cb.code AS customs_code, COALESCE(cb.name_cn, cb.name_en) AS customs_name,
            cfac.code AS factory_code, COALESCE(cfac.name_cn, cfac.name_en) AS factory_name
       FROM shipping_plans sp
       LEFT JOIN companies cf ON cf.id = sp.forwarder_company_id
       LEFT JOIN companies ct ON ct.id = sp.trucking_company_id
       LEFT JOIN companies cb ON cb.id = sp.customs_broker_id
       LEFT JOIN companies cfac ON cfac.id = sp.factory_company_id
      WHERE sp.id = $1
      LIMIT 1`,
    [ctx.planId]
  );
  if (!rows.length) return res.status(404).json({ ok: false, error: "计划不存在" });

  const plan = rows[0];
  const orderNos = Array.isArray(plan.order_nos) ? plan.order_nos : [];
  const matchArr = [plan.contract_no, ...orderNos].map(v => String(v || "").trim()).filter(Boolean);

  const readIn = async (code) => {
    if (!code) return { received: false, count: 0, amount: 0, currency: null, invoice_nos: [] };
    const r = await pool.query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(amount_incl_tax),0) AS amt,
              COALESCE(ARRAY_REMOVE(ARRAY_AGG(invoice_no::text), NULL), ARRAY[]::text[]) AS nos,
              min(currency) AS currency
         FROM finance_invoices_in
        WHERE contract_nos::text[] && $1::text[]
          AND seller_company_code = $2`,
      [matchArr, code]
    );
    const row = r.rows[0] || {};
    const count = Number(row.n || 0);
    return {
      received: count > 0,
      count,
      amount: Number(row.amt || 0),
      currency: row.currency || null,
      invoice_nos: Array.isArray(row.nos) ? row.nos : [],
    };
  };
  const readOut = async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(amount_incl_tax),0) AS amt,
              COALESCE(ARRAY_REMOVE(ARRAY_AGG(invoice_no::text), NULL), ARRAY[]::text[]) AS nos,
              min(currency) AS currency
         FROM finance_invoices_out
        WHERE contract_nos::text[] && $1::text[]`,
      [matchArr]
    );
    const row = r.rows[0] || {};
    const count = Number(row.n || 0);
    return {
      issued: count > 0,
      count,
      amount: Number(row.amt || 0),
      currency: row.currency || null,
      invoice_nos: Array.isArray(row.nos) ? row.nos : [],
    };
  };

  const [oceanIn, truckIn, customsIn, factoryIn, customerOut] = await Promise.all([
    readIn(plan.forwarder_code),
    readIn(plan.trucking_code),
    readIn(plan.customs_code),
    plan.factory_company_id ? readIn(plan.factory_code) : Promise.resolve(null),
    readOut(),
  ]);

  return res.json({
    ok: true,
    parties: {
      ocean: { label: plan.forwarder_name || "海运货代", code: plan.forwarder_code || null, kind: "in", ...oceanIn },
      truck: { label: plan.trucking_name || "车队", code: plan.trucking_code || null, kind: "in", ...truckIn },
      customs: { label: plan.customs_name || "报关行", code: plan.customs_code || null, kind: "in", ...customsIn },
      factory: plan.factory_company_id
        ? { label: plan.factory_name || "工厂", code: plan.factory_code || null, kind: "in", assigned: true, ...factoryIn }
        : { label: "未指派", code: null, kind: "in", assigned: false },
      customer: { label: plan.customer_en || plan.customer || "客户", kind: "out", ...customerOut },
    },
  });
}

// ── GET /collab-vendor-options?token=&segment=ocean|truck|customs ──
async function handleCollabVendorOptions(req, res, pool) {
  const { token: raw, segment } = req.query || {};
  const ctx = await resolveUpstreamDownstreamToken(req, res, pool, raw);
  if (!ctx) return;
  const typeBySegment = { ocean: "forwarder", truck: "trucking", customs: "customs_broker" };
  const type = typeBySegment[segment];
  if (!type) return res.status(400).json({ ok: false, error: "segment 无效" });
  const { rows } = await pool.query(
    `SELECT id, name_cn, COALESCE(name_en, name_cn) AS name
       FROM companies
      WHERE type = $1 AND (active IS NULL OR active = true)
        AND merged_into_code IS NULL
        AND name_cn NOT LIKE '[已合并]%'
      ORDER BY name_cn NULLS LAST LIMIT 120`,
    [type]
  );
  return res.json({ ok: true, options: rows, companies: rows });
}

// ── POST /collab-assign-vendor — godview 选/换承运方并当场发子链 ──
async function handleCollabAssignVendor(req, res, pool) {
  const { token: raw, segment, company_id } = req.body || {};
  const ctx = await resolveUpstreamDownstreamToken(req, res, pool, raw);
  if (!ctx) return;
  const cfg = {
    ocean: {
      type: "forwarder",
      update: ["forwarder_company_id", "forwarder_cn"],
      role: "supplier_portal",
      page: "collab-portal.html",
      segments: ["ocean"],
    },
    truck: {
      type: "trucking",
      update: ["trucking_company_id", "trucking_company_cn"],
      role: "supplier_portal",
      page: "collab-portal.html",
      segments: ["truck"],
    },
    customs: {
      type: "customs_broker",
      update: ["customs_broker_id", "customs_broker_cn"],
      role: "supplier_portal",
      page: "collab-portal.html",
      segments: ["customs"],
    },
  }[segment];
  if (!cfg) return res.status(400).json({ ok: false, error: "segment 无效" });
  const companyId = parseInt(company_id, 10);
  if (!companyId) return res.status(400).json({ ok: false, error: "company_id 必填" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: companies } = await client.query(
      `SELECT id, name_cn, COALESCE(name_en, name_cn) AS name
         FROM companies
        WHERE id = $1 AND type = $2 AND (active IS NULL OR active = true)
          AND merged_into_code IS NULL
        LIMIT 1`,
      [companyId, cfg.type]
    );
    if (!companies.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "找不到可用承运方" });
    }
    const vendor = companies[0];
    const vendorName = vendor.name_cn || vendor.name || "";
    const planRow = await client.query(
      `SELECT _id FROM shipping_plans WHERE id = $1 LIMIT 1`,
      [ctx.planId]
    );
    if (!planRow.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "计划不存在" });
    }
    const planBusinessId = planRow.rows[0]._id || ctx.meta.plan_business_id || null;

    await client.query(
      `UPDATE shipping_plans
          SET ${cfg.update[0]} = $1, ${cfg.update[1]} = $2, updated_at = NOW()
        WHERE id = $3`,
      [companyId, vendorName, ctx.planId]
    );

    await client.query(
      `UPDATE magic_links SET revoked_at = NOW()
        WHERE recipient_role = 'supplier_portal'
          AND (meta->>'shipment_id')::int = $1
          AND meta->'segments' ? $2
          AND meta->>'field_profile' IS NULL
          AND revoked_at IS NULL`,
      [ctx.planId, cfg.segments[0]]
    );

    const childRaw = genRaw();
    const childMeta = { shipment_id: ctx.planId, plan_business_id: planBusinessId, segments: cfg.segments, company_label: vendorName || undefined };
    await client.query(
      `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
      [rawToHash(childRaw), cfg.role, JSON.stringify(childMeta)]
    );

    await client.query("COMMIT");
    return res.json({
      ok: true,
      vendor: { id: vendor.id, name: vendorName },
      link_url: `${APP_BASE}/kp?c=${childRaw}`,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

export { handleGetContacts, handleSupplyChainOptions, handleCollabPartyInvoices, handleCollabVendorOptions, handleCollabAssignVendor };
