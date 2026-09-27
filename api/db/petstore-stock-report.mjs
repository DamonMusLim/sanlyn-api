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
  const r = await pool.query(`
    SELECT s.product_code, b.barcode,
           s.product_name, s.spec, s.out_price, s.stock_num,
           COALESCE(c.shelf_no, s.shelf_list) AS shelf_location,
           sup.expire_date_batch AS recent_expiry
      FROM public.petstore_skus s
      LEFT JOIN LATERAL (
        SELECT pb.barcode
          FROM public.petstore_product_barcodes pb
         WHERE pb.product_code=s.product_code
         ORDER BY CASE WHEN pb.barcode=$1 THEN 0 ELSE 1 END, pb.barcode
         LIMIT 1
      ) b ON true
      LEFT JOIN public.petstore_product_status_current c
        ON c.product_code=s.product_code AND c.store_code=$2
      LEFT JOIN public.petstore_sku_supp sup ON sup.product_code=s.product_code
     WHERE s.product_code=$1 OR b.barcode=$1 OR s.product_name ILIKE '%' || $1 || '%'
     ORDER BY CASE WHEN b.barcode=$1 THEN 0 WHEN s.product_code=$1 THEN 1 ELSE 2 END,
              s.product_code LIMIT 20`,
    [query, STORE_CODE]);
  return r.rows.map((x) => ({
    product_code: x.product_code || "", barcode: x.barcode || "",
    product_name: x.product_name || "", spec: x.spec || "",
    price: x.out_price ?? null, stock: x.stock_num ?? null,
    location: shelfText(x.shelf_location), recent_expiry: x.recent_expiry || "",
  }));
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
