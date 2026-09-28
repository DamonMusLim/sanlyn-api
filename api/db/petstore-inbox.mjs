import fs from "fs";
import path from "path";

const UPLOAD_DIR = "/opt/sanlyn-uploads/staff-inbox";
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const DEFAULT_RELAY = "http://100.87.134.113:3798";

function json(res, status, data) { return res.status(status).json(data); }
function text(v, max = 300) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : ""; }
function cleanBase(base) { return String(base || DEFAULT_RELAY).replace(/\/+$/, ""); }

function savePhoto(photo, empId, now = Date.now) {
  const mime = text(photo?.mime || photo?.photo_mime || photo?.type, 80);
  const data = text(photo?.base64 || photo?.photo_base64 || photo?.data_base64, 20_000_000);
  if (!/^image\//.test(mime) || !data) throw new Error("只允许上传图片");
  const buf = Buffer.from(data, "base64");
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) throw new Error("图片超过6MB");
  const dirName = String(now());
  const dir = path.join(UPLOAD_DIR, String(empId), dirName);
  fs.mkdirSync(dir, { recursive: true });
  const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg";
  const file = `inbox_${Math.random().toString(36).slice(2, 8)}${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `${PUBLIC_HOST}/uploads/staff-inbox/${empId}/${dirName}/${file}`;
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
  // 2026-09-27 止血:会话里有企微/微信/美团/饿了么全部客户聊天,之前任何在职店员登录都能看全部。
  // 按渠道分权限设计好之前,只有老板(BOSS_EMPLOYEE_IDS,默认35)能看。
  const bossIds = String(process.env.BOSS_EMPLOYEE_IDS || "35").split(",").map((x) => x.trim()).filter(Boolean);
  if (!bossIds.includes(String(claims.employee_id))) return { error: "forbidden" };
  return { empId: claims.employee_id, me };
}

function scrub(v, token) {
  if (!token) return v;
  if (typeof v === "string") return v.split(token).join("[relay-token-hidden]");
  if (Array.isArray(v)) return v.map((x) => scrub(x, token));
  if (v && typeof v === "object") {
    const out = {};
    Object.entries(v).forEach(([k, val]) => { if (!/token/i.test(k)) out[k] = scrub(val, token); });
    return out;
  }
  return v;
}

function relayError(status, body, token) {
  body = scrub(body, token);
  const msg = text(body?.error || body?.message || body?.reason || body, 500);
  return { success: false, error: msg || `消息服务返回 ${status}` };
}

async function readRelay(res) {
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : {}; } catch { return txt; }
}

async function relayFetch(pathname, { method = "GET", query = {}, body, fetchFn = fetch, env = process.env } = {}) {
  const token = env.MSG_RELAY_TOKEN;
  if (!token) return { status: 503, body: { success: false, error: "消息服务未配置" } };
  const url = new URL(pathname, cleanBase(env.MSG_RELAY_BASE) + "/");
  Object.entries(query).forEach(([k, v]) => { if (text(v, 200)) url.searchParams.set(k, text(v, 200)); });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetchFn(url, {
      method,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-relay-token": token },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await readRelay(r);
    if (!r.ok) return { status: r.status, body: relayError(r.status, data, token) };
    return { status: 200, body: { success: true, data: scrub(data, token) } };
  } catch (e) {
    return { status: 504, body: { success: false, error: e.name === "AbortError" ? "消息服务超时" : "消息服务不可用" } };
  } finally {
    clearTimeout(timer);
  }
}

// 2026-09-28 止血:宠物店没有个人微信号。inbox 6(wechat)= Damon 个人混合号(银行短信/供应商/私人联系人),
// SSOT ~/.openclaw/cs_accounts.json 标 owner_only。这里只放行宠物店渠道,白名单制(没列的一律不给)。
// 等宠物店独立微信号建好进 SSOT,再把 wechat 加回来。
// "inbox #7" = 金枋店AI客服(SSOT company=宠物店),转发服务没给它映射渠道名,原样放行
const PET_CHANNELS = new Set(["meituan", "eleme", "wework", "inbox #7"]);
function petRows(data) {
  return (Array.isArray(data) ? data : []).filter((x) => PET_CHANNELS.has(String(x?.channel || "")));
}
async function petConversationOk(id, deps) {
  const r = await relayFetch("/api/inbox/conversations", { fetchFn: deps.fetchFn, env: deps.env });
  if (r.status !== 200) return false;
  return petRows(r.body.data).some((x) => String(x.conversation_id) === String(id));
}

async function handleAction(auth, b, deps) {
  const action = text(b.action || "list", 40);
  if (action === "upload_image") {
    try { return { status: 200, body: { success: true, url: deps.photoSaver(b.photo || b, auth.empId, deps.now) } }; }
    catch (e) { return { status: 400, body: { success: false, error: e.message || "上传失败" } }; }
  }
  if (action === "list") {
    if (b.channel && !PET_CHANNELS.has(String(b.channel))) return { status: 200, body: { success: true, data: [] } };
    const r = await relayFetch("/api/inbox/conversations", { query: { channel: b.channel, account: b.account }, fetchFn: deps.fetchFn, env: deps.env });
    if (r.status === 200) r.body.data = petRows(r.body.data);
    return r;
  }
  if (action === "detail") {
    const id = text(b.id || b.conversation_id, 160);
    if (!id) return { status: 400, body: { success: false, error: "缺少会话 id" } };
    if (!(await petConversationOk(id, deps))) return { status: 404, body: { success: false, error: "not_found" } };
    return relayFetch(`/api/inbox/conversation/${encodeURIComponent(id)}`, { fetchFn: deps.fetchFn, env: deps.env });
  }
  if (action === "send") {
    const conversationId = text(b.conversation_id, 160);
    if (!conversationId) return { status: 400, body: { success: false, error: "缺少会话 id" } };
    if (!(await petConversationOk(conversationId, deps))) return { status: 404, body: { success: false, error: "not_found" } };
    const body = {
      conversation_id: conversationId,
      text: text(b.text, 3000),
      image_urls: Array.isArray(b.image_urls) ? b.image_urls.map((x) => text(x, 800)).filter(Boolean) : [],
      sender_employee_id: auth.empId,
      sender_name: text(auth.me?.name, 120),
    };
    return relayFetch("/api/inbox/send", { method: "POST", body, fetchFn: deps.fetchFn, env: deps.env });
  }
  return { status: 400, body: { success: false, error: "bad_action" } };
}

async function defaultPoolFactory() {
  const { getPool } = await import("./db.js");
  return getPool();
}

async function defaultSetCors(req, res, methods) {
  const { setCors } = await import("./db.js");
  return setCors(req, res, methods);
}

export function makeHandler({
  poolFactory = defaultPoolFactory,
  setCorsFn = defaultSetCors,
  verifyStaff = requireStaff,
  fetchFn = fetch,
  env = process.env,
  now = Date.now,
  photoSaver = savePhoto,
} = {}) {
  return async function handler(req, res) {
    await setCorsFn(req, res, "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    const pool = await poolFactory();
    const auth = await verifyStaff(req, pool);
    if (auth.error) return json(res, auth.error === "unauthorized" ? 401 : 403, { success: false, error: auth.error });
    const b = req.method === "GET" ? req.query || {} : req.body || {};
    const out = await handleAction(auth, b, { fetchFn, env, now, photoSaver });
    return json(res, out.status, out.body);
  };
}

export default makeHandler();
