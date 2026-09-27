import crypto from "node:crypto";

const CHANNELS = {
  wework: "企业微信",
  wechat: "微信",
  meituan: "美团",
  eleme: "饿了么",
};
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

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function bad(message) {
  const e = new Error(message);
  e.status = 400;
  throw e;
}

export function normalizeBody(body, now = new Date()) {
  const b = body || {};
  const companyCode = str(b.company_code) || "JINFANG";
  const customerName = str(b.customer_name);
  if (!customerName) bad("客户名必填");
  if (len(customerName) > 40) bad("客户名不能超过40字");

  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 20) {
    bad("发货品项必须是1到20行");
  }
  const items = b.items.map((x) => {
    const name = str(x?.name);
    const qty = Number(x?.qty);
    if (!name) bad("品名必填");
    if (len(name) > 60) bad("品名不能超过60字");
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) bad("数量必须是1到999的正整数");
    return { name, qty };
  }).sort((a, b2) => a.name.localeCompare(b2.name, "zh-Hans") || a.qty - b2.qty);

  const address = str(b.address);
  const phone = str(b.phone);
  const note = str(b.note);
  if (len(address) > 200) bad("地址不能超过200字");
  if (len(phone) > 30) bad("电话不能超过30字");
  if (len(note) > 200) bad("备注不能超过200字");

  const sourceChannel = str(b.source_channel);
  if (!CHANNELS[sourceChannel]) bad("来源渠道只能是 wework / wechat / meituan / eleme");
  const sourceConversationId = str(b.source_conversation_id);
  if (!sourceConversationId) bad("来源会话ID必填");
  if (len(sourceConversationId) > 100) bad("来源会话ID不能超过100字");

  const today = ymdInShanghai(now);
  const workDate = str(b.work_date) || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) bad("工作日期格式要 YYYY-MM-DD");
  if (workDate < today || workDate > addDays(today, 7)) bad("工作日期只能填今天到7天内");

  return {
    companyCode,
    customerName,
    items,
    address,
    phone,
    note,
    sourceChannel,
    sourceConversationId,
    requestedBy: str(b.requested_by) || "damon",
    workDate,
  };
}

export function buildTitle(customerName, items) {
  const prefix = `发货：${customerName} · `;
  const labels = items.map((x) => `${x.name}×${x.qty}`);
  const joined = labels.join("、");
  if (len(prefix + joined) <= 80) return prefix + joined;

  let title = prefix;
  let used = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const rest = labels.length - i;
    const suffix = `等${rest}样`;
    const next = `${title}${used ? "、" : ""}${labels[i]}`;
    if (len(next + suffix) > 80) {
      if (!used) {
        const room = Math.max(0, 80 - len(prefix + suffix));
        return prefix + Array.from(labels[i]).slice(0, room).join("") + suffix;
      }
      return title + suffix;
    }
    title = next;
    used += 1;
  }
  return title;
}

export function buildNote(data) {
  const lines = [];
  if (data.address) lines.push(`地址：${data.address}`);
  if (data.phone) lines.push(`电话：${data.phone}`);
  if (data.note) lines.push(`备注：${data.note}`);
  lines.push(`来源：${CHANNELS[data.sourceChannel]}`);
  return lines.join("\n");
}

export function makeHandler({ poolFactory, setCorsFn, env = process.env, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    const db = (!poolFactory || !setCorsFn) ? await loadDb() : null;
    const cors = setCorsFn || db.setCors;
    const getPool = poolFactory || db.getPool;
    cors(req, res, "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-service-token");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return json(res, 405, { success: false, error: "只支持 POST" });

    const expected = env.SHIP_TODO_TOKEN;
    if (!expected) return json(res, 503, { success: false, error: "服务令牌未配置" });
    if (!safeEq(req.headers?.["x-service-token"], expected)) {
      return json(res, 401, { success: false, error: "服务令牌不匹配" });
    }

    let data;
    try {
      data = normalizeBody(req.body, now());
    } catch (e) {
      return json(res, e.status || 400, { success: false, error: e.message });
    }

    const pool = getPool();
    try {
      const co = await pool.query(
        "SELECT 1 FROM hr_employees WHERE company_code=$1 LIMIT 1",
        [data.companyCode]);
      if (!co.rows.length) return json(res, 400, { success: false, error: "公司代码不存在" });

      const title = buildTitle(data.customerName, data.items);
      const note = buildNote(data);
      const createdBy = `ship:${data.sourceChannel}:${data.sourceConversationId}`;
      const existing = await pool.query(
        `SELECT id FROM hr_day_agenda
          WHERE company_code=$1 AND work_date=$2 AND kind='ship'
            AND created_by=$3 AND title=$4
          ORDER BY id LIMIT 1`,
        [data.companyCode, data.workDate, createdBy, title]);
      if (existing.rows.length) {
        return json(res, 200, { success: true, id: existing.rows[0].id, deduped: true });
      }

      const r = await pool.query(
        `INSERT INTO hr_day_agenda
           (company_code, work_date, kind, status, title, note, created_by)
         VALUES ($1,$2,'ship','open',$3,$4,$5)
         RETURNING id`,
        [data.companyCode, data.workDate, title, note, createdBy]);
      return json(res, 200, { success: true, id: r.rows[0].id, deduped: false });
    } catch (e) {
      console.error("[hr-ship-todo]", e.message);
      return json(res, 500, { success: false, error: e.message });
    }
  };
}

export default makeHandler();
