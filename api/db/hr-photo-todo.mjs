// hr-photo-todo.mjs — 「客户要实拍」进店员今日待办(Damon 0928 拍板)。
//
// 流程:AI 自动回复顾客;顾客要看实物照片时 AI 拍不了 →
//   客服台(channel-dispatcher)POST 这里 → 建 hr_day_agenda(kind='photo'),商品名/规格/货位/库存从商品库带出
//   → 店员按货位找到货、在 App 今日待办里拍照完成(hr-staff-portal action=agenda 要求带照片)
//   → 照片进 hr_agenda_photos → 客服台 GET 这里按会话取照片发给顾客。
//
// 🩸 照片⛔不给公网 URL:0928 实测 ai.sanlyn.cn/uploads/… 返回的是网页不是图(nginx 没挂 /opt/sanlyn-uploads),
//    所以照片只存相对路径,客服台带服务令牌 GET ?photo_id= 取原图字节。
// ⛔ 商品只认商品库同一口径(petstore_ops_row + petstore_skus.stock_num),别另写查询。
// ⛔ 这里只建待办、只给照片;发不发给顾客由客服台的发送闸决定,这里不碰发送。
// 服务令牌复用 SHIP_TODO_TOKEN(同一个调用方:客服台往店员待办里塞活)。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CHANNELS = {
  wework: "企业微信",
  wechat: "微信",
  meituan: "美团",
  eleme: "饿了么",
};
const UPLOAD_ROOT = "/opt/sanlyn-uploads";
const UPLOAD_SUB = "staff-photo-request";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
let dbModule;

async function loadDb() {
  if (!dbModule) dbModule = await import("./db.js");
  return dbModule;
}

function json(res, status, body) {
  return res.status(status).json(body);
}

function safeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function str(v) {
  return String(v == null ? "" : v).trim();
}

function len(v) {
  return Array.from(String(v || "")).length;
}

function cut(v, n) {
  return Array.from(String(v || "")).slice(0, n).join("");
}

function ymdInShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce((m, x) => {
    m[x.type] = x.value;
    return m;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  throw e;
}

export function normalizeBody(body, now = new Date()) {
  const b = body || {};
  const companyCode = str(b.company_code) || "JINFANG";
  const sourceChannel = str(b.source_channel);
  if (!CHANNELS[sourceChannel]) bad("来源渠道只能是 wework / wechat / meituan / eleme");
  const sourceConversationId = str(b.source_conversation_id);
  if (!sourceConversationId) bad("来源会话ID必填");
  if (len(sourceConversationId) > 100) bad("来源会话ID不能超过100字");

  // 商品:编码/条码优先,认不出再用关键词;都没有就不建(店员不知道拍什么)
  const productCode = str(b.product_code || b.barcode);
  const keyword = str(b.keyword);
  if (!productCode && !keyword) bad("商品编码/条码/关键词至少给一个");
  if (len(productCode) > 40) bad("商品编码不能超过40字");
  if (len(keyword) > 60) bad("关键词不能超过60字");

  const customerName = str(b.customer_name) || "顾客";
  if (len(customerName) > 40) bad("客户名不能超过40字");
  const requestText = str(b.request_text);
  if (len(requestText) > 200) bad("客户原话不能超过200字");

  return {
    companyCode,
    sourceChannel,
    sourceConversationId,
    productCode,
    keyword,
    customerName,
    requestText,
    workDate: ymdInShanghai(now),
  };
}

// 只在唯一命中时才认,多个候选就当没认出来 —— 拍错商品比让店员看关键词自己找更糟。
export async function lookupProduct(pool, productCode, keyword) {
  const sel = `SELECT r.product_code, r.product_name, r.spec_text, r.shelf_code, k.stock_num
                 FROM public.petstore_ops_row r
                 LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code`;
  if (productCode) {
    const r = await pool.query(`${sel} WHERE r.product_code = $1 OR r.barcode = $1 LIMIT 2`, [productCode]);
    if (r.rows.length === 1) return r.rows[0];
  }
  if (keyword) {
    const r = await pool.query(`${sel} WHERE r.product_name ILIKE '%' || $1 || '%' LIMIT 2`, [keyword]);
    if (r.rows.length === 1) return r.rows[0];
  }
  return null;
}

export function buildTitle(product, data) {
  const what = product
    ? [product.product_name, product.spec_text].filter(Boolean).join(" ")
    : `「${data.keyword || data.productCode}」(商品没认出来,按描述找)`;
  return cut(`客户要实拍：${what}`, 80);
}

export function buildNote(product, data) {
  const lines = [];
  if (product) {
    const stock = product.stock_num == null ? "未知" : String(Number(product.stock_num));
    lines.push(`货位：${product.shelf_code || "没登记货位"}（系统库存 ${stock}）`);
  }
  if (data.requestText) lines.push(`客户说：${data.requestText}`);
  lines.push("拍清正面和生产日期，拍完点完成");
  lines.push(`来源：${CHANNELS[data.sourceChannel]} · ${data.customerName}`);
  return lines.join("\n");
}

export function createdByOf(data, product) {
  const key = product ? product.product_code : (data.productCode || data.keyword);
  return cut(`photo:${data.sourceChannel}:${data.sourceConversationId}:${key}`, 200);
}

// 店员 App 传上来的照片落盘,返回相对 UPLOAD_ROOT 的路径。给 hr-staff-portal 的 agenda 动作用。
export function savePhoto(mime, dataB64, now = Date.now, root = UPLOAD_ROOT) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("照片必须是图片");
  const buf = Buffer.from(String(dataB64 || ""), "base64");
  if (!buf.length) throw new Error("照片是空的");
  if (buf.length > MAX_PHOTO_BYTES) throw new Error("照片超过6MB");
  const stamp = `${now()}-${crypto.randomBytes(4).toString("hex")}`;
  const rel = path.posix.join(UPLOAD_SUB, stamp, /png/.test(mime) ? "photo.png" : "photo.jpg");
  fs.mkdirSync(path.join(root, UPLOAD_SUB, stamp), { recursive: true });
  fs.writeFileSync(path.join(root, rel), buf);
  return rel;
}

// 按 photo_id 读原图。路径必须落在 staff-photo-request 下,防库里被塞了 ../ 读到别的文件。
export async function readPhoto(pool, photoId, root = UPLOAD_ROOT) {
  const r = await pool.query("SELECT photo_path FROM hr_agenda_photos WHERE id=$1", [photoId]);
  const rel = r.rows[0]?.photo_path;
  if (!rel) return null;
  const base = path.resolve(root, UPLOAD_SUB) + path.sep;
  const full = path.resolve(root, rel);
  if (!full.startsWith(base) || !fs.existsSync(full)) return null;
  return { buf: fs.readFileSync(full), mime: full.endsWith(".png") ? "image/png" : "image/jpeg" };
}

async function listForConversation(pool, q) {
  const channel = str(q?.source_channel);
  const conv = str(q?.source_conversation_id);
  if (!CHANNELS[channel] || !conv) bad("要带 source_channel 和 source_conversation_id");
  const r = await pool.query(
    `SELECT a.id, a.title, a.status, a.done_by, a.done_at, a.work_date,
            COALESCE(json_agg(json_build_object('photo_id', p.id, 'by', p.employee_name, 'at', p.created_at) ORDER BY p.id)
                     FILTER (WHERE p.id IS NOT NULL), '[]') AS photos
       FROM hr_day_agenda a
       LEFT JOIN hr_agenda_photos p ON p.agenda_id = a.id
      WHERE a.kind = 'photo' AND a.created_by LIKE $1
      GROUP BY a.id
      ORDER BY a.id DESC
      LIMIT 20`,
    [`photo:${channel}:${conv.replace(/[\\%_]/g, "\\$&")}:%`]);
  return r.rows;
}

export function makeHandler({ poolFactory, setCorsFn, env = process.env, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    const db = (!poolFactory || !setCorsFn) ? await loadDb() : null;
    const cors = setCorsFn || db.setCors;
    const getPool = poolFactory || db.getPool;
    cors(req, res, "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-service-token");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { success: false, error: "只支持 GET / POST" });

    const expected = env.SHIP_TODO_TOKEN;
    if (!expected) return json(res, 503, { success: false, error: "服务令牌未配置" });
    if (!safeEq(req.headers?.["x-service-token"], expected)) {
      return json(res, 401, { success: false, error: "服务令牌不匹配" });
    }

    const pool = getPool();
    if (req.method === "GET") {
      try {
        const photoId = parseInt(req.query?.photo_id, 10);
        if (photoId) {
          const f = await readPhoto(pool, photoId);
          if (!f) return json(res, 404, { success: false, error: "没有这张照片" });
          res.setHeader("Content-Type", f.mime);
          res.setHeader("Cache-Control", "private, no-store");
          return res.status(200).end(f.buf);
        }
        return json(res, 200, { success: true, items: await listForConversation(pool, req.query) });
      } catch (e) {
        return json(res, e.status || 500, { success: false, error: e.message });
      }
    }

    let data;
    try {
      data = normalizeBody(req.body, now());
    } catch (e) {
      return json(res, e.status || 400, { success: false, error: e.message });
    }

    try {
      const co = await pool.query(
        "SELECT 1 FROM hr_employees WHERE company_code=$1 LIMIT 1",
        [data.companyCode]);
      if (!co.rows.length) return json(res, 400, { success: false, error: "公司代码不存在" });

      const product = await lookupProduct(pool, data.productCode, data.keyword);
      const title = buildTitle(product, data);
      const note = buildNote(product, data);
      const createdBy = createdByOf(data, product);
      // 同一会话同一商品当天只建一条;顾客追问不重复派活
      const existing = await pool.query(
        `SELECT id FROM hr_day_agenda
          WHERE company_code=$1 AND work_date=$2 AND kind='photo' AND created_by=$3
          ORDER BY id LIMIT 1`,
        [data.companyCode, data.workDate, createdBy]);
      if (existing.rows.length) {
        return json(res, 200, { success: true, id: existing.rows[0].id, deduped: true, matched: !!product });
      }

      const r = await pool.query(
        `INSERT INTO hr_day_agenda
           (company_code, work_date, kind, status, title, note, created_by)
         VALUES ($1,$2,'photo','open',$3,$4,$5)
         RETURNING id`,
        [data.companyCode, data.workDate, title, note, createdBy]);
      return json(res, 200, { success: true, id: r.rows[0].id, deduped: false, matched: !!product });
    } catch (e) {
      console.error("[hr-photo-todo]", e.message);
      return json(res, 500, { success: false, error: e.message });
    }
  };
}

export default makeHandler();
