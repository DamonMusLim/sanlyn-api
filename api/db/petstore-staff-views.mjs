// 店员 App「业务」页各入口的数据 —— 0928 Damon:「果冻橙这边都有了,带进来,我们不用那么辛苦」
// ⛔ 不另写查询:直接调 jdc 后台(复刻果冻橙)现成的模块 handler,只做两件事:
//   ① 店员身份鉴权(hr_employees 在职)  ② 去掉店员不该看的字段(进价/成本/供应商/毛利)
// 加一个入口 = 在 VIEWS 里加一行,不用写 SQL。
const VIEWS = {
  vaccinations: { mod: "./petstore-vaccinations.js", query: { pageSize: "100" } },          // 疫苗驱虫提醒
  boarding:     { mod: "./petstore-boarding.js", query: { pageSize: "100" } },              // 寄养
  aftersales:   { mod: "./petstore-aftersales.js", query: { store_code: "63350001", pageSize: "100" } }, // 售后
  requisition:  { mod: "./petstore-restock-intents.js", query: { pageSize: "100" } },       // 要货(补货意向)
  ship:         { mod: "./petstore-shop-orders.js", query: { store: "63350001", pageSize: "100" } },    // 发货(商城订单)
  shelf_missing:{ mod: "./petstore-goods-shelf.js", query: { missing_only: "1", pageSize: "200" } },     // 货位绑定(没绑货位的)
};
const DENY = /(cost|in_price|purchase|supplier|gross|margin|profit|inprice|last_price|avg_price)/i;

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!DENY.test(k)) o[k] = scrub(x);
    return o;
  }
  return v;
}

async function requireStaff(req, pool) {
  const { verifyToken } = await import("./auth.js");
  const raw = req.query?.token || (req.headers.authorization || "").replace(/^Bearer /, "");
  const claims = verifyToken(raw);
  if (!claims || claims.role !== "staff" || !claims.employee_id) return { error: "unauthorized" };
  const r = await pool.query(`SELECT id, company_code, employment_status FROM hr_employees WHERE id=$1`, [claims.employee_id]);
  const me = r.rows[0];
  if (!me || me.employment_status !== "active") return { error: "forbidden" };
  return { empId: claims.employee_id, me, raw };
}

// 调原模块 handler:模拟一个 GET 请求,把它的 json 截下来
export async function runView(key, raw, extra = {}) {
  const v = VIEWS[key];
  if (!v) return { status: 400, body: { success: false, error: "bad_view" } };
  const mod = await import(v.mod);
  let status = 200, body = null;
  const res = {
    setHeader() {}, getHeader() {}, header() { return this; },
    status(c) { status = c; return this; },
    json(d) { body = d; return this; },
    send(d) { body = d; return this; },
    end() { return this; },
  };
  const req = { method: "GET", headers: { authorization: "Bearer " + raw }, query: { ...v.query, ...extra } };
  await mod.default(req, res);
  if (status >= 400) return { status, body: { success: false, error: (body && (body.error || body.message)) || "view_failed" } };
  return { status: 200, body: { success: true, data: scrub(body) } };
}

export default async function handler(req, res) {
  const { getPool, setCors } = await import("./db.js");
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const pool = getPool();
  const auth = await requireStaff(req, pool);
  if (auth.error) return res.status(auth.error === "unauthorized" ? 401 : 403).json({ success: false, error: auth.error });
  try {
    const out = await runView(String(req.query?.view || ""), auth.raw, req.query?.q ? { q: String(req.query.q).slice(0, 40) } : {});
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || "server_error" });
  }
}
