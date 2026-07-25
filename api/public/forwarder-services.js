import { getPool, setCors } from "../db.js";

const TIERS = ["lt20", "20_25", "25_28"];
const BOXES = ["20GP", "40HQ"];
const CITY_ALIASES = {
  "青岛": "青岛", "QINGDAO": "青岛",
  "厦门": "厦门", "XIAMEN": "厦门",
  "上海": "上海", "SHANGHAI": "上海",
  "宁波": "宁波", "NINGBO": "宁波",
  "锦州": "锦州", "JINZHOU": "锦州",
  "连云港": "连云港", "LIANYUNGANG": "连云港",
  "日照": "日照", "RIZHAO": "日照",
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
  "南沙": { zone_name: "南沙关区", scope: "南沙港区" },
};

function clean(v) { return v == null ? "" : String(v).trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function dateOnly(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function bodyOf(req) { return req.body || {}; }

function normalizePort(raw) {
  const s = clean(raw);
  if (!s) return "";
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
    `SELECT sp.id, sp.etd, sp.pol, sp.container_type, sp.trucking_cost_total,
            sp.customs_declare_fee, sp.carrier_code,
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

async function getRates(pool, companyId, service) {
  const { rows } = await pool.query(
    `SELECT factory, port, container_type, tier, rate_cny, updated_at
       FROM forwarder_service_rates
      WHERE forwarder_company_id = $1 AND service = $2`,
    [companyId, service]
  );
  return rows;
}

function ratePayload(r) {
  return { rate_cny: r.rate_cny == null ? null : Number(r.rate_cny), updated_at: r.updated_at };
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
  const rows = await getShipRows(pool, token.company_id);
  const rates = await getRates(pool, token.company_id, "truck");
  const map = new Map();

  rows.forEach(row => {
    const factory = clean(row.factory) || "未标注工厂";
    const port = normalizePort(row.pol);
    if (!port) return;
    const box = normalizeBox(row.container_type);
    if (!map.has(factory)) map.set(factory, { factory, city: "", ports: [], history: {}, rates: {} });
    const item = map.get(factory);
    if (!item.ports.includes(port)) item.ports.push(port);
    const cost = num(row.trucking_cost_total);
    const key = `${port}|${box}`;
    if (cost > 0 && !item.history[key]) item.history[key] = { rate_cny: cost, date: dateOnly(row.etd) };
  });

  rates.forEach(r => {
    const factory = clean(r.factory) || "未标注工厂";
    const port = normalizePort(r.port);
    const box = normalizeBox(r.container_type);
    if (!map.has(factory)) map.set(factory, { factory, city: "", ports: [], history: {}, rates: {} });
    const item = map.get(factory);
    if (port && !item.ports.includes(port)) item.ports.push(port);
    item.rates[`${port}|${box}|${clean(r.tier)}`] = ratePayload(r);
  });

  const factories = Array.from(map.values()).sort((a, b) => {
    if (a.factory === "未标注工厂") return 1;
    if (b.factory === "未标注工厂") return -1;
    return a.factory.localeCompare(b.factory, "zh-Hans-CN");
  });
  return res.json({ ok: true, service: "truck", factories, tiers: TIERS, boxes: BOXES });
}

async function handleCustoms(req, res, pool, token) {
  if (!token.company_id) return res.json({ ok: true, service: "customs", ports: [] });
  const rows = await getShipRows(pool, token.company_id);
  const rates = await getRates(pool, token.company_id, "customs");
  const map = new Map();

  rows.forEach(row => {
    const port = normalizePort(row.pol);
    if (!port) return;
    const zone = ZONES[port] || { zone_name: `${port}关区`, scope: `${port}港区` };
    if (!map.has(port)) {
      map.set(port, {
        port, zone_name: zone.zone_name, scope: zone.scope,
        last_clearance: { date: "", cargo: "", carrier: "" },
        history_fee: null, rate_cny: null, commodities: [],
        meta: { inspection: true, advance_tax: false, permit: "如需许可证代办另议" },
      });
    }
    const item = map.get(port);
    const cargo = cargoOf(row);
    if (!item.last_clearance.date) item.last_clearance = { date: dateOnly(row.etd), cargo, carrier: clean(row.carrier_code) };
    const fee = num(row.customs_declare_fee);
    if (fee > 0 && item.history_fee == null) item.history_fee = Math.round(fee);
    if (cargo && !item.commodities.includes(cargo) && item.commodities.length < 5) item.commodities.push(cargo);
  });

  rates.forEach(r => {
    const port = normalizePort(r.port);
    if (!port) return;
    const zone = ZONES[port] || { zone_name: `${port}关区`, scope: `${port}港区` };
    if (!map.has(port)) {
      map.set(port, {
        port, zone_name: zone.zone_name, scope: zone.scope,
        last_clearance: { date: "", cargo: "", carrier: "" },
        history_fee: null, rate_cny: null, commodities: [],
        meta: { inspection: true, advance_tax: false, permit: "如需许可证代办另议" },
      });
    }
    map.get(port).rate_cny = r.rate_cny == null ? null : Number(r.rate_cny);
  });

  return res.json({ ok: true, service: "customs", ports: Array.from(map.values()) });
}

async function saveQuote(req, res, pool, token) {
  if (!token.company_id) return res.status(403).json({ ok: false, error: "token missing company_id" });
  const body = bodyOf(req);
  const service = clean(body.service || body.svc);
  if (service === "insurance") return res.json({ ok: true, saved: false, skipped: "insurance branch unchanged" });
  if (service !== "truck" && service !== "customs") return res.status(400).json({ ok: false, error: "service invalid" });
  const rate = body.rate_cny == null ? null : Number(body.rate_cny);
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ ok: false, error: "rate_cny invalid" });

  const factory = service === "truck" ? clean(body.factory) || "未标注工厂" : "";
  const port = normalizePort(body.port);
  const box = service === "truck" ? normalizeBox(body.container_type) : "";
  const tier = service === "truck" ? clean(body.tier) : "";
  if (!port) return res.status(400).json({ ok: false, error: "port required" });
  if (service === "truck" && (!box || !TIERS.includes(tier))) return res.status(400).json({ ok: false, error: "truck key invalid" });

  await pool.query(
    `INSERT INTO forwarder_service_rates
       (forwarder_company_id, service, factory, port, container_type, tier, rate_cny, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
     ON CONFLICT (forwarder_company_id, service, factory, port, container_type, tier)
     DO UPDATE SET rate_cny = EXCLUDED.rate_cny, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [token.company_id, service, factory, port, box, tier, rate, token.forwarder_co || token.code || ""]
  );
  return res.json({ ok: true, saved: true });
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
    if (req.method === "POST" && segments[segments.length - 1] === "quote") return await saveQuote(req, res, pool, token);
    return res.status(404).json({ ok: false, error: "Not found" });
  } catch (e) {
    console.error("[forwarder-services]", e.message, e.stack);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
