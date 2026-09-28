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
  // 0928 照果冻橙业务页补齐:出库/调拨/报损/报盈/收银订单/采购单(同 jdc 后台的出入库、盘点、采购页)
  stock_in:     { mod: "./petstore-stock-moves.js", query: { kind: "in", pageSize: "100" } },
  stock_out:    { mod: "./petstore-stock-moves.js", query: { kind: "out", pageSize: "100" } },
  transfer:     { mod: "./petstore-stock-moves.js", query: { kind: "transfer", pageSize: "100" } },
  loss:         { mod: "./petstore-stock-moves.js", query: { kind: "loss", pageSize: "100" } },
  profit:       { mod: "./petstore-stocktake.js", query: { diff: "profit", pageSize: "100" } },
  sale:         { mod: "./petstore-stock-moves.js", query: { kind: "sale", pageSize: "100" } },
  purchase:     { mod: "./petstore-purchase-orders.js", query: { pageSize: "100" } },
  // 0928 果冻橙业务页下半截:实用小工具后半 + 数据分析
  shelf_stock:  { mod: "./petstore-goods-shelf.js", query: { pageSize: "200" } },                 // 货位库存
  reviews:      { mod: "./petstore-reviews.js", query: { pageSize: "100" } },                     // 评论管理
  suggest:      { mod: "./petstore-gdc-suggest.js", query: { pageSize: "100" } },                 // 智能补货(果冻橙建议已全量入库)
  ai_pic:       { mod: "./petstore-ai-tasks.js", query: { task_type: "optimize_pic", pageSize: "100" } }, // AI修图
  // 0928 宠老板(它它医生/宠老板 SaaS)那一套:诊疗 + 会员 —— 单独一块,后续可隐藏或并进门店服务
  clinic_reg:   { mod: "./petstore-clinic-reg.js", query: { pageSize: "100", storeCode: "63350001" } },
  clinic_record:{ mod: "./petstore-clinic-record.js", query: { pageSize: "100", storeCode: "63350001" } },
  clinic_rx:    { mod: "./petstore-clinic-rx.js", query: { pageSize: "100", storeCode: "63350001" } },
  clinic_exam:  { mod: "./petstore-clinic-exam.js", query: { pageSize: "100", storeCode: "63350001" } },
  clinic_adm:   { mod: "./petstore-clinic-adm.js", query: { pageSize: "100", storeCode: "63350001" } },
  followup:     { mod: "./petstore-followup.js", query: { pageSize: "100", storeCode: "63350001" } },
  referrals:    { mod: "./petstore-referrals.js", query: { pageSize: "100", storeCode: "63350001" } },
  cards:        { mod: "./petstore-cards.js", query: { pageSize: "100", storeCode: "63350001" } },
  card_templates:{ mod: "./petstore-card-templates.js", query: { pageSize: "100", storeCode: "63350001" } },
  service_items:{ mod: "./petstore-service-items.js", query: { pageSize: "100", storeCode: "63350001" } },
  // 数据分析:含营业额/毛利,⛔只给老板;老板看不去字段
  biz_daily:    { mod: "./petstore-platform-daily.js", query: { pageSize: "60" }, boss: true },   // 经营分析
  pnl:          { mod: "./petstore-order-pnl.js", query: { pageSize: "60" }, boss: true },        // 利润统计
};
const BOSS_IDS = String(process.env.BOSS_EMPLOYEE_IDS || "35").split(",").map((x) => x.trim()).filter(Boolean);

// ── 员工权限(0928 Damon:「给员工的权限尽量少点」)──
// 店员(role=clerk)只看老板勾选的格子;店长/老板不受限。存 hr_org_settings.staff_biz_tiles(M135),NULL=下面默认最小集。
export const STAFF_TILES_DEFAULT = ["商品速查", "库存预警", "临期核日期", "入库", "盘点", "报损", "库存上报", "找货记录",
  "接待预约", "洗护报告", "客户宠物", "疫苗驱虫提醒", "寄养", "发货", "货位绑定", "保质期", "标签打印", "请假报销"];
const MANAGER_ROLES = new Set(["manager", "store_manager", "boss"]);
// 入口(view)→ 页面上的格子名,后端按这个拦,不只是前端藏
const VIEW_TILE = { vaccinations: "疫苗驱虫提醒", boarding: "寄养", aftersales: "售后", requisition: "要货", ship: "发货",
  shelf_missing: "货位绑定", stock_in: "入库", stock_out: "出库", transfer: "调拨", loss: "报损", profit: "报盈", sale: "收银订单",
  purchase: "采购单", shelf_stock: "货位库存", reviews: "评论管理", suggest: "智能补货", ai_pic: "AI修图",
  clinic_reg: "挂号就诊", clinic_record: "病历", clinic_rx: "处方", clinic_exam: "化验检查", clinic_adm: "住院", followup: "回访",
  referrals: "转诊", cards: "会员卡", card_templates: "次卡模板", service_items: "服务项目", sync: "拉取外卖新品", label_print: "标签打印" };
async function staffTiles(pool, company) {
  const r = await pool.query(`SELECT staff_biz_tiles FROM hr_org_settings WHERE company_code=$1`, [company || "JINFANG"]).catch(() => ({ rows: [] }));
  const t = r.rows[0]?.staff_biz_tiles;
  return Array.isArray(t) ? t : STAFF_TILES_DEFAULT;
}

// 拉取外卖新品 = 果冻橙「立即同步」:跟 jdc 自助收银机页(petstore-kiosk-settings)共用同一个触发旗文件,Studio 每分钟轮询
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const SYNC_DIR = "/opt/luvsome-gateway/data";
function readSyncJson(name) { try { return JSON.parse(readFileSync(`${SYNC_DIR}/${name}`, "utf8")); } catch { return null; } }
export function syncStatus() {
  const rq = readSyncJson("gdc_sync_request.json"), handled = readSyncJson("gdc_sync_handled.json"), last = readSyncJson("gdc_sync_last.json");
  const pending = !!(rq?.requested_at && handled?.handled_request_at !== rq.requested_at);
  return { last_sync_at: last?.done_at || null, last_sync_ok: last?.ok ?? null, last_sync_summary: last?.summary || null, pending };
}
function requestSync(who) {
  const tmp = `${SYNC_DIR}/gdc_sync_request.json.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ requested_at: new Date().toISOString(), requested_by: `staff:${who}`.slice(0, 80) }));
  renameSync(tmp, `${SYNC_DIR}/gdc_sync_request.json`);
}
const DENY = /(cost|in_price|purchase|supplier|gross|margin|profit|inprice|last_price|avg_price)/i;

function scrub(v) {
  if (v instanceof Date) return v.toISOString();   // 0928:日期对象别被当成普通对象清成 {}
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
  const r = await pool.query(`SELECT id, company_code, role, employment_status FROM hr_employees WHERE id=$1`, [claims.employee_id]);
  const me = r.rows[0];
  if (!me || me.employment_status !== "active") return { error: "forbidden" };
  return { empId: claims.employee_id, me, raw };
}

// 调原模块 handler:模拟一个 GET 请求,把它的 json 截下来
export async function runView(key, raw, extra = {}, empId = null) {
  const v = VIEWS[key];
  if (!v) return { status: 400, body: { success: false, error: "bad_view" } };
  const boss = BOSS_IDS.includes(String(empId || ""));
  if (v.boss && !boss) return { status: 403, body: { success: false, error: "boss_only" } };
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
  return { status: 200, body: { success: true, data: v.boss && boss ? body : scrub(body) } };
}

export default async function handler(req, res) {
  const { getPool, setCors } = await import("./db.js");
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const pool = getPool();
  const auth = await requireStaff(req, pool);
  if (auth.error) return res.status(auth.error === "unauthorized" ? 401 : 403).json({ success: false, error: auth.error });
  try {
    const isMgr = MANAGER_ROLES.has(String(auth.me.role || "")) || BOSS_IDS.includes(String(auth.empId));
    const view = String(req.query?.view || "");
    if (view === "tile_perm") {
      if (req.method === "POST") {
        if (!BOSS_IDS.includes(String(auth.empId))) return res.status(403).json({ success: false, error: "boss_only" });
        const list = Array.isArray(req.body?.tiles) ? req.body.tiles.map((x) => String(x).slice(0, 20)).slice(0, 80) : null;
        if (!list) return res.status(400).json({ success: false, error: "tiles 必须是数组" });
        await pool.query(`UPDATE hr_org_settings SET staff_biz_tiles=$1::jsonb, updated_at=now() WHERE company_code=$2`,
          [JSON.stringify(list), auth.me.company_code || "JINFANG"]);
      }
      return res.status(200).json({ success: true, data: { tiles: await staffTiles(pool, auth.me.company_code), all: isMgr, is_boss: BOSS_IDS.includes(String(auth.empId)) } });
    }
    if (!isMgr && VIEW_TILE[view] && !(await staffTiles(pool, auth.me.company_code)).includes(VIEW_TILE[view])) {
      return res.status(403).json({ success: false, error: "这个入口没开给店员" });
    }
    if (req.query?.view === "sync") {
      if (req.method === "POST") requestSync(String(auth.empId));
      return res.status(200).json({ success: true, data: syncStatus() });
    }
    if (req.query?.view === "label_print" && req.method === "POST") {
      // 标签打印:复用门店电脑上的价签服务(JF label-svc,0809 跑通的那条链路,TSC TE344)。
      // Damon 0919「价签先审后打」:这里只打【果冻橙当前在售价】,⛔不接受手填价格,所以打出来的就是已经生效的价。
      const code = String(req.body?.product_code || "").slice(0, 40);
      const r = await pool.query(
        `SELECT product_code, barcode, product_name, store_price, shelf_code FROM petstore_ops_row WHERE product_code=$1`, [code]);
      const x = r.rows[0];
      if (!x) return res.status(404).json({ success: false, error: "没找到这个商品" });
      if (!(Number(x.store_price) > 0)) return res.status(400).json({ success: false, error: "这个商品没有售价,不能打" });
      let shelf = String(x.shelf_code || "");
      try { const j = JSON.parse(shelf); if (Array.isArray(j)) shelf = String(j[0] || ""); } catch { /* 不是 JSON */ }
      const [shelfA, shelfB] = shelf.includes("-") ? shelf.split("-", 2) : [shelf, ""];
      const token = readFileSync("/opt/sanlyn-api-test/.label_token", "utf8").trim();
      const pr = await fetch("http://100.115.46.45:8781/print", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Label-Token": token },
        body: JSON.stringify({ tpl: "price", n: 1, params: {
          name_full: x.product_name, name_short: String(x.product_name || "").slice(0, 12),
          price: Number(x.store_price).toFixed(2).replace(/\.00$/, ""), barcode: x.barcode || x.product_code,
          shelf_a: shelfA, shelf_b: shelfB } }),
        signal: AbortSignal.timeout(15000),
      }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
      if (!pr.ok) return res.status(502).json({ success: false, error: "打印机没响应" + (pr.status ? "(" + pr.status + ")" : "") + ",看一下门店电脑和价签机是不是开着" });
      return res.status(200).json({ success: true, message: "已发到价签机", price: Number(x.store_price) });
    }
    if (req.query?.view === "pick_perf") {
      // 拣货绩效:我们自己的拣货记录(petstore_takeout_picks),果冻橙那边没有这份数据
      const r = await pool.query(
        `SELECT COALESCE(e.name, '未记名') AS picker, COUNT(DISTINCT p.order_no)::int AS orders,
                COALESCE(SUM(p.picked),0)::int AS items, MAX(p.completed_at) AS last_at
           FROM petstore_takeout_picks p LEFT JOIN hr_employees e ON e.id = p.picker_employee_id
          WHERE p.completed_at >= now() - interval '30 days'
          GROUP BY 1 ORDER BY 2 DESC`);
      return res.status(200).json({ success: true, data: r.rows });
    }
    const out = await runView(String(req.query?.view || ""), auth.raw, req.query?.q ? { q: String(req.query.q).slice(0, 40) } : {}, auth.empId);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || "server_error" });
  }
}
