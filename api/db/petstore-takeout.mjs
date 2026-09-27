import { createGdcCashierClient } from "../lib/gdc-cashier.mjs";

const STORE_CODE = process.env.GDC_STORE_CODE || "63350001";
const STATUS_MAP = {
  pending: ["WAIT_PICK", "UNPICKED", "pending", 10],
  picked: ["PICKED", "WAIT_TAKE", "picked", 20],
  done: ["DONE", "COMPLETED", "done", 30],
  cancelled: ["CANCELLED", "CANCELED", "cancelled", 40],
};
const CHANNELS = { 10: "美团", MEI_TUAN: "美团", ELE_ME: "饿了么" };
let unpickedCache = { at: 0, count: 0 };

function json(res, status, data) { return res.status(status).json(data); }
function text(v, max = 200) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : ""; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function platform(v) { return CHANNELS[v] || CHANNELS[String(v)] || "外卖"; }
function shelfText(v) {
  if (!v) return "";
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a.filter(Boolean).join("、"); } catch {}
  return String(v);
}

async function defaultPoolFactory() { const { getPool } = await import("./db.js"); return getPool(); }
async function defaultSetCors(req, res, methods) { const { setCors } = await import("./db.js"); return setCors(req, res, methods); }
async function requireStaff(req, pool) {
  const { verifyToken } = await import("./auth.js");
  const raw = req.query?.token || (req.headers.authorization || "").replace(/^Bearer /, "");
  const claims = verifyToken(raw);
  if (!claims || claims.role !== "staff" || !claims.employee_id) return { error: "unauthorized" };
  const r = await pool.query(`SELECT id,name,role,company_code,employment_status FROM hr_employees WHERE id=$1`, [claims.employee_id]);
  const me = r.rows[0];
  if (!me || me.employment_status !== "active") return { error: "forbidden" };
  return { empId: claims.employee_id, me };
}

function normalizeOrder(x) {
  return {
    order_no: text(x.order_no, 80), day_seq: text(x.day_seq, 40), recipient_name: text(x.recipient_name, 80),
    recipient_phone: text(x.recipient_phone, 80), remark: text(x.remark, 400), channel: platform(x.channel_code),
    order_status: x.order_status, pay_price: x.pay_price ?? null, quantity: n(x.quantity), order_time: x.order_time || "",
  };
}

async function listOrders(client, b) {
  const body = {
    page_number: Number(b.page || b.page_number || 1),
    page_size: Math.min(50, Number(b.page_size || 20)),
    start_time: Number(b.start_time || Date.now() - 3 * 86400_000),
    end_time: Number(b.end_time || Date.now()),
    store_code: STORE_CODE,
  };
  const st = text(b.status, 30);
  if (STATUS_MAP[st]) body.order_status = STATUS_MAP[st];
  const data = await client.list(body);
  return { success: true, rows: (data.list || []).map(normalizeOrder), status_map: STATUS_MAP };
}

async function pickRows(pool, orderNo) {
  const r = await pool.query(`SELECT product_code,barcode,quantity,picked,manual_count FROM petstore_takeout_picks WHERE order_no=$1`, [orderNo]);
  const m = new Map();
  r.rows.forEach((x) => m.set(String(x.product_code), x));
  return m;
}

async function enrichGoods(pool, goods, picks) {
  const codes = goods.map((g) => text(g.product_code, 80)).filter(Boolean);
  if (!codes.length) return goods;
  const r = await pool.query(`
    SELECT s.product_code,s.product_name,s.stock_num,COALESCE(c.shelf_no,s.shelf_list) AS shelf_location,
           array_agg(DISTINCT pb.barcode) FILTER (WHERE pb.barcode IS NOT NULL) AS barcodes
      FROM public.petstore_skus s
      LEFT JOIN public.petstore_product_status_current c ON c.product_code=s.product_code AND c.store_code=$2
      LEFT JOIN public.petstore_product_barcodes pb ON pb.product_code=s.product_code
     WHERE s.product_code = ANY($1::text[])
     GROUP BY s.product_code,s.product_name,s.stock_num,c.shelf_no,s.shelf_list`, [codes, STORE_CODE]);
  const by = new Map(r.rows.map((x) => [String(x.product_code), x]));
  return goods.map((g) => {
    const code = text(g.product_code, 80), info = by.get(code) || {}, p = picks.get(code) || {};
    const qty = n(g.quantity);
    const picked = n(p.picked || g.picked_quantity);
    return {
      product_name: text(g.product_name || info.product_name, 200), upc_code: text(g.upc_code, 80), product_code: code,
      main_pic_url: text(g.main_pic_url, 500), sku_spec: text(g.sku_spec, 160), quantity: qty, picked,
      manual_count: n(p.manual_count), stock: info.stock_num ?? null, location: shelfText(info.shelf_location),
      barcodes: Array.from(new Set([g.upc_code, ...(info.barcodes || [])].filter(Boolean).map(String))),
    };
  });
}

async function detail(client, pool, orderNo) {
  const data = await client.detail({ order_no: orderNo, store_code: STORE_CODE });
  const picks = await pickRows(pool, orderNo);
  const goods = await enrichGoods(pool, data.goods || [], picks);
  return { success: true, order: { order_no: orderNo, platform: platform(data.plat), ...(data.order || {}) }, goods };
}

async function barcodeProducts(pool, barcode) {
  const r = await pool.query(`SELECT product_code,barcode FROM public.petstore_product_barcodes WHERE barcode=$1`, [barcode]);
  return r.rows.map((x) => String(x.product_code));
}

async function addPick(pool, auth, orderNo, line, barcode, manual) {
  const r = await pool.query(`
    INSERT INTO petstore_takeout_picks(order_no,product_code,barcode,quantity,picked,manual_count,picker_employee_id,started_at,updated_at)
    VALUES($1,$2,$3,$4,1,$5,$6,now(),now())
    ON CONFLICT(order_no,product_code) DO UPDATE SET
      picked=LEAST(petstore_takeout_picks.quantity,petstore_takeout_picks.picked+1),
      manual_count=petstore_takeout_picks.manual_count+$5,
      barcode=COALESCE(EXCLUDED.barcode,petstore_takeout_picks.barcode),
      picker_employee_id=EXCLUDED.picker_employee_id,updated_at=now()
    RETURNING product_code,quantity,picked,manual_count`, [orderNo, line.product_code, barcode || line.upc_code || null, n(line.quantity), manual ? 1 : 0, auth.empId]);
  return r.rows[0];
}

async function scan(client, pool, auth, b, manual) {
  const orderNo = text(b.order_no, 80), code = text(b.barcode, 120), productCode = text(b.product_code, 80);
  if (!orderNo || (!code && !productCode)) return { status: 400, body: { success: false, error: "bad_request" } };
  const d = await detail(client, pool, orderNo);
  const alt = code ? await barcodeProducts(pool, code) : [];
  const line = d.goods.find((g) => (productCode && g.product_code === productCode) || g.upc_code === code || g.barcodes.includes(code) || alt.includes(g.product_code));
  if (!line) return { status: 200, body: { success: true, result: "not_in_order" } };
  if (n(line.picked) >= n(line.quantity)) return { status: 200, body: { success: true, result: "over", line } };
  const picked = await addPick(pool, auth, orderNo, line, code, manual);
  return { status: 200, body: { success: true, result: "ok", line: { ...line, ...picked } } };
}

async function complete(client, pool, auth, orderNo) {
  const d = await detail(client, pool, orderNo);
  const missing = d.goods.filter((g) => n(g.picked) < n(g.quantity)).map((g) => ({ product_code: g.product_code, product_name: g.product_name, missing: n(g.quantity) - n(g.picked) }));
  if (missing.length) return { status: 400, body: { success: false, error: "not_enough", missing } };
  const manual = d.goods.reduce((s, g) => s + n(g.manual_count), 0);
  await pool.query(`UPDATE petstore_takeout_picks SET completed_at=COALESCE(completed_at,now()),picker_employee_id=$2,manual_count=manual_count,updated_at=now() WHERE order_no=$1`, [orderNo, auth.empId]);
  return { status: 200, body: { success: true, write_picked: process.env.GDC_WRITE_PICKED === "1", message: process.env.GDC_WRITE_PICKED === "1" ? "已记录，果冻橙写回待接" : "已记录，请去果冻橙点拣货完成", manual_count: manual } };
}

export function makeHandler({ poolFactory = defaultPoolFactory, setCorsFn = defaultSetCors, verifyStaff = requireStaff, gdcClient = createGdcCashierClient() } = {}) {
  return async function handler(req, res) {
    await setCorsFn(req, res, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    const pool = await poolFactory(), auth = await verifyStaff(req, pool);
    if (auth.error) return json(res, auth.error === "unauthorized" ? 401 : 403, { success: false, error: auth.error });
    const b = req.method === "GET" ? req.query || {} : req.body || {};
    const action = text(b.action || "list", 40);
    try {
      if (action === "unpicked") {
        if (Date.now() - unpickedCache.at > 8000) {
          const data = await gdcClient.unpicked({ storeCode: STORE_CODE });
          unpickedCache = { at: Date.now(), count: n(data) };
        }
        return json(res, 200, { success: true, count: unpickedCache.count });
      }
      if (action === "list") return json(res, 200, await listOrders(gdcClient, b));
      if (action === "detail") return json(res, 200, await detail(gdcClient, pool, text(b.order_no, 80)));
      if (action === "scan") { const out = await scan(gdcClient, pool, auth, b, false); return json(res, out.status, out.body); }
      if (action === "manual_plus") { const out = await scan(gdcClient, pool, auth, b, true); return json(res, out.status, out.body); }
      if (action === "complete") { const out = await complete(gdcClient, pool, auth, text(b.order_no, 80)); return json(res, out.status, out.body); }
      return json(res, 400, { success: false, error: "bad_action" });
    } catch (e) {
      return json(res, 500, { success: false, error: e.message || "server_error" });
    }
  };
}

export const TAKEOUT_STATUS_MAP = STATUS_MAP;
export default makeHandler();
