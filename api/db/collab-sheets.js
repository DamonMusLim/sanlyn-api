// /api/db/collab-sheets.js — 协同表（daigou 代购 / freight_external 外单货代）
// POST  /api/db/collab-sheets         → 建表 (需 JWT, Sanlyn 内部)
// GET   /api/db/collab-sheets?token=  → 按角色读
// PATCH /api/db/collab-sheets?token=  → 按角色写
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";
import crypto from "crypto";

// ── 兼容旧代码保留（daigou 默认白名单） ──
const CUSTOMER_FIELDS = new Set(["需求", "目的港", "收货人", "联系人"]);
const FACTORY_PRODUCT_FIELDS = new Set([
  "name", "qty", "nw_kg", "gw_kg", "cbm_m3", "can_invoice", "base_price",
]);
const FACTORY_FIELDS = new Set(["invoice_capable", "vat_rate"]);

// ── 白名单配置（服务端硬编码，不走 DB，防绕过） ──
const WHITELISTS = {
  daigou: {
    customer_fields: CUSTOMER_FIELDS,
    factory_product_fields: FACTORY_PRODUCT_FIELDS,
    factory_fields: FACTORY_FIELDS,
    has_factory_role: true,
  },
  freight_external: {
    // customer = 发货人（恒安等外单货主）。字段对齐 booking-instruction-v3 六步流程
    customer_fields: new Set([
      // Step1 货好日期+柜型+装运港
      "cargo_ready_date", "cargo_ready_note",
      "container_type", "container_note",
      "pol", "pol_note", "pod",
      // Step2 货物属性（含实木包装/熏蒸）
      "cargo_dangerous", "cargo_dangerous_note",
      "wood_packaging", "fumigation",
      // 拖车/报关 自办 or 代办
      "trucking_arrange", "customs_arrange",
      // Step5 贸易条款
      "trade_terms", "fob_arranger", "pickup_address", "import_assist",
      // Step6 基础
      "shipper_name", "marks", "contract_ref", "remarks",
    ]),
    // Step3/4 分柜货物明细（每柜重量尺寸独立 + 报关要素）
    customer_container_fields: new Set([
      "container_seq", "cargo_name", "hs_code", "elements", "pkg_qty",
      "nw_kg", "gw_kg", "cbm_m3",
    ]),
    factory_product_fields: null, // 无 factory 角色
    factory_fields: null,
    has_factory_role: false,      // freight_external 不发 factory token
  },
};

function getWhitelist(type) {
  return WHITELISTS[type] || WHITELISTS.daigou;
}

const VALID_TYPES = new Set(["daigou", "freight_external"]);

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function sheetNo(type) {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const r = crypto.randomInt(0, 10000).toString().padStart(4, "0");
  const prefix = type === "freight_external" ? "SL-货代" : "SL-代购";
  return `${prefix}-${y}${m}${day}-${r}`;
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
}

function fail(res, status = 403, message = "禁止访问") {
  return res.status(status).json({ error: message });
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function cloneJson(v) {
  return v == null ? {} : JSON.parse(JSON.stringify(v));
}

function pick(obj, keys) {
  const out = {};
  if (!isPlainObject(obj)) return out;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function sanitizeForRole(role, data, type = "daigou") {
  const wl = getWhitelist(type);
  const src = isPlainObject(data) ? data : {};
  if (role === "sanlyn") return cloneJson(src);

  if (role === "customer") {
    const out = { customer: pick(src.customer, wl.customer_fields) };
    // freight_external：多柜数组（每柜一条，字段白名单过滤）
    if (wl.customer_container_fields && isPlainObject(src.customer) &&
        Array.isArray(src.customer.containers)) {
      out.customer.containers = src.customer.containers.map(
        (c) => pick(c, wl.customer_container_fields)
      );
    }
    // daigou 专属：向客户暴露最终报价
    if (type === "daigou" && isPlainObject(src.quote) &&
        Object.prototype.hasOwnProperty.call(src.quote, "final_price")) {
      out.quote = { final_price: src.quote.final_price };
    }
    return out;
  }

  if (role === "factory") {
    if (!wl.has_factory_role) return {}; // freight_external 无 factory 角色
    const factory = isPlainObject(src.factory) ? src.factory : {};
    const outFactory = pick(factory, wl.factory_fields);
    if (Array.isArray(factory.products)) {
      outFactory.products = factory.products.map((p) => pick(p, wl.factory_product_fields));
    }
    return { factory: outFactory };
  }

  return {};
}

function normalizePatch(patch) {
  if (!isPlainObject(patch)) return null;
  if (isPlainObject(patch.data_json)) return patch.data_json;
  return patch;
}

function assertAllowedPatch(role, patch, type = "daigou") {
  const wl = getWhitelist(type);
  if (!isPlainObject(patch)) return false;
  if (role === "sanlyn") return true;

  const topKeys = Object.keys(patch);

  if (role === "customer") {
    if (topKeys.some((k) => k !== "customer")) return false;
    if (!isPlainObject(patch.customer)) return false;
    for (const [key, value] of Object.entries(patch.customer)) {
      if (key === "containers" && wl.customer_container_fields) {
        // 多柜数组：支持数组整体或 {index: itemPatch} 稀疏更新
        if (!Array.isArray(value) && !isPlainObject(value)) return false;
        const entries = Array.isArray(value)
          ? value.map((v, i) => [String(i), v])
          : Object.entries(value);
        for (const [idx, itemPatch] of entries) {
          if (!/^\d+$/.test(idx)) return false;
          if (itemPatch == null) continue;
          if (!isPlainObject(itemPatch)) return false;
          if (Object.keys(itemPatch).some((f) => !wl.customer_container_fields.has(f))) return false;
        }
      } else if (!wl.customer_fields.has(key)) {
        return false;
      }
    }
    return true;
  }

  if (role === "factory") {
    if (!wl.has_factory_role) return false; // freight_external 拒绝 factory 写操作
    if (topKeys.some((k) => k !== "factory")) return false;
    if (!isPlainObject(patch.factory)) return false;
    for (const [key, value] of Object.entries(patch.factory)) {
      if (key === "products") {
        if (!Array.isArray(value) && !isPlainObject(value)) return false;
        const entries = Array.isArray(value)
          ? value.map((v, i) => [String(i), v])
          : Object.entries(value);
        for (const [idx, itemPatch] of entries) {
          if (!/^\d+$/.test(idx)) return false;
          if (itemPatch == null) continue;
          if (!isPlainObject(itemPatch)) return false;
          if (Object.keys(itemPatch).some((field) => !wl.factory_product_fields.has(field))) return false;
        }
      } else if (!wl.factory_fields.has(key)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function mergeObject(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) {
      mergeObject(target[k], v);
    } else {
      target[k] = cloneJson(v);
    }
  }
}

function applyAllowedPatch(role, data, patch, type = "daigou") {
  const wl = getWhitelist(type);
  const next = cloneJson(data);
  if (role === "sanlyn") { mergeObject(next, patch); return next; }

  if (role === "customer") {
    if (!isPlainObject(next.customer)) next.customer = {};
    for (const [k, v] of Object.entries(patch.customer || {})) {
      if (k === "containers" && wl.customer_container_fields) {
        if (!Array.isArray(next.customer.containers)) next.customer.containers = [];
        const entries = Array.isArray(v)
          ? v.map((item, i) => [String(i), item])
          : Object.entries(v);
        for (const [idxText, itemPatch] of entries) {
          if (itemPatch == null) continue;
          const idx = Number(idxText);
          if (!isPlainObject(next.customer.containers[idx])) next.customer.containers[idx] = {};
          for (const [field, value] of Object.entries(itemPatch)) {
            if (wl.customer_container_fields.has(field)) {
              next.customer.containers[idx][field] = cloneJson(value);
            }
          }
        }
      } else if (wl.customer_fields.has(k)) {
        next.customer[k] = cloneJson(v);
      }
    }
    return next;
  }

  if (role === "factory") {
    if (!wl.has_factory_role) return next;
    if (!isPlainObject(next.factory)) next.factory = {};
    const factoryPatch = patch.factory || {};
    for (const [k, v] of Object.entries(factoryPatch)) {
      if (k !== "products") next.factory[k] = cloneJson(v);
    }
    if (Object.prototype.hasOwnProperty.call(factoryPatch, "products")) {
      if (!Array.isArray(next.factory.products)) next.factory.products = [];
      const entries = Array.isArray(factoryPatch.products)
        ? factoryPatch.products.map((v, i) => [String(i), v])
        : Object.entries(factoryPatch.products);
      for (const [idxText, itemPatch] of entries) {
        if (itemPatch == null) continue;
        const idx = Number(idxText);
        if (!isPlainObject(next.factory.products[idx])) next.factory.products[idx] = {};
        for (const [field, value] of Object.entries(itemPatch)) {
          if (wl.factory_product_fields && wl.factory_product_fields.has(field)) {
            next.factory.products[idx][field] = cloneJson(value);
          }
        }
      }
    }
    return next;
  }

  return next;
}

async function findByToken(pool, rawToken) {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length > 256) return null;

  const isShortCode = /^[0-9a-f]{6,8}$/i.test(rawToken) && rawToken.length <= 8;
  const whereClause = isShortCode ? "t.token LIKE $1" : "t.token = $1";
  const param = isShortCode ? rawToken.toLowerCase() + "%" : rawToken;

  const { rows } = await pool.query(
    `SELECT t.token, t.role, t.revoked_at, t.expires_at,
            t.bound_phone, t.phone_verified_at,
            s.id, s.sheet_no, s.status, s.schema_version, s.created_by,
            s.data_json, s.version, s.sheet_type,
            s.customer_submitted_at, s.factory_submitted_at,
            s.finalized_order_id, s.finalized_ref_id, s.finalized_ref_type,
            s.finalized_at, s.created_at, s.updated_at
     FROM collab_sheet_tokens t
     JOIN collab_sheets s ON s.id = t.sheet_id
     WHERE ${whereClause} LIMIT 1`,
    [param]
  );

  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

// ── 手机号门禁（fail-closed）──
// token 绑定了 bound_phone → 请求必须带 ?phone= 且完全匹配
// 30分钟内同 sheet 错 5 次 → 锁定
// 返回 null = 通过；返回 {status, message} = 拒绝
async function checkPhoneGate(pool, row, rawPhone, ip) {
  if (!row.bound_phone) return null; // 未绑定 = 旧链接兼容

  // sanlyn 内部 token 不要求手机号
  if (row.role === "sanlyn") return null;

  const normalize = (p) => String(p || "").replace(/[^\d]/g, "").replace(/^86/, "");
  const expect = normalize(row.bound_phone);
  const got = normalize(rawPhone);

  // 防爆破：30分钟内失败次数
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM collab_sheet_events
     WHERE sheet_id = $1 AND role = $2 AND action = 'phone_fail'
       AND created_at > now() - interval '30 minutes'`,
    [row.id, row.role]
  );
  if (cnt[0].n >= 5) {
    return { status: 429, message: "尝试次数过多，请30分钟后再试" };
  }

  // 未携带手机号 = 页面初次探测，提示验证但不计失败次数
  if (!got) return { status: 403, message: "需要手机号验证" };

  if (got !== expect) {
    await pool.query(
      `INSERT INTO collab_sheet_events (sheet_id, role, action, fields_json, ip)
       VALUES ($1, $2, 'phone_fail', $3::jsonb, $4)`,
      [row.id, row.role, JSON.stringify({ tail: got.slice(-4) }), ip]
    ).catch(() => {});
    return { status: 403, message: "手机号验证失败" };
  }

  if (!row.phone_verified_at) {
    await pool.query(
      "UPDATE collab_sheet_tokens SET phone_verified_at = now() WHERE token = $1",
      [row.token]
    ).catch(() => {});
  }
  return null;
}

async function buildPrefillFromCustomer(pool, customerId) {
  const prefill = {};

  const { rows: crows } = await pool.query(
    `SELECT raw, name FROM customers WHERE id = $1 LIMIT 1`,
    [customerId]
  );
  if (crows[0]) {
    const raw = isPlainObject(crows[0].raw) ? crows[0].raw : {};
    prefill.customer = {
      收货人: raw.consignee || raw.收货人 || crows[0].name || "",
      联系人: raw.contact_person || raw.联系人 || "",
      目的港: raw.destination_port || raw.目的港 || "",
      需求: "",
    };
  }

  const { rows: orows } = await pool.query(
    `SELECT o.order_no,
            array_agg(json_build_object(
              'name', oli.product_name,
              'qty',  oli.qty_ctn,
              'nw_kg', oli.nw_ctn
            ) ORDER BY oli.id) FILTER (WHERE oli.id IS NOT NULL) as lines
     FROM orders o
     LEFT JOIN order_line_items oli ON oli.order_id = o.id
     WHERE o.customer_id = $1
     GROUP BY o.id, o.order_no, o.created_at
     ORDER BY o.created_at DESC LIMIT 3`,
    [customerId]
  );

  if (orows.length > 0) {
    prefill._recent_orders = orows.map((r) => ({
      order_no: r.order_no,
      products: r.lines?.filter(Boolean) || [],
    }));
  }

  return prefill;
}

// ── POST /api/db/collab-sheets — 建表 (JWT required) ──
async function createSheet(req, res) {
  const pool = getPool();
  const user = extractUser(req);
  if (!user) return fail(res, 401, "请先登录");

  const body = req.body || {};
  const sheetType = body.sheet_type;
  if (!VALID_TYPES.has(sheetType)) {
    const hint = sheetType === "booking_collab"
      ? "托书协同请从出货计划协同表发起"
      : "允许类型: " + [...VALID_TYPES].join(" / ");
    return fail(res, 400, hint);
  }
  const customerId = body.customer_id ? Number(body.customer_id) : null;
  const wl = getWhitelist(sheetType);

  let initialData = isPlainObject(body.data_json) ? cloneJson(body.data_json) : {};

  // freight_external：同发货人上一票的稳定字段自动带入（港口/柜型/条款/拖报/木包装）
  if (sheetType === "freight_external") {
    const shipper = initialData.customer && initialData.customer.shipper_name;
    if (shipper) {
      try {
        const { rows: prev } = await pool.query(
          `SELECT data_json->'customer' AS c FROM collab_sheets
            WHERE sheet_type = 'freight_external'
              AND data_json->'customer'->>'shipper_name' = $1
              AND data_json->'customer'->>'pol' IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1`,
          [shipper]
        );
        const last = prev[0] && prev[0].c;
        if (last && typeof last === "object") {
          const STABLE = ["pol", "container_type", "trade_terms", "trucking_arrange",
            "customs_arrange", "wood_packaging", "fumigation", "pickup_address", "marks", "fob_arranger"];
          if (!isPlainObject(initialData.customer)) initialData.customer = {};
          for (const f of STABLE) {
            if (initialData.customer[f] == null && last[f] != null) initialData.customer[f] = last[f];
          }
        }
      } catch (e) { /* 预填失败不阻断建单 */ }
    }
  }

  // AI 预填仅 daigou 使用
  if (sheetType === "daigou" && customerId && body.ai_prefill !== false) {
    try {
      const aiData = await buildPrefillFromCustomer(pool, customerId);
      if (!isPlainObject(initialData.customer) || Object.keys(initialData.customer).length === 0) {
        if (aiData.customer) initialData.customer = aiData.customer;
      }
      if (aiData._recent_orders) initialData._recent_orders = aiData._recent_orders;
    } catch (e) {
      // AI 预填失败不阻断建单
    }
  }

  const createdBy = user.username || user.email || String(user.id || "system");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let sheet;
    for (let i = 0; i < 5; i++) {
      try {
        const inserted = await client.query(
          `INSERT INTO collab_sheets (sheet_no, sheet_type, created_by, data_json)
           VALUES ($1, $2, $3, $4::jsonb) RETURNING id, sheet_no`,
          [sheetNo(sheetType), sheetType, createdBy, JSON.stringify(initialData)]
        );
        sheet = inserted.rows[0];
        break;
      } catch (err) {
        if (err.code !== "23505" || i === 4) throw err;
      }
    }

    // freight_external 只发 sanlyn + customer 两个 token，不发 factory
    // bound_phones: {customer: "13800...", factory: "..."} → 手机号门禁（fail-closed）
    const boundPhones = isPlainObject(body.bound_phones) ? body.bound_phones : {};
    const cleanPhone = (p) => {
      const s = String(p || "").replace(/[^\d]/g, "");
      return s.length >= 7 && s.length <= 15 ? s : null;
    };

    const tokens = { sanlyn: makeToken(), customer: makeToken() };
    const roleRows = [
      ["sanlyn", tokens.sanlyn, null],
      ["customer", tokens.customer, cleanPhone(boundPhones.customer)],
    ];
    if (wl.has_factory_role) {
      tokens.factory = makeToken();
      roleRows.push(["factory", tokens.factory, cleanPhone(boundPhones.factory)]);
    }

    for (const [role, token, phone] of roleRows) {
      await client.query(
        `INSERT INTO collab_sheet_tokens (token, sheet_id, role, bound_phone)
         VALUES ($1, $2, $3, $4)`,
        [token, sheet.id, role, phone]
      );
    }

    await client.query(
      `INSERT INTO collab_sheet_events (sheet_id, role, action, fields_json, ip)
       VALUES ($1, 'sanlyn', 'create', $2::jsonb, $3)`,
      [sheet.id, JSON.stringify({ created_by: createdBy, customer_id: customerId, sheet_type: sheetType }), clientIp(req)]
    );

    await client.query("COMMIT");
    return res.json({ sheet_id: sheet.id, sheet_no: sheet.sheet_no, sheet_type: sheetType, tokens });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return fail(res, 500, "服务器错误");
  } finally {
    client.release();
  }
}

// ── GET /api/db/collab-sheets?token= ──
async function getSheet(req, res) {
  const pool = getPool();
  try {
    const row = await findByToken(pool, req.query.token);
    if (!row) return fail(res, 403, "禁止访问");

    const gate = await checkPhoneGate(pool, row, req.query.phone, clientIp(req));
    if (gate) return fail(res, gate.status, gate.message);

    await pool.query(
      "UPDATE collab_sheet_tokens SET last_used_at = now() WHERE token = $1",
      [req.query.token]
    );

    const type = row.sheet_type || "daigou";

    return res.json({
      sheet_id: row.id, sheet_no: row.sheet_no, status: row.status,
      sheet_type: type,
      schema_version: row.schema_version, role: row.role, version: row.version,
      data_json: sanitizeForRole(row.role, row.data_json, type),
      customer_submitted_at: row.customer_submitted_at,
      factory_submitted_at: row.factory_submitted_at,
      finalized_at: row.finalized_at,
      created_at: row.created_at, updated_at: row.updated_at,
    });
  } catch (err) {
    return fail(res, 500, "服务器错误");
  }
}

// ── PATCH /api/db/collab-sheets?token= ──
async function patchSheet(req, res) {
  const pool = getPool();
  const body = req.body || {};
  const baseVersion = Number(body.base_version);
  const patch = normalizePatch(body.patch);

  if (!Number.isInteger(baseVersion) || baseVersion < 1) return fail(res, 400, "请求无效");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const row = await findByToken(pool, req.query.token);
    if (!row) { await client.query("ROLLBACK"); return fail(res, 403, "禁止访问"); }

    const gate = await checkPhoneGate(pool, row, req.query.phone, clientIp(req));
    if (gate) { await client.query("ROLLBACK"); return fail(res, gate.status, gate.message); }

    const type = row.sheet_type || "daigou";

    if (!assertAllowedPatch(row.role, patch, type)) {
      await client.query("ROLLBACK"); return fail(res, 400, "字段不可修改");
    }

    if (baseVersion !== row.version) {
      await client.query("ROLLBACK"); return fail(res, 409, "需刷新");
    }

    const nextData = applyAllowedPatch(row.role, row.data_json, patch, type);

    const updated = await client.query(
      `UPDATE collab_sheets SET data_json = $1::jsonb, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3 RETURNING version, updated_at`,
      [JSON.stringify(nextData), row.id, row.version]
    );

    if (!updated.rows[0]) { await client.query("ROLLBACK"); return fail(res, 409, "需刷新"); }

    await client.query(
      "UPDATE collab_sheet_tokens SET last_used_at = now() WHERE token = $1",
      [req.query.token]
    );

    await client.query(
      `INSERT INTO collab_sheet_events (sheet_id, role, action, fields_json, ip)
       VALUES ($1, $2, 'patch', $3::jsonb, $4)`,
      [row.id, row.role, JSON.stringify(patch), clientIp(req)]
    );

    await client.query("COMMIT");

    return res.json({
      sheet_id: row.id, sheet_no: row.sheet_no, status: row.status,
      sheet_type: type,
      role: row.role, version: updated.rows[0].version,
      updated_at: updated.rows[0].updated_at,
      data_json: sanitizeForRole(row.role, nextData, type),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return fail(res, 500, "服务器错误");
  } finally {
    client.release();
  }
}

// ── GET ?action=list — admin list (JWT required) ──
async function listSheets(req, res) {
  const pool = getPool();
  const user = extractUser(req);
  if (!user) return fail(res, 401, "请先登录");

  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const type   = req.query.sheet_type || null;

  const conditions = [];
  const filterParams = [];
  if (status && status !== "all") { filterParams.push(status); conditions.push(`s.status = $${filterParams.length}`); }
  if (type   && VALID_TYPES.has(type)) { filterParams.push(type); conditions.push(`s.sheet_type = $${filterParams.length}`); }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const params = [...filterParams, limit, offset];
  const pLimit = params.length - 1;

  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.sheet_no, s.status, s.sheet_type, s.created_by,
              s.created_at, s.updated_at,
              s.customer_submitted_at, s.factory_submitted_at,
              s.finalized_order_id, s.finalized_ref_id, s.finalized_ref_type,
              s.finalized_at, s.version,
              s.data_json->'customer'->>'收货人'    AS customer_name,
              s.data_json->'customer'->>'目的港'    AS dest_port,
              s.data_json->'customer'->>'shipper_name' AS shipper_name,
              o.order_no AS linked_order_no
       FROM collab_sheets s
       LEFT JOIN orders o ON o.id::text = s.finalized_order_id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${pLimit} OFFSET $${pLimit + 1}`,
      params
    );
    const total = (await pool.query(
      `SELECT COUNT(*) FROM collab_sheets s ${where}`,
      filterParams
    )).rows[0].count;

    return res.json({ sheets: rows, total: Number(total), page, limit });
  } catch (err) {
    return fail(res, 500, "服务器错误");
  }
}

// ── GET ?action=detail&id=X ──
async function detailSheet(req, res) {
  const pool = getPool();
  const user = extractUser(req);
  if (!user) return fail(res, 401, "请先登录");

  const id = parseInt(req.query.id);
  if (!id) return fail(res, 400, "缺少 id");

  try {
    const { rows } = await pool.query(
      `SELECT s.*, o.order_no AS linked_order_no,
              t.sanlyn_tok, t.customer_tok, t.factory_tok
       FROM collab_sheets s
       LEFT JOIN orders o ON o.id::text = s.finalized_order_id
       LEFT JOIN LATERAL (
         SELECT
           MAX(CASE WHEN role='sanlyn'   THEN token END) AS sanlyn_tok,
           MAX(CASE WHEN role='customer' THEN token END) AS customer_tok,
           MAX(CASE WHEN role='factory'  THEN token END) AS factory_tok
         FROM collab_sheet_tokens
         WHERE sheet_id = s.id AND revoked_at IS NULL
       ) t ON true
       WHERE s.id = $1 LIMIT 1`,
      [id]
    );
    if (!rows[0]) return fail(res, 404, "找不到协同表");
    return res.json(rows[0]);
  } catch (err) {
    return fail(res, 500, "服务器错误");
  }
}

// ── CY 号生成（freight_external 用）──
const MIN_CY_SEQ = 146;
async function generateCyNo(pool) {
  try {
    const { rows } = await pool.query(
      "SELECT shipment_no FROM shipping_plans WHERE shipment_no ~ '^CY[0-9]{5}$' ORDER BY shipment_no DESC LIMIT 1"
    );
    const last = rows[0]?.shipment_no || "CY00000";
    const n = Math.max(parseInt(last.slice(2), 10), MIN_CY_SEQ) + 1;
    return "CY" + String(n).padStart(5, "0");
  } catch (e) {
    return "CY" + String(Date.now()).slice(-5);
  }
}

// ── POST ?action=link_order ──
async function linkOrder(req, res) {
  const pool = getPool();
  const user = extractUser(req);
  if (!user) return fail(res, 401, "请先登录");

  const { sheet_id, order_id, ref_id, ref_type } = req.body || {};
  if (!sheet_id) return fail(res, 400, "缺少 sheet_id");

  // 支持旧 order_id 参数（daigou）和新 ref_id+ref_type（freight）
  const finalRefId   = ref_id   ? String(ref_id)   : (order_id ? String(order_id) : null);
  const finalRefType = ref_type ? String(ref_type)  : "order";

  try {
    // freight_external：若关联的 shipping_plan 没有 CY 号，自动补生成
    if (finalRefType === "shipping_plan" && finalRefId) {
      const { rows: spRows } = await pool.query(
        "SELECT id, shipment_no FROM shipping_plans WHERE _id =  OR id::text =  LIMIT 1",
        [finalRefId]
      );
      if (spRows.length && !spRows[0].shipment_no) {
        const cyNo = await generateCyNo(pool);
        await pool.query(
          "UPDATE shipping_plans SET shipment_no = , updated_at = NOW() WHERE id = ",
          [cyNo, spRows[0].id]
        );
      }
    }

    await pool.query(
      `UPDATE collab_sheets
       SET finalized_order_id  = CASE WHEN $1 IS NULL THEN NULL ELSE CASE WHEN $3='order' THEN $1 ELSE finalized_order_id END END,
           finalized_ref_id    = $1,
           finalized_ref_type  = CASE WHEN $1 IS NULL THEN NULL ELSE $3 END,
           finalized_at        = CASE WHEN $1 IS NULL THEN NULL ELSE now() END,
           updated_at          = now()
       WHERE id = $2`,
      [finalRefId, sheet_id, finalRefType]
    );
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, 500, "服务器错误");
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;

  if (req.method === "GET"  && action === "list")       return listSheets(req, res);
  if (req.method === "GET"  && action === "detail")     return detailSheet(req, res);
  if (req.method === "POST" && action === "link_order") return linkOrder(req, res);
  if (req.method === "POST") return createSheet(req, res);
  if (req.method === "GET")  return getSheet(req, res);
  if (req.method === "PATCH") return patchSheet(req, res);
  return fail(res, 405, "方法不允许");
}
