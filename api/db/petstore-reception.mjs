import fs from "fs";
import path from "path";

const UPLOAD_DIR = "/opt/sanlyn-uploads/staff-reception";
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const RECEPTION_ON = { JINFANG: true };
// 预约/宠物/洗护/寄养表按果冻橙门店号存(金枋=63350001),员工表是公司代码 JINFANG,两套不能混用
const STORE_BY_COMPANY = { JINFANG: "63350001" };
const FLOWS = {
  checkin: ["booked", "arrived", "arrived"],
  start: ["arrived", "doing", "doing"],
  finish: ["doing", "waiting_pickup", "done"],
  picked_up: ["waiting_pickup", "picked_up", "done"],
};
const TIME_COL = { checkin: "checkin_at", start: "start_at_actual", finish: "finish_at", picked_up: "picked_up_at" };
const LINE_LABEL = {
  vaccine: "疫苗",
  rabies: "狂犬",
  deworm_internal: "体内驱虫",
  deworm_external: "体外驱虫",
};

function json(res, status, body) { return res.status(status).json(body); }
function text(v, max = 160) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : ""; }
function todayCn(now = new Date()) { return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function isOn(code) { return RECEPTION_ON[String(code || "").toUpperCase()] === true; }
function maskPhone(v) { const s = String(v || ""); return s ? `****${s.slice(-4)}` : ""; }
function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function dueState(due, today = todayCn()) {
  if (!due) return { state: "unknown", text: "未记录", days_left: null };
  const a = Date.parse(String(due).slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(today + "T00:00:00Z");
  const days = Math.round((a - b) / 86400000);
  if (days < 0) return { state: "overdue", text: `逾期 ${Math.abs(days)} 天`, days_left: days };
  if (days <= 7) return { state: "soon", text: `还剩 ${days} 天`, days_left: days };
  return { state: "ok", text: "正常", days_left: days };
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
  const file = `reception_${Math.random().toString(36).slice(2, 8)}${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `${PUBLIC_HOST}/uploads/staff-reception/${empId}/${dirName}/${file}`;
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
  if (!isOn(me.company_code)) return { error: "feature_off" };
  return { empId: claims.employee_id, me };
}

function apptRow(x) {
  return {
    id: x.id, time: String(x.start_at || "").slice(11, 16), pet_id: x.pet_id,
    pet_name: x.pet_name || x.service_pet_name || "", service: x.service_name || x.biz_type || "",
    customer_name: x.owner_name || "", status: x.reception_status || x.status || "",
  };
}

async function today(pool, me, b) {
  const day = text(b.date, 12) || todayCn();
  const ap = await pool.query(
    `SELECT a.id, a.pet_id, a.start_at, a.biz_type, a.service_name, a.owner_name,
            a.status, COALESCE(a.reception_status, a.status) AS reception_status,
            p.name AS pet_name
       FROM appointments a LEFT JOIN pet_profiles p ON p.id=a.pet_id
      WHERE a.store_code=$1 AND a.start_at::date=$2::date
        AND COALESCE(a.reception_status, a.status) <> 'cancelled'
      ORDER BY a.start_at ASC, a.id ASC`,
    [me.store_code, day]);
  const bo = await pool.query(
    `SELECT b.id, b.pet_id, b.check_in AS start_at, b.status, p.name AS pet_name,
            COALESCE(b.service_name,'寄养') AS service_name, p.owner_name
       FROM boarding_orders b LEFT JOIN pet_profiles p ON p.id=b.pet_id
      WHERE b.store_code=$1 AND b.status='in_house'
      ORDER BY b.check_in ASC, b.id ASC`,
    [me.store_code]);
  const q = { pending: [], doing: [], waiting_pickup: [], boarding: [] };
  for (const r of ap.rows) {
    const s = r.reception_status || "booked";
    if (s === "booked") q.pending.push(apptRow(r));
    else if (s === "arrived" || s === "doing") q.doing.push(apptRow(r));
    else if (s === "waiting_pickup") q.waiting_pickup.push(apptRow(r));
  }
  q.boarding = bo.rows.map(apptRow);
  return { status: 200, body: { success: true, date: day, feature: "reception", queues: q } };
}

async function transition(pool, me, empId, action, b) {
  const flow = FLOWS[action];
  const id = Number(b.id || b.appointment_id);
  if (!id) return { status: 400, body: { success: false, error: "id_required" } };
  const r = await pool.query(
    `SELECT id, COALESCE(reception_status, status) AS reception_status
       FROM appointments WHERE id=$1 AND store_code=$2`,
    [id, me.store_code]);
  const row = r.rows[0];
  if (!row) return { status: 404, body: { success: false, error: "not_found" } };
  if (row.reception_status !== flow[0]) {
    return { status: 400, body: { success: false, error: "bad_transition", from: row.reception_status, expected: flow[0] } };
  }
  const col = TIME_COL[action];
  const rr = await pool.query(
    `UPDATE appointments
        SET reception_status=$3, status=$4, ${col}=now(), reception_operator_id=$5,
            reception_operator_name=$6, updated_at=now()
      WHERE id=$1 AND store_code=$2 RETURNING id, status, reception_status`,
    [id, me.store_code, flow[1], flow[2], empId, me.name]);
  return { status: 200, body: { success: true, data: rr.rows[0] } };
}

async function ensurePet(pool, me, b) {
  const phone = text(b.owner_phone || b.phone, 30);
  const petName = text(b.pet_name, 60);
  if (!phone || !petName) throw Object.assign(new Error("phone_pet_required"), { statusCode: 400 });
  const found = await pool.query(
    `SELECT id FROM pet_profiles WHERE store_code=$1 AND owner_phone=$2 AND name=$3 LIMIT 1`,
    [me.store_code, phone, petName]);
  if (found.rows[0]) return found.rows[0].id;
  const ins = await pool.query(
    `INSERT INTO pet_profiles (store_code, name, species, breed, owner_name, owner_phone, remark, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
    [me.store_code, petName, text(b.species, 20) || null, text(b.breed, 60) || null,
     text(b.owner_name, 60) || "客户", phone, "接待端最小建档"]);
  return ins.rows[0].id;
}

async function createAppointment(pool, me, b) {
  let petId;
  try { petId = await ensurePet(pool, me, b); }
  catch (e) { return { status: e.statusCode || 500, body: { success: false, error: e.message } }; }
  const startAt = text(b.start_at || `${text(b.date, 12)} ${text(b.time, 8)}`, 40);
  const service = text(b.service_name || b.service, 80);
  if (!startAt || !service) return { status: 400, body: { success: false, error: "time_service_required" } };
  const r = await pool.query(
    `INSERT INTO appointments
       (store_code, pet_id, biz_type, service_name, owner_name, owner_phone, start_at, end_at,
        status, reception_status, book_source, remark)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamp,$7::timestamp + interval '1 hour',
             'booked','booked','staff_reception',$8)
     RETURNING id, pet_id, start_at, service_name, owner_name, status, reception_status`,
    [me.store_code, petId, text(b.biz_type, 30) || "grooming", service,
     text(b.owner_name, 60) || "客户", text(b.owner_phone || b.phone, 30), startAt, text(b.remark, 300) || null]);
  return { status: 200, body: { success: true, data: r.rows[0] } };
}

async function addIssueTodo(pool, me, petId, petName, issue, now) {
  const date = todayCn(new Date(now()));
  const title = `洗护异常:${petName || petId} ${issue}`;
  const exists = await pool.query(
    `SELECT id FROM hr_day_agenda
      WHERE company_code=$1 AND work_date=$2 AND kind='task' AND title=$3 LIMIT 1`,
    [me.company_code, date, title]);
  if (exists.rows.length) return false;
  await pool.query(
    `INSERT INTO hr_day_agenda (company_code, work_date, kind, title, note, status, created_by)
     VALUES ($1,$2,'task',$3,$4,'open','groom_report')`,
    [me.company_code, date, title, `洗护报告发现${issue}，请店长跟进。pet_id:${petId}`]);
  return true;
}

function shareText(petName, checks, words, photos) {
  const done = [];
  if (checks.ear_cleaned) done.push("耳朵清洁");
  if (checks.nail_trimmed) done.push("剪指甲");
  if (checks.anal_gland) done.push("挤肛门腺");
  const warn = checks.skin_normal === false || checks.has_flea ? "另外有一点需要留意，建议到店沟通。" : "";
  return [`${petName || "宝贝"}今天洗护完成啦。`, done.length ? `已完成:${done.join("、")}。` : "", words, warn, photos.join("\n")]
    .filter(Boolean).join("\n");
}

async function groomReport(pool, me, empId, b, now, photoSaver) {
  const id = Number(b.appointment_id || b.service_id);
  const before = Array.isArray(b.before_photos) ? b.before_photos : [];
  const after = Array.isArray(b.after_photos) ? b.after_photos : [];
  if (!id) return { status: 400, body: { success: false, error: "service_id_required" } };
  if (!before.length || !after.length) return { status: 400, body: { success: false, error: "photo_required" } };
  const ar = await pool.query(
    `SELECT a.id, a.pet_id, p.name AS pet_name FROM appointments a
      LEFT JOIN pet_profiles p ON p.id=a.pet_id
     WHERE a.id=$1 AND a.store_code=$2`,
    [id, me.store_code]);
  const ap = ar.rows[0];
  if (!ap) return { status: 404, body: { success: false, error: "not_found" } };
  let urls;
  try { urls = before.concat(after).map((p) => photoSaver(p, empId, now)); }
  catch (e) { return { status: 400, body: { success: false, error: e.message } }; }
  const checks = {
    ear_cleaned: bool(b.ear_cleaned), nail_trimmed: bool(b.nail_trimmed), anal_gland: bool(b.anal_gland),
    skin_normal: b.skin_normal === undefined ? null : bool(b.skin_normal), has_flea: bool(b.has_flea),
  };
  const words = text(b.owner_message || b.message, 500);
  const msg = shareText(ap.pet_name, checks, words, urls);
  const rr = await pool.query(
    `INSERT INTO grooming_reports
       (store_code, appointment_id, before_photos, after_photos, checks, skin_issue,
        next_advice, owner_message, share_text, operator, created_at)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,now())
     RETURNING id, share_text`,
    [me.store_code, id, JSON.stringify(urls.slice(0, before.length)), JSON.stringify(urls.slice(before.length)),
     JSON.stringify(checks), checks.skin_normal === false || checks.has_flea, words || null, words || null, msg, me.name]);
  const issue = checks.has_flea ? "有跳蚤" : (checks.skin_normal === false ? "皮肤异常" : "");
  const todo = issue ? await addIssueTodo(pool, me, ap.pet_id, ap.pet_name, issue, now) : false;
  if (issue) await pool.query(
    `INSERT INTO petstore_pet_notes (store_code, pet_id, note_type, title, body, source_ref, created_by)
     VALUES ($1,$2,'groom_issue',$3,$4,$5,$6)
     ON CONFLICT (store_code, pet_id, note_type, source_ref, title) DO NOTHING`,
    [me.store_code, ap.pet_id, issue, words || issue, `grooming_report:${rr.rows[0].id}`, me.name]);
  return { status: 200, body: { success: true, data: rr.rows[0], share_text: msg, photo_urls: urls, todo_created: todo } };
}

async function pet(pool, me, b) {
  const petId = Number(b.pet_id || 0);
  const phone = text(b.phone || b.owner_phone, 30);
  if (!petId && !phone) return { status: 400, body: { success: false, error: "pet_or_phone_required" } };
  const pr = await pool.query(
    `SELECT id, name, species, breed, birth_date, weight_kg, allergy_note, owner_name, owner_phone
       FROM pet_profiles
      WHERE store_code=$1 AND (($2::int>0 AND id=$2) OR ($3::text<>'' AND owner_phone=$3))
      ORDER BY id LIMIT 20`,
    [me.store_code, petId, phone]);
  const pets = pr.rows;
  const owner = pets[0] ? { name: pets[0].owner_name || "", phone_tail: maskPhone(pets[0].owner_phone) } : { name: "", phone_tail: maskPhone(phone) };
  const ids = pets.map((x) => x.id);
  const vr = ids.length ? await pool.query(
    `SELECT DISTINCT ON (pet_id, kind) pet_id, kind, executed_at, next_due_at, frequency_days
       FROM pet_vaccinations
      WHERE store_code=$1 AND pet_id=ANY($2::int[])
      ORDER BY pet_id, kind, COALESCE(executed_at, planned_at, next_due_at) DESC NULLS LAST, id DESC`,
    [me.store_code, ids]) : { rows: [] };
  const cr = await pool.query(
    `SELECT COALESCE(sum(remaining_times),0)::int AS remaining
       FROM member_cards
      WHERE store_code=$1 AND owner_phone=$2 AND status='active'`,
    [me.store_code, pets[0]?.owner_phone || phone]);
  const sr = ids.length ? await pool.query(
    `SELECT g.appointment_id AS id, a.pet_id, g.created_at, g.owner_message, g.share_text
       FROM grooming_reports g JOIN appointments a ON a.id=g.appointment_id
      WHERE g.store_code=$1 AND a.pet_id=ANY($2::int[])
      ORDER BY g.created_at DESC LIMIT 10`,
    [me.store_code, ids]) : { rows: [] };
  const linesByPet = {};
  for (const v of vr.rows) {
    const key = Object.entries(LINE_LABEL).find((x) => x[1] === v.kind)?.[0];
    if (!key) continue;
    (linesByPet[v.pet_id] ||= {})[key] = { ...v, ...dueState(v.next_due_at) };
  }
  const rows = pets.map((p) => ({ ...p, owner_phone: maskPhone(p.owner_phone), lines: linesByPet[p.id] || {} }));
  return { status: 200, body: { success: true, customer: owner, card_remaining: cr.rows[0]?.remaining || 0, pets: rows, recent_services: sr.rows, common_products: [] } };
}

async function defaultPoolFactory() { const { getPool } = await import("./db.js"); return getPool(); }
async function defaultSetCors(req, res, methods) { const { setCors } = await import("./db.js"); return setCors(req, res, methods); }

export function makeHandler({ poolFactory = defaultPoolFactory, setCorsFn = defaultSetCors, verifyStaff = requireStaff, now = Date.now, photoSaver = savePhoto } = {}) {
  return async function handler(req, res) {
    await setCorsFn(req, res, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    const pool = await poolFactory();
    const auth = await verifyStaff(req, pool);
    if (auth.error) return json(res, auth.error === "unauthorized" ? 401 : 403, { success: false, error: auth.error });
    auth.me.store_code = STORE_BY_COMPANY[auth.me.company_code];
    if (!auth.me.store_code) return json(res, 403, { success: false, error: "feature_off" });
    const b = req.method === "GET" ? req.query || {} : req.body || {};
    const action = text(b.action || (req.method === "GET" ? "today" : ""), 40);
    try {
      let out;
      if (action === "today") out = await today(pool, auth.me, b);
      else if (FLOWS[action]) out = await transition(pool, auth.me, auth.empId, action, b);
      else if (action === "create_appointment") out = await createAppointment(pool, auth.me, b);
      else if (action === "groom_report") out = await groomReport(pool, auth.me, auth.empId, b, now, photoSaver);
      else if (action === "pet") out = await pet(pool, auth.me, b);
      else out = { status: 400, body: { success: false, error: "bad_action" } };
      return json(res, out.status, out.body);
    } catch (e) {
      return json(res, 500, { success: false, error: e.message || "server_error" });
    }
  };
}

export default makeHandler();
