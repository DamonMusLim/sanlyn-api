import { getPool, setCors } from "../db.js";

const TIERS = ["lt20", "20_25", "25_28"];
const BOXES = ["20GP", "40HQ"];
const TAX_NOTICE = "本页所有拖车报价均为【含税价】(增值税已包含)。开票时不再另加税。";
const CITY_ALIASES = {
  "青岛": "青岛", "QINGDAO": "青岛",
  "厦门": "厦门", "XIAMEN": "厦门",
  "上海": "上海", "SHANGHAI": "上海",
  "宁波": "宁波", "NINGBO": "宁波",
  "锦州": "锦州", "JINZHOU": "锦州",
  "连云港": "连云港", "LIANYUNGANG": "连云港",
  "日照": "日照", "RIZHAO": "日照",
  "蛇口": "蛇口", "SHEKOU": "蛇口",
  "南沙": "南沙", "NANSHA": "南沙",
};
const ZONES = {
  "青岛": { zone_name: "青岛关区", scope: "前湾港区" },
  "厦门": { zone_name: "厦门关区", scope: "海沧东渡" },
  "上海": { zone_name: "上海关区", scope: "外高桥洋山" },
  "宁波": { zone_name: "宁波关区", scope: "北仑" },
  "锦州": { zone_name: "锦州关区", scope: "锦州港" },
  "连云港": { zone_name: "连云港关区", scope: "连云港港区" },
  "日照": { zone_name: "日照关区", scope: "日照港" },
  "蛇口": { zone_name: "深圳关区", scope: "蛇口港区" },
  "南沙": { zone_name: "南沙关区", scope: "南沙港区" },
};

function clean(v) { return v == null ? "" : String(v).trim(); }
function dateOnly(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function bodyOf(req) { return req.body || {}; }

let portAliasCache = null;
let portAliasCacheLoading = null;
let lastPortCacheWarnAt = 0;
let factoryAliasCache = null;
let factoryAliasCacheLoading = null;
let lastFactoryCacheWarnAt = 0;

function portKey(v) { return clean(v).toUpperCase().replace(/\s+/g, ""); }
function aliasKey(v) {
  return clean(v).normalize("NFKC").toLowerCase().replace(/[\s()（）]/g, "");
}

async function ensureFactoryAliasCache(pool) {
  if (factoryAliasCache) return factoryAliasCache;
  if (!factoryAliasCacheLoading) {
    factoryAliasCacheLoading = pool.query(
      `SELECT a.alias_text, a.normalized_alias, c.name_cn
         FROM company_aliases a
         JOIN companies c ON c.code = a.company_code
        WHERE a.status = 'active'
          AND COALESCE(c.name_cn, '') <> ''`
    ).then(({ rows }) => {
      const map = {};
      rows.forEach(r => {
        [r.alias_text, r.normalized_alias].forEach(v => {
          const key = aliasKey(v);
          if (key) map[key] = clean(r.name_cn);
        });
      });
      factoryAliasCache = map;
      factoryAliasCacheLoading = null;
      return map;
    }).catch(e => {
      const now = Date.now();
      if (now - lastFactoryCacheWarnAt > 60000) {
        lastFactoryCacheWarnAt = now;
        console.warn("[forwarder-services] company_aliases cache unavailable; using raw factory names", e && e.message);
      }
      factoryAliasCacheLoading = null;
      return {};
    });
  }
  return factoryAliasCacheLoading;
}

function normalizeFactory(raw, aliases) {
  const source = clean(raw) || "未标注工厂";
  const canon = aliases && aliases[aliasKey(source)];
  return { factory: canon || source, raw: source };
}

// 与 _lane-weeks.js:ensureLocalPortCache 同源,改一处要改两处
async function ensurePortCache(pool) {
  if (portAliasCache) return portAliasCache;
  if (!portAliasCacheLoading) {
    portAliasCacheLoading = pool.query(
      `SELECT name_cn, unlocode, code
         FROM ports
        WHERE COALESCE(name_cn, '') <> ''`
    ).then(({ rows }) => {
      const map = {};
      rows.forEach(r => {
        const name = clean(r.name_cn);
        [r.unlocode, r.code, r.name_cn].forEach(v => {
          const key = portKey(v);
          if (name && key) map[key] = name;
        });
      });
      portAliasCache = map;
      portAliasCacheLoading = null;
      return map;
    }).catch(e => {
      const now = Date.now();
      if (now - lastPortCacheWarnAt > 60000) {
        lastPortCacheWarnAt = now;
        console.warn("[forwarder-services] ports cache unavailable; using static aliases", e && e.message);
      }
      portAliasCacheLoading = null;
      return {};
    });
  }
  return portAliasCacheLoading;
}

function normalizePort(raw) {
  const s = clean(raw);
  if (!s) return "";
  const cached = portAliasCache && portAliasCache[portKey(s)];
  if (cached) return cached;
  const direct = CITY_ALIASES[s] || CITY_ALIASES[s.toUpperCase()];
  if (direct) return direct;
  const compact = s.replace(/\s+/g, "").toUpperCase();
  const key = Object.keys(CITY_ALIASES).find(k => compact.includes(k.replace(/\s+/g, "").toUpperCase()));
  return key ? CITY_ALIASES[key] : s;
}

function normalizeBox(raw) {
  const s = clean(raw).toUpperCase();
  if (s.includes("20")) return "20GP";
  if (s.includes("40")) return "40HQ";
  return s || "40HQ";
}

function zoneFields(port) {
  const zone = ZONES[port];
  return zone ? { zone_name: zone.zone_name, scope: zone.scope } : {};
}

function upsertCustomsPort(map, row, source) {
  const port = normalizePort(row.pol);
  if (!port) return;
  if (!map.has(port)) {
    map.set(port, Object.assign({
      port,
      source,
      last_clearance: { date: "", cargo: "", carrier: "" },
      rate_cny: null, commodities: [],
      meta: { inspection: true, advance_tax: false, permit: "如需许可证代办另议" },
    }, zoneFields(port)));
  } else {
    const item = map.get(port);
    if (item.source !== source) item.source = "both";
  }
  const item = map.get(port);
  const cargo = cargoOf(row);
  if (!item.last_clearance.date && (row.etd || cargo || row.carrier_code)) {
    item.last_clearance = { date: dateOnly(row.etd), cargo, carrier: clean(row.carrier_code) };
  }
  if (cargo && !item.commodities.includes(cargo) && item.commodities.length < 5) item.commodities.push(cargo);
}

async function validateToken(pool, code) {
  const { rows } = await pool.query(
    `SELECT code, forwarder_co, company_id, expires_at
       FROM forwarder_portal_tokens
      WHERE code = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [code]
  );
  return rows[0] || null;
}

async function getShipRows(pool, companyId) {
  const { rows } = await pool.query(
    `SELECT sp.id, sp.etd, sp.pol, sp.container_type, sp.carrier_code,
            sp.raw,
            COALESCE(NULLIF(BTRIM(o.factory), ''), '未标注工厂') AS factory,
            o.category, o.products
       FROM shipping_plans sp
       JOIN orders o ON o.order_no = ANY(sp.order_nos)
      WHERE sp.forwarder_company_id = $1
        AND COALESCE(sp.etd, sp.created_at::date, CURRENT_DATE) >= CURRENT_DATE - INTERVAL '6 months'
        -- Lens:只取货代已接过单的票(有承运/船名/订舱号或状态已推进),没接过的工厂/港口不露给货代
        AND (
          (sp.shipping_status IS NOT NULL AND lower(sp.shipping_status) NOT IN ('planned','draft','pending'))
          OR sp.carrier_code IS NOT NULL OR sp.vessel IS NOT NULL OR sp.booking_no IS NOT NULL
        )
      ORDER BY COALESCE(sp.etd, sp.created_at::date) DESC, sp.id DESC`,
    [companyId]
  );
  return rows;
}

async function getPaidCustomsRows(pool, companyId) {
  const normSql = (expr) => (
    `regexp_replace(lower(translate(COALESCE(${expr}, ''), '（）', '()')), '[[:space:]()]', '', 'g')`
  );
  const supplierNorm = normSql("b.supplier");
  const nameCnNorm = normSql("c.name_cn");
  const nameEnNorm = normSql("c.name_en");
  const sql = `
    WITH company AS (
      SELECT id, code, name_cn, name_en, ${nameCnNorm} AS name_cn_norm, ${nameEnNorm} AS name_en_norm
        FROM companies c
       WHERE c.id = $1
       LIMIT 1
    )
    SELECT sp.id, sp.etd, sp.pol, sp.container_type, sp.carrier_code,
           sp.raw, '' AS factory, '' AS category, '[]'::jsonb AS products,
           'paid_history' AS customs_port_source, sp.match_basis
      FROM freight_supplier_bills b
      JOIN company c ON true
      JOIN LATERAL (
        SELECT s.id, s.etd, s.pol, s.container_type, s.carrier_code, s.raw,
               CASE
                 WHEN NULLIF(BTRIM(b.link_plan_id::text), '') IS NOT NULL
                  AND (s.id::text = BTRIM(b.link_plan_id::text) OR s._id::text = BTRIM(b.link_plan_id::text))
                   THEN 'link_plan_id'
                 WHEN NULLIF(BTRIM(b.bl_no), '') IS NOT NULL AND BTRIM(s.bl_no) = BTRIM(b.bl_no)
                   THEN 'bl_no_exact'
                 ELSE 'bl_no_strip_carrier_prefix'
               END AS match_basis
          FROM shipping_plans s
         WHERE s.deleted_at IS NULL
           AND (
             (NULLIF(BTRIM(b.link_plan_id::text), '') IS NOT NULL
              AND (s.id::text = BTRIM(b.link_plan_id::text) OR s._id::text = BTRIM(b.link_plan_id::text)))
             OR (NULLIF(BTRIM(b.bl_no), '') IS NOT NULL AND BTRIM(s.bl_no) = BTRIM(b.bl_no))
             OR (
               NULLIF(regexp_replace(upper(BTRIM(COALESCE(b.bl_no, ''))), '^[A-Z]{4}', ''), '') IS NOT NULL
               AND regexp_replace(upper(BTRIM(COALESCE(s.bl_no, ''))), '^[A-Z]{4}', '')
                 = regexp_replace(upper(BTRIM(COALESCE(b.bl_no, ''))), '^[A-Z]{4}', '')
             )
           )
         ORDER BY
           CASE
             WHEN NULLIF(BTRIM(b.link_plan_id::text), '') IS NOT NULL
              AND (s.id::text = BTRIM(b.link_plan_id::text) OR s._id::text = BTRIM(b.link_plan_id::text)) THEN 0
             WHEN NULLIF(BTRIM(b.bl_no), '') IS NOT NULL AND BTRIM(s.bl_no) = BTRIM(b.bl_no) THEN 1
             ELSE 2
           END,
           s.id DESC
         LIMIT 1
      ) sp ON true
     WHERE b.canonical_category = 'customs_declaration'
       AND COALESCE(b.rebill_status, '') <> 'voided'
       AND COALESCE(b.amount, 0) > 0
       AND (
         (${supplierNorm} <> '' AND (
           ${supplierNorm} = c.name_cn_norm
           OR ${supplierNorm} = c.name_en_norm
           OR (${nameCnNorm} <> '' AND ${supplierNorm} LIKE '%' || c.name_cn_norm || '%')
           OR (${nameCnNorm} <> '' AND c.name_cn_norm LIKE '%' || ${supplierNorm} || '%')
           OR (${nameEnNorm} <> '' AND ${supplierNorm} LIKE '%' || c.name_en_norm || '%')
           OR (${nameEnNorm} <> '' AND c.name_en_norm LIKE '%' || ${supplierNorm} || '%')
         ))
         OR (NULLIF(BTRIM(b.supplier_company_code), '') IS NOT NULL AND b.supplier_company_code = c.code)
       )
     ORDER BY sp.etd DESC NULLS LAST, sp.id DESC`;
  const { rows } = await pool.query(sql, [companyId]);
  return rows;
}

async function getRates(pool, companyId, service) {
  const { rows } = await pool.query(
    `SELECT factory, port, container_type, tier, rate_cny, tax_included,
            tax_rate, service_nature, rate_cny_ex_tax, updated_at
       FROM forwarder_service_rates
      WHERE forwarder_company_id = $1 AND service = $2`,
    [companyId, service]
  );
  return rows;
}

function ratePayload(r) {
  const taxRate = r.tax_rate == null ? null : Number(r.tax_rate);
  const exTax = r.rate_cny_ex_tax == null ? null : Number(r.rate_cny_ex_tax);
  const nature = clean(r.service_nature) || null;
  return {
    rate_cny: r.rate_cny == null ? null : Number(r.rate_cny),
    tax_included: r.tax_included !== false,
    tax_rate: taxRate,
    service_nature: nature,
    rate_cny_ex_tax: exTax,
    comparable_ex_tax: taxRate != null && exTax != null,
    tax_identity_unconfirmed: !nature || taxRate == null,
    updated_at: r.updated_at
  };
}

function taxLabel(row) {
  if (!row || row.tax_rate == null) return null;
  const parts = [clean(row.invoice_item_name), clean(row.invoice_type)].filter(Boolean);
  parts.push((Number(row.tax_rate) * 100).toFixed(0) + "%");
  return parts.join(" · ");
}

async function getForwarderTax(pool, companyId, service) {
  const { rows } = await pool.query(
    `SELECT c.vat_taxpayer_type AS service_nature,
            r.tax_rate, r.invoice_item_name, r.invoice_type
       FROM companies c
       LEFT JOIN LATERAL (
         SELECT tax_rate, invoice_item_name, invoice_type
           FROM fee_tax_rules
          WHERE service_nature = c.vat_taxpayer_type
            AND ($2 <> 'truck' OR service_nature IN ('other_agency_service', 'own_fleet_land_transport', 'intl_transport_or_forwarding'))
          LIMIT 1
       ) r ON TRUE
      WHERE c.id = $1
      LIMIT 1`,
    [companyId, service]
  );
  const row = rows[0] || {};
  const nature = clean(row.service_nature) || null;
  const taxRate = row.tax_rate == null ? null : Number(row.tax_rate);
  const confirmed = !!nature && Number.isFinite(taxRate);
  return {
    service_nature: nature,
    tax_rate: confirmed ? taxRate : null,
    label: confirmed ? taxLabel(row) : "开票身份待确认",
    confirmed
  };
}

function exTax(rate, taxRate) {
  return taxRate == null ? null : Math.round(rate / (1 + taxRate) * 100) / 100;
}

function cargoOf(row) {
  // 只用短类目(orders.category / raw类目 / 产品的类目字段),绝不落到整串产品名,避免货类chip污染
  if (clean(row.category)) return clean(row.category);
  const raw = row.raw || {};
  if (clean(raw.cargo_type || raw.cargoType || raw.product_category)) return clean(raw.cargo_type || raw.cargoType || raw.product_category);
  const products = Array.isArray(row.products) ? row.products : [];
  const p = products[0] || {};
  return clean(p.category || p.cat1_cn) || "一般货";
}

async function handleTruck(req, res, pool, token) {
  if (!token.company_id) return res.json({ ok: true, service: "truck", factories: [], tiers: TIERS, boxes: BOXES });
  await ensurePortCache(pool);
  const aliases = await ensureFactoryAliasCache(pool);
  const rows = await getShipRows(pool, token.company_id);
  const rates = await getRates(pool, token.company_id, "truck");
  const forwarderTax = await getForwarderTax(pool, token.company_id, "truck");
  const map = new Map();

  rows.forEach(row => {
    const resolved = normalizeFactory(row.factory, aliases);
    const factory = resolved.factory;
    const port = normalizePort(row.pol);
    if (!port) return;
    if (!map.has(factory)) map.set(factory, { factory, factory_raw_names: [], city: "", ports: [], rates: {} });
    const item = map.get(factory);
    if (!item.factory_raw_names.includes(resolved.raw)) item.factory_raw_names.push(resolved.raw);
    if (!item.ports.includes(port)) item.ports.push(port);
  });

  rates.forEach(r => {
    const resolved = normalizeFactory(r.factory, aliases);
    const factory = resolved.factory;
    const port = normalizePort(r.port);
    const box = normalizeBox(r.container_type);
    if (!map.has(factory)) map.set(factory, { factory, factory_raw_names: [], city: "", ports: [], rates: {} });
    const item = map.get(factory);
    if (!item.factory_raw_names.includes(resolved.raw)) item.factory_raw_names.push(resolved.raw);
    if (port && !item.ports.includes(port)) item.ports.push(port);
    item.rates[`${port}|${box}|${clean(r.tier)}`] = ratePayload(r);
  });

  const factories = Array.from(map.values()).sort((a, b) => {
    if (a.factory === "未标注工厂") return 1;
    if (b.factory === "未标注工厂") return -1;
    return a.factory.localeCompare(b.factory, "zh-Hans-CN");
  });
  return res.json({ ok: true, service: "truck", tax_notice: TAX_NOTICE, forwarder_tax: forwarderTax, factories, tiers: TIERS, boxes: BOXES });
}

async function handleCustoms(req, res, pool, token) {
  if (!token.company_id) return res.json({ ok: true, service: "customs", ports: [] });
  await ensurePortCache(pool);
  await ensureFactoryAliasCache(pool);
  const rows = await getShipRows(pool, token.company_id);
  const paidRows = await getPaidCustomsRows(pool, token.company_id);
  const rates = await getRates(pool, token.company_id, "customs");
  const forwarderTax = await getForwarderTax(pool, token.company_id, "customs");
  const map = new Map();

  rows.forEach(row => {
    upsertCustomsPort(map, row, "shipment");
  });
  paidRows.forEach(row => {
    upsertCustomsPort(map, row, "paid_history");
  });

  rates.forEach(r => {
    const port = normalizePort(r.port);
    if (!port) return;
    if (map.has(port)) map.get(port).rate_cny = r.rate_cny == null ? null : Number(r.rate_cny);
  });

  return res.json({ ok: true, service: "customs", tax_notice: TAX_NOTICE, forwarder_tax: forwarderTax, ports: Array.from(map.values()) });
}

async function saveQuote(req, res, pool, token) {
  if (!token.company_id) return res.status(403).json({ ok: false, error: "token missing company_id" });
  await ensurePortCache(pool);
  const body = bodyOf(req);
  const service = clean(body.service || body.svc);
  if (service === "insurance") return res.json({ ok: true, saved: false, skipped: "保险暂未开放" });
  if (service !== "truck" && service !== "customs") return res.status(400).json({ ok: false, error: "service invalid" });
  const rate = body.rate_cny == null ? null : Number(body.rate_cny);
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ ok: false, error: "rate_cny invalid" });

  const factory = service === "truck" ? clean(body.factory) || "未标注工厂" : "";
  const port = normalizePort(body.port);
  const box = service === "truck" ? normalizeBox(body.container_type) : "";
  const tier = service === "truck" ? clean(body.tier) : "";
  if (!port) return res.status(400).json({ ok: false, error: "port required" });
  if (service === "truck" && (!box || !TIERS.includes(tier))) return res.status(400).json({ ok: false, error: "truck key invalid" });
  const forwarderTax = await getForwarderTax(pool, token.company_id, service);
  const rateExTax = exTax(rate, forwarderTax.tax_rate);

  await pool.query(
    `INSERT INTO forwarder_service_rates
       (forwarder_company_id, service, factory, port, container_type, tier, rate_cny,
        tax_included, tax_rate, service_nature, rate_cny_ex_tax, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, NOW(), $11)
     ON CONFLICT (forwarder_company_id, service, factory, port, container_type, tier)
     DO UPDATE SET rate_cny = EXCLUDED.rate_cny, tax_included = true,
       tax_rate = EXCLUDED.tax_rate, service_nature = EXCLUDED.service_nature,
       rate_cny_ex_tax = EXCLUDED.rate_cny_ex_tax, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [token.company_id, service, factory, port, box, tier, rate, forwarderTax.tax_rate,
      forwarderTax.service_nature, rateExTax, token.forwarder_co || token.code || ""]
  );
  return res.json({ ok: true, saved: true, tax_notice: TAX_NOTICE, forwarder_tax: forwarderTax });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const fullPath = (req.path || req.url || "").replace(/\?.*/, "");
  const segments = fullPath.split("/").filter(Boolean);
  const code = segments[segments.indexOf("forwarder-services") + 1] || req.query?.code || "";
  const service = clean(req.query?.service || bodyOf(req).service || bodyOf(req).svc || "truck");

  try {
    const token = await validateToken(pool, code);
    if (!token) return res.status(410).json({ ok: false, error: "链接已过期" });
    if (req.method === "GET" && service === "truck") return await handleTruck(req, res, pool, token);
    if (req.method === "GET" && service === "customs") return await handleCustoms(req, res, pool, token);
    if (req.method === "GET" && service === "insurance") {
      return res.json({ ok: true, service: "insurance", available: false, reason: "未开放", policies: [] });
    }
    if (req.method === "POST" && segments[segments.length - 1] === "quote") return await saveQuote(req, res, pool, token);
    return res.status(404).json({ ok: false, error: "Not found" });
  } catch (e) {
    console.error("[forwarder-services]", e.message, e.stack);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
