import fs from "fs";
import path from "path";

const UPLOAD_DIR = "/opt/sanlyn-uploads/staff-stock-report";
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MANAGER_ROLES = new Set(["store_manager", "manager", "boss"]);
const REASONS = new Set(["missing", "wrong_location", "not_received", "damaged_expired", "unknown"]);
const FOUND_ACTIONS = new Set(["return_bound", "rebind_new"]);
const STORE_CODE = "63350001";

function json(res, status, data) { return res.status(status).json(data); }
function text(v, max = 160) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : ""; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function isManager(me) { return MANAGER_ROLES.has(String(me?.role || "")); }
function todayCn(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function savePhoto(photo, empId, now = Date.now) {
  const mime = text(photo?.mime || photo?.photo_mime, 80);
  const data = text(photo?.base64 || photo?.photo_base64 || photo?.data_base64, 20_000_000);
  if (!/^image\//.test(mime) || !data) throw new Error("照片必须是图片");
  const buf = Buffer.from(data, "base64");
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) throw new Error("照片超过6MB");
  const dirName = String(now());
  const dir = path.join(UPLOAD_DIR, String(empId), dirName);
  fs.mkdirSync(dir, { recursive: true });
  const ext = mime.includes("png") ? ".png" : ".jpg";
  const file = `stock_${Math.random().toString(36).slice(2, 8)}${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `${PUBLIC_HOST}/uploads/staff-stock-report/${empId}/${dirName}/${file}`;
}

async function requireStaff(req, pool) {
  const { verifyToken } = await import("./auth.js");
  const raw = req.query?.token || (req.headers.authorization || "").replace(/^Bearer /, "");
  const claims = verifyToken(raw);
  if (!claims || claims.role !== "staff" || !claims.employee_id) return { error: "unauthorized" };
  const r = await pool.query(
    `SELECT id, name, employee_code, role, company_code, employment_status
       FROM hr_employees WHERE id=$1`,
    [claims.employee_id]);
  const me = r.rows[0];
  if (!me || me.employment_status !== "active") return { error: "forbidden" };
  return { empId: claims.employee_id, me };
}

// 货位在库里可能是 JSON 数组串 ["5-305"],给人看要拆开
function shelfText(v) {
  if (!v) return "";
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a.filter(Boolean).join("、"); } catch { /* 不是 JSON 就原样 */ }
  return String(v);
}

async function lookupProduct(pool, q) {
  const query = text(q, 120);
  if (!query) return [];
  // 口径跟果冻橙后台复刻版(jdc 商品库 petstore-goods-list.js)同一套:petstore_ops_row + 效期快照,⛔别再另起一套查询
  const r = await pool.query(`
    SELECT r.product_code, r.barcode, r.product_name, r.spec_text, r.pic_url,
           r.store_price, COALESCE(k.stock_num, r.cur_stock) AS stock, r.shelf_code,   -- skus 每15分钟同步果冻橙,跟收银机同源
           e.expiration_date, (e.expiration_date - current_date)::int AS days_to_expire
      FROM public.petstore_ops_row r
      LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
      -- 效期快照现在每天追加一行(0927 实测 5047 行/724 品),只取最新一次
      LEFT JOIN LATERAL (SELECT x.expiration_date FROM public.petstore_offline_expiry_snapshot x
                          WHERE x.product_code = r.product_code ORDER BY x.captured_at DESC LIMIT 1) e ON true
     WHERE r.product_code = $1 OR r.barcode = $1 OR r.product_name ILIKE '%' || $1 || '%'
     ORDER BY CASE WHEN r.barcode = $1 THEN 0 WHEN r.product_code = $1 THEN 1 ELSE 2 END,
              COALESCE(k.month_sale, 0) DESC, r.product_code
     LIMIT 20`, [query]);
  return r.rows.map((x) => ({
    product_code: x.product_code || "", barcode: x.barcode || "",
    product_name: x.product_name || "", spec: x.spec_text || "",
    price: x.store_price ?? null, stock: x.stock ?? null,
    location: shelfText(x.shelf_code),
    // 没日期就是空,⛔不填今天/0
    recent_expiry: x.expiration_date ? String(x.expiration_date instanceof Date ? x.expiration_date.toISOString().slice(0, 10) : x.expiration_date).slice(0, 10) + (x.days_to_expire == null ? "" : x.days_to_expire < 0 ? "(已过期)" : `(剩 ${x.days_to_expire} 天)`) : "",
    img: x.pic_url || "",
  }));
}

// 库存预警:果冻橙「预警数量」全店都没设(petstore_offline_stock_snapshot.alarm_num 全 0,且快照停在 08-28),
// 所以不用那张表。口径跟补货意向一致:卖得动(近30天≥1件)但库存 ≤ 约一周的量。库存用 petstore_skus(15分钟同步)。
async function stockAlerts(pool) {
  const r = await pool.query(`
    SELECT r.product_code, r.barcode, r.product_name, r.spec_text, r.pic_url, r.shelf_code,
           COALESCE(k.stock_num, r.cur_stock, 0) AS stock, COALESCE(k.month_sale, 0) AS month_sale
      FROM public.petstore_ops_row r
      JOIN public.petstore_skus k ON k.product_code = r.product_code
     WHERE COALESCE(k.month_sale, 0) >= 1
       AND COALESCE(k.stock_num, r.cur_stock, 0) <= CEIL(COALESCE(k.month_sale, 0) / 4.0)
     ORDER BY COALESCE(k.stock_num, r.cur_stock, 0) ASC, k.month_sale DESC
     LIMIT 150`);
  return r.rows.map((x) => ({
    product_code: x.product_code, barcode: x.barcode || "", name: x.product_name || "", spec: x.spec_text || "",
    img: x.pic_url || "", location: shelfText(x.shelf_code), stock: Number(x.stock), month_sale: Number(x.month_sale),
  }));
}

// 盘点:复用 jdc 后台同一个接口的查询(api/db/petstore-stocktake.js listRows),不另写
async function stocktakeRows() {
  const { listRows } = await import("./petstore-stocktake.js");
  const out = await listRows({ query: { store_code: STORE_CODE, pageSize: 100 } });
  return (out.rows || []).map((x) => ({
    ymd: x.ymd, name: x.product_name || x.product_code, product_code: x.product_code,
    book_qty: x.book_qty, count_qty: x.count_qty, diff: x.diff, status: x.status || "", reason: x.reason || x.note || "",
  }));
}

// 本地商品目录:手机存一份,扫码/速查先查本地(跟 lookupProduct 同源),每 15 分钟刷新
async function catalog(pool) {
  const r = await pool.query(`
    SELECT r.product_code, r.barcode, r.product_name, r.spec_text, r.store_price,
           COALESCE(k.stock_num, r.cur_stock) AS stock, r.shelf_code, r.pic_url
      FROM public.petstore_ops_row r
      LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code`);
  return r.rows.map((x) => [x.product_code, x.barcode || "", x.product_name || "", x.spec_text || "",
    x.store_price == null ? null : Number(x.store_price), x.stock == null ? null : Number(x.stock),
    shelfText(x.shelf_code), x.pic_url || ""]);
}

async function addFrequentTodo(pool, me, productName, productCode, now) {
  const title = `重新定位+贴货位标签:${productName || productCode}`;
  const date = todayCn(now);
  const exists = await pool.query(
    `SELECT id FROM hr_day_agenda
      WHERE company_code=$1 AND work_date=$2 AND kind='task' AND title=$3 LIMIT 1`,
    [me.company_code, date, title]);
  if (exists.rows.length) return false;
  await pool.query(
    `INSERT INTO hr_day_agenda (company_code, work_date, kind, title, note, status, created_by)
     VALUES ($1,$2,'task',$3,$4,'open',$5)`,
    [me.company_code, date, title, `常丢商品，请重新定位并贴货位标签。商品编码:${productCode}`, "stock_report"]);
  return true;
}

async function addRebindTodo(pool, me, row, loc, now) {
  const oldLoc = text(row.bound_location, 120);
  const name = text(row.product_name, 160) || text(row.product_code, 80);
  const title = `改绑货位:${name} ${oldLoc || "未绑"}→${loc}`;
  const date = todayCn(now);
  const exists = await pool.query(
    `SELECT id FROM hr_day_agenda
      WHERE company_code=$1 AND work_date=$2 AND kind='task' AND title=$3 LIMIT 1`,
    [me.company_code, date, title]);
  if (exists.rows.length) return false;
  await pool.query(
    `INSERT INTO hr_day_agenda (company_code, work_date, kind, title, note, status, created_by)
     VALUES ($1,$2,'task',$3,$4,'open',$5)`,
    [me.company_code, date, title, `员工找到位置与绑定货位不同。本期只记待办，不自动改货位。商品编码:${row.product_code}`, "stock_report"]);
  return true;
}

async function createReport(pool, me, empId, b, now, photoSaver = savePhoto) {
  const productCode = text(b.product_code, 80);
  if (!productCode) return { status: 400, body: { success: false, error: "product_required" } };
  const photos = Array.isArray(b.photos) ? b.photos : [];
  if (!photos.length) return { status: 400, body: { success: false, error: "photo_required" } };
  const reason = text(b.reason, 40);
  if (!REASONS.has(reason)) return { status: 400, body: { success: false, error: "bad_reason" } };
  let urls;
  try { urls = photos.map((p) => photoSaver(p, empId, now)); }
  catch (e) { return { status: 400, body: { success: false, error: e.message } }; }
  const cnt = await pool.query(
    `SELECT COUNT(*)::int AS n FROM petstore_stock_reports
      WHERE company_code=$1 AND product_code=$2 AND created_at >= now() - interval '30 days'`,
    [me.company_code, productCode]);
  const prev = Number(cnt.rows[0]?.n || 0);
  const frequent = prev >= 1;
  const status = prev >= 2 ? "pending_confirm" : "searching";
  const r = await pool.query(
    `INSERT INTO petstore_stock_reports
       (company_code, product_code, barcode, product_name, bound_location,
        system_qty, actual_qty, reason, photos, status, is_frequent_lost,
        reported_by_employee_id, reported_by_name, shift_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
     RETURNING *`,
    [me.company_code, productCode, text(b.barcode, 80) || null, text(b.product_name, 200) || null,
     text(b.bound_location, 120) || null, num(b.system_qty), num(b.actual_qty), reason,
     JSON.stringify(urls), status, frequent, empId, me.name, text(b.shift_note, 300) || null]);
  const todo_created = frequent && prev === 1
    ? await addFrequentTodo(pool, me, text(b.product_name, 160), productCode, now())
    : false;
  return { status: 200, body: { success: true, data: r.rows[0], frequent_lost: frequent, todo_created } };
}

async function found(pool, me, empId, b, now, photoSaver = savePhoto) {
  const id = Number(b.id);
  const r = await pool.query(
    `SELECT * FROM petstore_stock_reports
      WHERE id=$1 AND company_code=$2 AND status='searching'`,
    [id, me.company_code]);
  const row = r.rows[0];
  if (!row) return { status: 404, body: { success: false, error: "not_found" } };
  const loc = text(b.found_location, 120);
  if (!loc) return { status: 400, body: { success: false, error: "found_location_required" } };
  const differs = text(row.bound_location, 120) && loc !== text(row.bound_location, 120);
  const action = text(b.found_action, 40);
  if (differs && !FOUND_ACTIONS.has(action)) return { status: 400, body: { success: false, error: "found_action_required" } };
  if (differs && action === "return_bound" && !(Array.isArray(b.photos) && b.photos.length)) {
    return { status: 400, body: { success: false, error: "return_photo_required" } };
  }
  let foundUrls = [];
  if (differs && action === "return_bound") {
    try { foundUrls = b.photos.map((p) => photoSaver(p, empId, now)); }
    catch (e) { return { status: 400, body: { success: false, error: e.message } }; }
  }
  const rebind_todo_created = differs && action === "rebind_new"
    ? await addRebindTodo(pool, me, row, loc, now())
    : false;
  const rr = await pool.query(
    `UPDATE petstore_stock_reports
        SET status='found', found_location=$3, found_action=$4,
            found_photos=COALESCE(found_photos,'[]'::jsonb) || $5::jsonb,
            found_at=now(), closed_at=now()
      WHERE id=$1 AND company_code=$2 RETURNING *`,
    [id, me.company_code, loc, action || null, JSON.stringify(foundUrls)]);
  return { status: 200, body: { success: true, data: rr.rows[0], rebind_todo_created } };
}

async function listReports(pool, me, empId, b) {
  const manager = isManager(me);
  const status = text(b.status, 40);
  const r = await pool.query(
    `SELECT *,
            (status='searching' AND created_at < now() - interval '24 hours') AS overdue
       FROM petstore_stock_reports
      WHERE company_code=$1
        AND ($2::boolean OR reported_by_employee_id=$3)
        AND ($4::text='' OR status=$4)
      ORDER BY created_at DESC LIMIT 200`,
    [me.company_code, manager, empId, status]);
  const rank = manager ? await pool.query(
    `SELECT product_code, max(product_name) AS product_name, COUNT(*)::int AS reports
       FROM petstore_stock_reports
      WHERE company_code=$1 AND created_at >= now() - interval '30 days'
      GROUP BY product_code HAVING COUNT(*) >= 2
      ORDER BY reports DESC, product_code LIMIT 20`,
    [me.company_code]) : { rows: [] };
  return { status: 200, body: { success: true, rows: r.rows, frequent_rank: rank.rows, manager } };
}

async function confirmLoss(pool, me, b, now) {
  if (!isManager(me)) return { status: 403, body: { success: false, error: "manager_required" } };
  const id = Number(b.id);
  const r = await pool.query(
    `SELECT * FROM petstore_stock_reports WHERE id=$1 AND company_code=$2`,
    [id, me.company_code]);
  const row = r.rows[0];
  if (!row) return { status: 404, body: { success: false, error: "not_found" } };
  if (row.status !== "pending_confirm") {
    const ageMs = now() - new Date(row.created_at).getTime();
    if (ageMs < 24 * 3600 * 1000) return { status: 400, body: { success: false, error: "too_early" } };
  }
  const lossQty = Math.max(0, Number(row.system_qty || 0) - Number(row.actual_qty || 0));
  const rr = await pool.query(
    `UPDATE petstore_stock_reports
        SET status='confirmed_lost', confirmed_by=$3, confirmed_at=now(),
            closed_at=now(), confirmed_loss_qty=$4
      WHERE id=$1 AND company_code=$2 RETURNING *`,
    [id, me.company_code, me.name, lossQty]);
  return { status: 200, body: { success: true, data: rr.rows[0] } };
}

async function defaultPoolFactory() {
  const { getPool } = await import("./db.js");
  return getPool();
}

async function defaultSetCors(req, res, methods) {
  const { setCors } = await import("./db.js");
  return setCors(req, res, methods);
}

export function makeHandler({ poolFactory = defaultPoolFactory, setCorsFn = defaultSetCors, verifyStaff = requireStaff, now = Date.now, photoSaver = savePhoto } = {}) {
  return async function handler(req, res) {
    await setCorsFn(req, res, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    const pool = await poolFactory();
    const auth = await verifyStaff(req, pool);
    if (auth.error) return json(res, auth.error === "unauthorized" ? 401 : 403, { success: false, error: auth.error });
    const b = req.method === "GET" ? req.query || {} : req.body || {};
    const action = text(b.action || "list", 40);
    try {
      let out;
      if (action === "product_lookup") out = { status: 200, body: { success: true, rows: await lookupProduct(pool, b.q || b.query || b.barcode) } };
      else if (action === "alerts") out = { status: 200, body: { success: true, rows: await stockAlerts(pool) } };
      else if (action === "stocktake") out = { status: 200, body: { success: true, rows: await stocktakeRows() } };
      else if (action === "catalog") out = { status: 200, body: { success: true, at: Date.now(), cols: ["code", "barcode", "name", "spec", "price", "stock", "location", "img"], rows: await catalog(pool) } };
      else if (action === "create") out = await createReport(pool, auth.me, auth.empId, b, now, photoSaver);
      else if (action === "found") out = await found(pool, auth.me, auth.empId, b, now, photoSaver);
      else if (action === "confirm_loss") out = await confirmLoss(pool, auth.me, b, now);
      else if (action === "list") out = await listReports(pool, auth.me, auth.empId, b);
      else out = { status: 400, body: { success: false, error: "bad_action" } };
      return json(res, out.status, out.body);
    } catch (e) {
      return json(res, 500, { success: false, error: e.message || "server_error" });
    }
  };
}

export default makeHandler();
