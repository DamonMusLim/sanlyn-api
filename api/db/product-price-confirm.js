import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { verifyToken } from "../auth.js";

const KIND = "product_price_confirmation";
const ROLE = "factory_booking";
const DEFAULT_PUBLIC_HOST = "https://api.sanlyn.cn";

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function genToken() {
  return crypto.randomBytes(32).toString("hex");
}

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function parseJson(v, fallback) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

function extractJwt(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const raw = String(auth || "").trim();
  if (!raw) return null;
  const m = raw.match(/sanlyn_jwt\s*=?\s*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (raw.startsWith("Bearer ")) return raw.slice(7).trim();
  return raw;
}

function requireInternalJwt(req, res) {
  const user = verifyToken(extractJwt(req));
  if (!user || !["admin", "company", "finance", "logistics", "sales", "internal", "super_admin"].includes(user.role)) {
    res.status(401).json({ ok: false, error: "unauthorized", message: "internal JWT required" });
    return null;
  }
  return user;
}

function publicBase(req) {
  return String(process.env.PUBLIC_HOST || req.headers.origin || DEFAULT_PUBLIC_HOST).replace(/\/+$/, "");
}

async function validateToken(pool, raw) {
  if (!raw || String(raw).length < 16) return null;
  const r = await pool.query(
    `SELECT id, meta, expires_at
       FROM magic_links
      WHERE token_hash=$1 AND recipient_role=$2
        AND expires_at > NOW() AND revoked_at IS NULL
      LIMIT 1`,
    [hashToken(raw), ROLE]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const meta = parseJson(row.meta, {});
  if (meta?.kind !== KIND) return null;
  const orderNo = clean(meta.order_no, 80);
  if (!orderNo) return null;
  return { linkId: row.id, orderNo, factoryScope: meta.factory_scope || {}, expiresAt: row.expires_at };
}

function pickQty(p) {
  return money(p?.qty ?? p?.quantity ?? p?.carton_qty ?? p?.boxes ?? p?.ctn ?? 0);
}

function pickUnitPrice(p) {
  return money(p?.factoryPrice ?? p?.factory_price ?? p?.unit_price ?? p?.unitPrice ?? p?.price ?? 0);
}

function productName(p, idx) {
  return clean(p?.productName || p?.name || p?.desc || p?.sku || `产品${idx + 1}`, 160);
}

function productLines(order) {
  const raw = parseJson(order.raw, {});
  const products = Array.isArray(order.products) && order.products.length
    ? order.products
    : (Array.isArray(raw.products) ? raw.products : []);
  return products.map((p, idx) => ({
    idx,
    name: productName(p, idx),
    qty: pickQty(p),
    unit: clean(p?.unit || p?.unit_name || "箱", 24),
    unit_price: pickUnitPrice(p),
  }));
}

function sanitizeUploads(v) {
  if (!Array.isArray(v)) return [];
  return v.map((f) => ({
    name: clean(f?.name || f?.file_name || f?.filename, 160),
    url: clean(f?.url || f?.oss_url || f?.file_url, 500),
    type: clean(f?.type || f?.mime || f?.mime_type, 80),
    uploaded_at: clean(f?.uploaded_at || new Date().toISOString(), 40),
  })).filter((f) => f.url || f.name).slice(0, 50);
}

function sanitizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l, pos) => ({
    idx: Number.isInteger(Number(l?.idx)) ? Number(l.idx) : pos,
    name: clean(l?.name, 160),
    qty: money(l?.qty),
    unit_price: money(l?.unit_price),
  })).filter((l) => l.name && l.qty > 0).slice(0, 200);
}

function sameMoney(a, b) {
  return money(a) === money(b);
}

async function loadOrder(pool, orderNo) {
  const r = await pool.query(
    `SELECT id, order_no, company_code, factory_code, factory,
            currency, factory_amount, delivery_date, confirmed_ship_date,
            factory_confirmed_at, factory_confirmed_by, factory_confirmation_id,
            products, raw
       FROM orders
      WHERE order_no=$1
      LIMIT 1`,
    [orderNo]
  );
  return r.rows[0] || null;
}

async function latestConfirmation(pool, orderNo) {
  const r = await pool.query(
    `SELECT id, confirmed_price_lines, confirmed_factory_amount, confirmed_currency,
            uploaded_files, price_changed, review_status, confirmed_ship_date,
            note, confirmed_by, created_at
       FROM factory_confirmations
      WHERE order_no=$1 AND confirmation_kind='product_price'
      ORDER BY created_at DESC
      LIMIT 1`,
    [orderNo]
  );
  return r.rows[0] || null;
}

async function handleGet(req, res, pool, ctx) {
  const order = await loadOrder(pool, ctx.orderNo);
  if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });
  const confirmation = await latestConfirmation(pool, ctx.orderNo);
  return res.json({
    ok: true,
    kind: KIND,
    order: {
      order_no: order.order_no,
      currency: order.currency || "USD",
      factory_amount: order.factory_amount,
      delivery_date: order.delivery_date,
      confirmed_ship_date: order.confirmed_ship_date,
      products: productLines(order),
    },
    confirmation,
    uploads: confirmation?.uploaded_files || [],
    expires_at: ctx.expiresAt,
    factory_scope: ctx.factoryScope,
  });
}

async function handleConfirm(req, res, pool, ctx) {
  const body = req.body || {};
  const confirmedShipDate = clean(body.confirmed_ship_date || body.etd, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(confirmedShipDate)) {
    return res.status(400).json({ ok: false, error: "confirmed_ship_date_required" });
  }

  const confirmedLines = sanitizeLines(body.confirmed_lines);
  if (!confirmedLines.length) return res.status(400).json({ ok: false, error: "confirmed_lines_required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query(
      `SELECT id, order_no, company_code, factory_code, factory,
              currency, factory_amount, products, raw
         FROM orders WHERE order_no=$1 FOR UPDATE`,
      [ctx.orderNo]
    );
    const order = orderRes.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }

    const original = productLines(order);
    const originalByIdx = new Map(original.map((l) => [Number(l.idx), l]));
    const priceChanged = confirmedLines.some((line) => {
      const old = originalByIdx.get(Number(line.idx));
      return !old || !sameMoney(line.unit_price, old.unit_price);
    });
    const reviewStatus = priceChanged ? "needs_internal_review" : "auto_accepted";
    const amount = money(confirmedLines.reduce((sum, line) => sum + money(line.qty) * money(line.unit_price), 0));
    const currency = clean(body.confirmed_currency || order.currency || "USD", 8).toUpperCase();
    const uploads = sanitizeUploads(body.uploads);
    const note = clean(body.note, 1000) || null;
    const confirmedBy = clean(ctx.factoryScope?.label || ctx.factoryScope?.name || order.factory || order.factory_code || order.company_code || "factory", 160);

    const ver = await client.query(
      `SELECT GREATEST(COALESCE(MAX(version), 0) + 1, 2) AS version
         FROM factory_confirmations
        WHERE order_no=$1`,
      [ctx.orderNo]
    );
    const version = Number(ver.rows[0]?.version || 1);

    const ins = await client.query(
      `INSERT INTO factory_confirmations
         (order_no, token_id, company_code, confirmed_lines, confirmed_ship_date,
          note, confirmed_by, source, version, confirmation_kind,
          confirmed_price_lines, confirmed_factory_amount, confirmed_currency,
          uploaded_files, price_changed, review_status, raw)
       VALUES ($1,$2,$3,$4::jsonb,$5::date,$6,$7,'magic_link',$8,'product_price',
               $9::jsonb,$10,$11,$12::jsonb,$13,$14,$15::jsonb)
       RETURNING id, created_at`,
      [
        ctx.orderNo,
        String(ctx.linkId),
        order.factory_code || order.company_code || null,
        JSON.stringify(confirmedLines),
        confirmedShipDate,
        note,
        confirmedBy,
        version,
        JSON.stringify(confirmedLines),
        amount,
        currency,
        JSON.stringify(uploads),
        priceChanged,
        reviewStatus,
        JSON.stringify({ kind: KIND, factory_scope: ctx.factoryScope }),
      ]
    );
    const confirmId = ins.rows[0].id;

    const updateSql = reviewStatus === "auto_accepted"
      ? `UPDATE orders SET
           confirmed_ship_date=$1::date,
           confirmed_qty=$2::jsonb,
           factory_confirmed_at=NOW(),
           factory_confirmed_by=$3,
           factory_confirmation_id=$4,
           factory_amount=$5,
           updated_at=NOW()
         WHERE order_no=$6`
      : `UPDATE orders SET
           confirmed_ship_date=$1::date,
           confirmed_qty=$2::jsonb,
           factory_confirmed_at=NOW(),
           factory_confirmed_by=$3,
           factory_confirmation_id=$4,
           updated_at=NOW()
         WHERE order_no=$5`;
    const updateParams = reviewStatus === "auto_accepted"
      ? [confirmedShipDate, JSON.stringify(confirmedLines), confirmedBy, confirmId, amount, ctx.orderNo]
      : [confirmedShipDate, JSON.stringify(confirmedLines), confirmedBy, confirmId, ctx.orderNo];
    await client.query(updateSql, updateParams);
    await client.query("COMMIT");

    return res.json({
      ok: true,
      confirmation: {
        id: confirmId,
        order_no: ctx.orderNo,
        confirmed_price_lines: confirmedLines,
        confirmed_factory_amount: amount,
        confirmed_currency: currency,
        uploaded_files: uploads,
        price_changed: priceChanged,
        review_status: reviewStatus,
        confirmed_ship_date: confirmedShipDate,
        created_at: ins.rows[0].created_at,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function handleCreateLink(req, res, pool) {
  const user = requireInternalJwt(req, res);
  if (!user) return;
  const body = req.body || {};
  const orderNo = clean(body.order_no || req.query?.order_no, 80);
  if (!orderNo) return res.status(400).json({ ok: false, error: "order_no_required" });
  const order = await loadOrder(pool, orderNo);
  if (!order) return res.status(404).json({ ok: false, error: "order_not_found" });

  const raw = genToken();
  const factoryScope = body.factory_scope && typeof body.factory_scope === "object"
    ? body.factory_scope
    : { label: order.factory || order.factory_code || order.company_code || "" };
  const meta = { kind: KIND, order_no: orderNo, factory_scope: factoryScope };
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at, created_by)
     VALUES ($1,$2,$3::jsonb,NOW() + INTERVAL '7 days','[]'::jsonb,NOW(),$4)`,
    [hashToken(raw), ROLE, JSON.stringify(meta), user.username || user.email || user.uid || user.id || user.role || "internal"]
  );
  return res.status(201).json({
    ok: true,
    token: raw,
    url: `${publicBase(req)}/fp/${encodeURIComponent(raw)}`,
    expires_days: 7,
    meta,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    const action = clean(req.body?.action || req.query?.action, 40);
    if (req.method === "POST" && action === "create-link") return handleCreateLink(req, res, pool);

    const token = req.method === "GET" ? (req.query?.token || req.query?.t) : req.body?.token;
    const ctx = await validateToken(pool, token);
    if (!ctx) return res.status(401).json({ ok: false, error: "invalid_token" });
    if (req.method === "GET") return handleGet(req, res, pool, ctx);
    if (req.method === "POST") return handleConfirm(req, res, pool, ctx);
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  } catch (err) {
    console.error("[product-price-confirm]", err);
    return res.status(500).json({ ok: false, error: "internal_error", detail: err.message });
  }
}
