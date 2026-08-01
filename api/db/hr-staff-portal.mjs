// /api/db/hr-staff-portal.mjs — 集团HRM · 员工自助（店员手机端，免后台账号）
//
// 认证：复用现有 JWT，但发的是**限权 token**（role=staff + employee_id），不是后台账号。
//   GET  ?token=<jwt>              → 我的排班/我的请假/我的报销/我的工资条（只返回自己那份）
//   POST ?token=<jwt> {action:...} → 提交请假 / 提交报销(带小票) / 提交加班
//
// 🔒 安全铁律（这个接口是**对外**的，店员手机能直接打）：
//   1. employee_id 一律取自 **token 内**，绝不信任 body/query 里传来的 —— 否则改个数字就能看别人工资。
//   2. 只允许 submit 类动作，**不含任何审批权**（status 恒为 pending，店长在后台批）。
//   3. 工资条只返回 confirmed/paid 的，草稿不给看（避免店员看到试算中的数字来吵）。
//   4. 证件：**只返回本人自己的**（0730 Damon 要"员工能看到自己签的合同和身份证"）。
//      身份证号本人可见全量；文件走 ?file=id_card|contract 从私有目录取，employee 仍只从 token 认。
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getPool, setCors } from "./db.js";
import { verifyToken } from "./auth.js";

const D = "YYYY-MM-DD";

// 今天的事:一次性、带时间点的当天安排(到货/上门/临时交代)。
async function agendaFor(pool, companyCode, today) {
  const r = await pool.query(
    `SELECT id, to_char(at_time,'HH24:MI') AS at_time, title, note, kind, status
       FROM hr_day_agenda
      WHERE company_code=$1 AND work_date=$2
      ORDER BY at_time NULLS LAST, id`, [companyCode, today]);
  return r.rows.length ? r.rows : null;
}

// 点检照片交 MiniMax-M3 判。⚠️ 只标不拦:判不合格也记完成，异常留给店长看。
// (M3 是多模态的,2026-08-01 实测;旧的 MiniMax-VL-01 已下线)
async function reviewPhoto(title, hint, dataUrl) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key || !dataUrl) return null;
  const prompt = `宠物店点检项「${title}」。看图后只回JSON：`
    + `{"能判断":true/false,"合格":true/false,"看到什么":"25字内","问题":["没有就空"]}`;
  try {
    const r = await fetch("https://api.minimaxi.com/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "MiniMax-M3", max_tokens: 1500,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } }] }],
      }),
      signal: AbortSignal.timeout(40000),
    });
    const d = await r.json();
    const m = d?.choices?.[0]?.message || {};
    let t = m.content || m.reasoning_content || "";   // M3 是推理模型,正文可能为空
    t = t.replace(/```json|```/g, "").trim();       // M3 会用 code fence 包
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    return JSON.parse(t.slice(a, b + 1));
  } catch (e) { return null; }   // AI 挂了不影响店员打勾
}

// 首页「建议」:从每日销售快照里挑出**事实型**提醒，不做定价/补货决策。
// ⚠️ 店员端可见 —— 绝不 SELECT cost_price / gross_margin_pct，源头就不取。
const DNA_STORE = { JINFANG: "63350001" };
async function tipsFor(pool, companyCode) {
  const store = DNA_STORE[String(companyCode || "")];
  if (!store) return null;
  const asOf = (await pool.query(
    "SELECT to_char(MAX(as_of),'YYYY-MM-DD') AS d FROM petstore_sku_sales_dna WHERE store_code=$1",
    [store])).rows[0]?.d;
  if (!asOf) return null;

  // 断货了但还在卖 —— 该补
  const oos = await pool.query(
    `SELECT product_name, spec, oos_days_30, ROUND(daily_avg_30::numeric, 2) AS daily_avg
       FROM petstore_sku_sales_dna
      WHERE store_code=$1 AND as_of=$2 AND cur_stock <= 0 AND daily_avg_30 > 0
      ORDER BY daily_avg_30 DESC LIMIT 5`, [store, asOf]);
  // 负库存 = 系统卖超，要盘
  const neg = await pool.query(
    `SELECT COUNT(*)::int AS n FROM petstore_sku_sales_dna
      WHERE store_code=$1 AND as_of=$2 AND cur_stock < 0`, [store, asOf]);

  const list = [];
  if (oos.rowCount) {
    list.push({
      kind: "restock", level: "warn",
      title: `${oos.rowCount === 5 ? "至少 " : ""}${oos.rowCount} 个断货了还在卖`,
      sub: "货架空着，顾客问得到买不到",
      items: oos.rows.map((r) => ({
        name: r.product_name, spec: r.spec,
        note: `日均 ${r.daily_avg} 个` + (r.oos_days_30 > 0 ? ` · 已断 ${r.oos_days_30} 天` : ""),
      })),
    });
  }
  if (neg.rows[0]?.n > 0) {
    list.push({
      kind: "stocktake", level: "info",
      title: `${neg.rows[0].n} 个负库存`,
      sub: "系统卖超了，实物和账对不上，需要盘一下",
      items: [],
    });
  }
  return list.length ? { as_of: asOf, list } : null;
}

// 开店点检：模板 hr_checklist_items(phase='open') + 当天执行记录 hr_checklist_logs。
// 只在「当天还没人做完开店点检」时返回，做完就不再打扰。
async function openChecklist(pool, companyCode, today) {
  const r = await pool.query(
    `SELECT i.id, i.seq, i.title, i.hint, i.need_photo,
            l.status, l.employee_name, to_char(l.done_at,'HH24:MI') AS done_at
       FROM hr_checklist_items i
       LEFT JOIN hr_checklist_logs l
         ON l.item_id = i.id AND l.work_date = $2 AND l.company_code = i.company_code
      WHERE i.company_code = $1 AND i.phase = 'open' AND i.is_active = true
      ORDER BY i.seq, i.id`, [companyCode, today]);
  const items = r.rows;
  if (!items.length) return null;
  const left = items.filter((x) => !x.status).length;
  return { phase: "open", total: items.length, left, items };
}

// ── 今日待办：读店员任务真源 ────────────────────────────────────────
// 真源 = 腾讯本地 /opt/pet-ai-clerk/data/decisions.db（clerk-service 在写）。
// ⚠️ mini 上那份 ~/.openclaw/decisions.db 是**陈旧存档**(2026-07-05 后就没更新)，别再读它。
// 腾讯 node v18 没有 node:sqlite，走 sqlite3 CLI 只读。
const CLERK_DB = "/opt/pet-ai-clerk/data/decisions.db";
const KIND_LABEL = {
  verify_expiry: "保质期核查", verify_stock: "库存核对", restock_photo: "补货拍照",
  stocktake: "盘点", discount_review: "改价复核", review_losing: "亏本复核",
  review_expired: "临期复核",
};
function clerkQuery(sql) {
  try {
    const r = spawnSync("sqlite3", ["-json", "-readonly", CLERK_DB, sql],
      { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return [];
    return JSON.parse(r.stdout || "[]");
  } catch { return []; }
}
// 只给金枋的人看（clerk_tasks 全是金枋店的活）。开第二家店时这里要改成按 store_code 过滤。
function todoFor(companyCode) {
  if (String(companyCode || "") !== "JINFANG") return { total: 0, by_kind: [], recent: [] };
  const byKind = clerkQuery(
    "SELECT kind, COUNT(*) AS n FROM clerk_tasks WHERE status='pending' GROUP BY kind ORDER BY n DESC");
  // 只取品名和货架，system_data 里有成本价，绝不外泄
  const recent = clerkQuery(
    "SELECT kind, product_name, shelf_list FROM clerk_tasks WHERE status='pending' " +
    "ORDER BY assigned_at DESC LIMIT 3");
  return {
    total: byKind.reduce((a, x) => a + (x.n || 0), 0),
    by_kind: byKind.map((x) => ({ kind: x.kind, label: KIND_LABEL[x.kind] || x.kind, n: x.n })),
    recent: recent.map((x) => ({ label: KIND_LABEL[x.kind] || x.kind,
      product_name: x.product_name, shelf: x.shelf_list })),
  };
}
const UPLOAD_DIR = "/opt/sanlyn-uploads/reimbursement";
const PRIVATE_ROOT = "/opt/sanlyn-private/hr";   // 证件私有目录，不在任何 web root 内
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_BYTES = 6 * 1024 * 1024;

function saveReceipt(filename, mime, dataB64) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("小票只能是图片");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) throw new Error("图片超过6MB");
  const dir = path.join(UPLOAD_DIR, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || "receipt").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf);
  return `${PUBLIC_HOST}/uploads/reimbursement/${path.basename(dir)}/${safe}`;
}

// 身份证照片存私有目录，路径规则跟 hr-employees.mjs 的 saveDoc 保持一致（只存相对路径）
function savePrivateIdCard(employeeId, filename, mime, dataB64) {
  const ok = /^image\//.test(String(mime || "")) || mime === "application/pdf";
  if (!ok) throw new Error("身份证只能传图片或 PDF");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("文件超过8MB");
  const dir = path.join(PRIVATE_ROOT, String(employeeId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = `id_card_${Date.now()}_` +
    String(filename || "doc").replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf, { mode: 0o600 });
  return path.posix.join(String(employeeId), safe);
}

function monthOf(v) {
  if (/^\d{4}-\d{2}$/.test(String(v || ""))) return v;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── 认证：只认 role=staff 的限权 token，employee_id 只从 token 取 ──
  const raw = req.query?.token || (req.headers.authorization || "").replace(/^Bearer /, "");
  const claims = verifyToken(raw);
  if (!claims || claims.role !== "staff" || !claims.employee_id) {
    return res.status(401).json({ success: false, error: "链接无效或已过期，找店长重新发一个" });
  }
  const empId = claims.employee_id;
  const pool = getPool();

  try {
    const empQ = await pool.query(
      `SELECT id, name, employee_code, role, position, company_code, employment_status,
              phone, id_card_no, id_card_file, contract_file,
              to_char(contract_start,'YYYY-MM-DD') AS contract_start,
              to_char(contract_end,'YYYY-MM-DD')   AS contract_end,
              to_char(hire_date,'YYYY-MM-DD')      AS hire_date,
              pay_type, pay_rate, emergency_contact, emergency_phone
         FROM hr_employees WHERE id = $1`, [empId]);
    if (!empQ.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
    const me = empQ.rows[0];
    if (me.employment_status !== "active") {
      return res.status(403).json({ success: false, error: "该员工已离职，链接停用" });
    }

    // 本人证件文件（私有目录；employee 只从 token 取，拿不到别人的）
    if (req.method === "GET" && req.query?.file) {
      const kindMap = { id_card: me.id_card_file, contract: me.contract_file };
      const rel = kindMap[req.query.file];
      if (rel === undefined) return res.status(400).json({ success:false, error:"file 只能是 id_card 或 contract" });
      if (!rel) return res.status(404).json({ success:false, error:"还没上传这个文件，找店长补" });
      const abs = path.resolve(PRIVATE_ROOT, rel);
      if (!abs.startsWith(PRIVATE_ROOT + path.sep)) return res.status(400).json({ success:false, error:"非法路径" });
      if (!fs.existsSync(abs)) return res.status(404).json({ success:false, error:"文件不存在" });
      const ext = path.extname(abs).toLowerCase();
      res.setHeader("Content-Type", ext===".pdf"?"application/pdf":ext===".png"?"image/png":"image/jpeg");
      res.setHeader("Cache-Control", "private, no-store");
      return res.end(fs.readFileSync(abs));
    }

    if (req.method === "GET") {
      const month = monthOf(req.query?.month);
      const from = `${month}-01`, to = `${month}-31`;
      const [shifts, leaves, reimb, pay, ot, book] = await Promise.all([
        pool.query(`SELECT to_char(work_date,'${D}') AS work_date, start_time, end_time, shift_label, is_rest_day
                      FROM hr_shifts WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date`,
          [empId, from, to]),
        pool.query(`SELECT id, to_char(leave_date_start,'${D}') AS leave_date_start,
                           to_char(leave_date_end,'${D}') AS leave_date_end, reason, status, review_note
                      FROM hr_leave_requests WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 30`, [empId]),
        pool.query(`SELECT id, amount, item_desc, to_char(purchase_date,'${D}') AS purchase_date, status, review_note
                      FROM hr_reimbursements WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 30`, [empId]),
        // 工资条只给已确认/已发放的，草稿不给看
        pool.query(`SELECT period, pay_type, actual_days, actual_hours, overtime_hours,
                           base_amount, overtime_amount, gross_amount, reimb_amount, status,
                           to_char(paid_at,'${D}') AS paid_at
                      FROM hr_payroll WHERE employee_id=$1 AND status IN ('confirmed','paid')
                     ORDER BY period DESC LIMIT 12`, [empId]),
        pool.query(`SELECT id, to_char(work_date,'${D}') AS work_date, hours, kind, status
                      FROM hr_overtime WHERE employee_id=$1 ORDER BY work_date DESC LIMIT 20`, [empId]),
        // 员工手册/门店问题库：只给已发布 + 该员工可见等级（店长能多看 manager 级）
        pool.query(
          `SELECT id, category, title, body, images, tags
             FROM hr_handbook
            WHERE company_code=$1 AND is_published=true
              AND (visibility='all' OR ($2 = 'store_manager' AND visibility='manager'))
            ORDER BY category, sort_order, id LIMIT 200`,
          [me.company_code, me.role]),
      ]);
      const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
      const todayCk = await pool.query(
        `SELECT id, checkin_at, checkout_at, source FROM hr_staff_checkin
          WHERE employee_ref=$1 AND checkin_date=$2 ORDER BY checkin_at DESC LIMIT 1`, [empId, today]);
      return res.status(200).json({
        success: true, today,
        today_checkin: todayCk.rows[0] || null,
        me: { name: me.name, employee_code: me.employee_code, position: me.position || null,
              role: me.role, company_code: me.company_code,
              phone: me.phone, id_card_no: me.id_card_no,
              has_id_card: !!me.id_card_file, has_contract: !!me.contract_file,
              contract_start: me.contract_start, contract_end: me.contract_end,
              hire_date: me.hire_date, pay_type: me.pay_type, pay_rate: me.pay_rate,
              emergency_contact: me.emergency_contact, emergency_phone: me.emergency_phone },
        month,
        todo: todoFor(me.company_code),
        checklist: await openChecklist(pool, me.company_code, today),
        tips: await tipsFor(pool, me.company_code),
        agenda: await agendaFor(pool, me.company_code, today),
        shifts: shifts.rows, leaves: leaves.rows, reimbursements: reimb.rows,
        payslips: pay.rows, overtime: ot.rows, handbook: book.rows,
      });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const action = b.action;

      // ── 打卡开门（0730 Damon 定名）─────────────────────────────
      // 一个动作 = 开门 + 打卡 + 摄像头抓拍。设计意图(Damon原话)：
      //   "打卡开门 + 监控拍照，也是刚好测试员工的诚信度"
      //   —— 在家远程点开门，照片里没人，诚信问题自己就暴露。
      // 编排放在 HR 侧(forge 评审推荐方案c)：员工身份只认 staff JWT，
      // 门锁能力仍只在网关一处，HR 用服务令牌代调，不把 HR 鉴权扩散进 yudao。
      // 铁律：**门没开成绝不记打卡**；开了但记打卡失败要能看出来(留 suspicious)。
      if (action === "unlock") {
        const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
        const pt = (await pool.query(
          "SELECT * FROM hr_checkin_points WHERE company_code=$1 AND is_active=true ORDER BY code LIMIT 1",
          [me.company_code])).rows[0];
        if (!pt) return res.status(400).json({ success:false, error:"没配打卡点位" });

        // 1) 先开门（开不了就别记卡）
        let opened = false, doorErr = "";
        try {
          const r = await fetch("http://127.0.0.1:8093/app-api/luvsome/door/unlock-internal", {
            method:"POST",
            headers:{ "Content-Type":"application/json", "X-Service-Token": process.env.DOOR_SERVICE_TOKEN || "" },
            body: JSON.stringify({ storeCode: pt.store_code, actor: `${me.name}/${empId}` }),
            signal: AbortSignal.timeout(10000),
          });
          const d = await r.json();
          opened = d && (d.code === 0 || d.data?.opened === true);
          if (!opened) doorErr = d?.msg || "开门失败";
        } catch (e) { doorErr = "门禁服务连不上"; }
        if (!opened) return res.status(502).json({ success:false, error: doorErr || "开门失败，请联系店长" });

        // 2) 位置核对（**只标不拦** —— Damon: 有电话+有监控兜底，别把人挡在门外）
        const lat = Number(b.lat), lng = Number(b.lng);
        let distance = null, suspicious = [];
        if (Number.isFinite(lat) && Number.isFinite(lng) && pt.lat != null && pt.lng != null) {
          const R = 6371000, toR = (x) => x*Math.PI/180;
          const dLat = toR(lat - Number(pt.lat)), dLng = toR(lng - Number(pt.lng));
          const a2 = Math.sin(dLat/2)**2 + Math.cos(toR(Number(pt.lat)))*Math.cos(toR(lat))*Math.sin(dLng/2)**2;
          distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1-a2)));
          if (distance > (pt.radius_m || 200)) suspicious.push(`离店${distance}米`);
        } else if (!Number.isFinite(lat)) {
          suspicious.push("没给位置");
        }

        // 3) 摄像头抓拍（尽力而为，失败绝不影响打卡）
        let snap = null;
        try {
          const cr = await fetch("http://127.0.0.1:3721/api/checkin/capture", { signal: AbortSignal.timeout(6000) });
          if (cr.ok) { const cd = await cr.json(); snap = cd?.url || cd?.pic_url || null; }
        } catch (e) { /* 摄像头没装店/离线都算正常，不报错 */ }
        if (!snap) suspicious.push("无抓拍");

        // 4) 记打卡（上班没打过就记上班，打过就记下班）
        const exist = (await pool.query(
          "SELECT id, checkin_at, checkout_at FROM hr_staff_checkin WHERE employee_ref=$1 AND checkin_date=$2 LIMIT 1",
          [empId, today])).rows[0];
        const susp = suspicious.length ? suspicious.join("+") : null;
        let what;
        if (!exist) {
          await pool.query(
            `INSERT INTO hr_staff_checkin (id,company_code,employee_ref,staff_name,checkin_date,checkin_at,
               source,scan_code,store_code,lat,lng,distance_m,suspicious,snapshot_url)
             VALUES ($1,$2,$3,$4,$5,now(),'door',$6,$7,$8,$9,$10,$11,$12)`,
            [`door-${empId}-${today}`, me.company_code, empId, me.name, today, pt.code, pt.store_code,
             Number.isFinite(lat)?lat:null, Number.isFinite(lng)?lng:null, distance, susp, snap]);
          what = "上班打卡";
        } else if (!exist.checkout_at) {
          await pool.query("UPDATE hr_staff_checkin SET checkout_at=now() WHERE id=$1", [exist.id]);
          what = "下班打卡";
        } else {
          what = "今天已打过卡";
        }
        return res.status(200).json({ success:true, opened:true,
          message: `门已开 · ${what}`, distance_m: distance, suspicious: susp });
      }

      // 扫墙上二维码打卡（保留：没门禁的点位/门锁故障时兜底）
      if (action === "checkin" || action === "checkout") {
        const code = String(b.code || "").trim();
        const pt = await pool.query(
          "SELECT code,label FROM hr_checkin_points WHERE code=$1 AND company_code=$2 AND is_active=true",
          [code, me.company_code]);
        if (!pt.rows.length) return res.status(400).json({ success:false, error:"二维码无效，请扫店里墙上那个" });
        const today = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10);
        const exist = await pool.query(
          "SELECT id, checkin_at, checkout_at FROM hr_staff_checkin WHERE employee_ref=$1 AND checkin_date=$2 LIMIT 1",
          [empId, today]);
        if (action === "checkin") {
          if (exist.rows.length) return res.status(200).json({ success:true, already:true,
            message:`今天已经打过卡了（${String(exist.rows[0].checkin_at).slice(11,16)}）` });
          await pool.query(
            `INSERT INTO hr_staff_checkin (id, company_code, employee_ref, staff_name, checkin_date, checkin_at, source, scan_code, store_code)
             VALUES ($1,$2,$3,$4,$5,now(),'qr',$6,$7)`,
            [`qr-${empId}-${today}`, me.company_code, empId, me.name, today, code, me.company_code]);
          return res.status(200).json({ success:true, message:`上班打卡成功 · ${pt.rows[0].label}` });
        }
        if (!exist.rows.length) return res.status(400).json({ success:false, error:"今天还没上班打卡" });
        if (exist.rows[0].checkout_at) return res.status(200).json({ success:true, already:true, message:"今天已经打过下班卡了" });
        await pool.query("UPDATE hr_staff_checkin SET checkout_at=now() WHERE id=$1", [exist.rows[0].id]);
        return res.status(200).json({ success:true, message:"下班打卡成功，辛苦了 🐾" });
      }

      if (action === "leave") {
        if (!b.leave_date_start || !b.leave_date_end)
          return res.status(400).json({ success: false, error: "请假起止日期必填" });
        const r = await pool.query(
          `INSERT INTO hr_leave_requests
             (company_code, employee_id, employee_name, leave_date_start, leave_date_end, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id, status`,
          [me.company_code, empId, me.name, b.leave_date_start, b.leave_date_end, b.reason || null]);
        return res.status(200).json({ success: true, data: r.rows[0], message: "已提交，等店长审批" });
      }

      if (action === "reimbursement") {
        if (!b.amount) return res.status(400).json({ success: false, error: "金额必填" });
        let url = null;
        if (b.receipt_base64) {
          try { url = saveReceipt(b.receipt_filename, b.receipt_mime, b.receipt_base64); }
          catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        }
        const r = await pool.query(
          `INSERT INTO hr_reimbursements
             (company_code, employee_id, employee_name, amount, item_desc, purchase_date, receipt_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id, status`,
          [me.company_code, empId, me.name, b.amount, b.item_desc || null, b.purchase_date || null, url]);
        return res.status(200).json({ success: true, data: r.rows[0], message: "已提交，等店长审批" });
      }

      if (action === "overtime") {
        if (!b.work_date || !b.hours)
          return res.status(400).json({ success: false, error: "日期和时数必填" });
        const r = await pool.query(
          `INSERT INTO hr_overtime (company_code, employee_id, employee_name, work_date, hours, kind, reason, status)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6,'overtime'),$7,'pending') RETURNING id, status`,
          [me.company_code, empId, me.name, b.work_date, b.hours, b.kind || null, b.reason || null]);
        return res.status(200).json({ success: true, data: r.rows[0], message: "已提交，等店长审批" });
      }

      // 勾掉/取消勾「今天的事」
      if (action === "agenda") {
        const id = parseInt(b.id, 10);
        if (!id) return res.status(400).json({ success: false, error: "缺 id" });
        const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const done = b.status !== "open";
        const r = await pool.query(
          `UPDATE hr_day_agenda
              SET status=$1, done_by=$2, done_at=CASE WHEN $1='done' THEN now() ELSE NULL END
            WHERE id=$3 AND company_code=$4 AND work_date=$5 RETURNING id`,
          [done ? "done" : "open", done ? me.name : null, id, me.company_code, today]);
        if (!r.rowCount) return res.status(400).json({ success: false, error: "没有这件事" });
        return res.status(200).json({ success: true, message: done ? "已完成" : "已取消" });
      }

      // 开店点检:勾一条 或 跳过一条。跳过也留痕——店长看得到谁跳了什么。
      if (action === "checklist") {
        const itemId = parseInt(b.item_id, 10);
        const st = b.status === "skipped" ? "skipped" : "done";
        if (!itemId) return res.status(400).json({ success: false, error: "缺 item_id" });
        const it = (await pool.query(
          "SELECT id, need_photo, title, hint FROM hr_checklist_items WHERE id=$1 AND company_code=$2 AND is_active=true",
          [itemId, me.company_code])).rows[0];
        if (!it) return res.status(400).json({ success: false, error: "没有这一项" });

        let url = null, ai = null;
        if (b.photo_base64) {
          try { url = saveReceipt(b.photo_filename, b.photo_mime, b.photo_base64); }
          catch (e) { return res.status(400).json({ success: false, error: e.message }); }
          // 交 M3 看一眼。只标不拦，判不了或调用失败都不影响打勾
          ai = await reviewPhoto(it.title, it.hint, `data:${b.photo_mime || "image/jpeg"};base64,${b.photo_base64}`);
        }
        // 要求拍照的项，勾"完成"必须有照片；"稍后"不强制（不然会有人干脆不做）
        if (st === "done" && it.need_photo && !url) {
          return res.status(400).json({ success: false, error: `「${it.title}」要拍一张照片` });
        }
        const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
        await pool.query(
          `INSERT INTO hr_checklist_logs
             (company_code, work_date, phase, item_id, employee_id, employee_name, status, photo_url, note)
           VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8)
           ON CONFLICT (company_code, work_date, phase, item_id)
           DO UPDATE SET status=EXCLUDED.status, photo_url=COALESCE(EXCLUDED.photo_url, hr_checklist_logs.photo_url),
                         note=EXCLUDED.note, employee_id=EXCLUDED.employee_id,
                         employee_name=EXCLUDED.employee_name, done_at=now()`,
          [me.company_code, today, itemId, empId, me.name, st, url,
           ai ? JSON.stringify({ note: b.note || null, ai }) : (b.note || null)]);
        let msg = st === "done" ? "记下了" : "已标记稍后";
        if (ai && ai["能判断"] === false) msg = "记下了（照片看不清，店长会再看一眼）";
        else if (ai && ai["合格"] === false) msg = "记下了（AI 觉得还有点问题，店长会看）";
        return res.status(200).json({ success: true, message: msg, ai });
      }

      // 员工自助补资料（入职当天用）。只开紧急联系人 + 身份证首次填写，其余一律不可改。
      if (action === "update_profile") {
        const cur = (await pool.query(
          "SELECT id_card_no, id_card_file FROM hr_employees WHERE id=$1", [empId])).rows[0] || {};
        const sets = [];
        const params = [];
        const done = [];

        if ("emergency_contact" in b) {
          params.push(String(b.emergency_contact || "").trim() || null);
          sets.push(`emergency_contact = $${params.length}`); done.push("紧急联系人");
        }
        if ("emergency_phone" in b) {
          const ph = String(b.emergency_phone || "").trim();
          if (ph && !/^[0-9+\-\s]{6,20}$/.test(ph))
            return res.status(400).json({ success: false, error: "紧急联系电话格式不对" });
          params.push(ph || null);
          sets.push(`emergency_phone = $${params.length}`); done.push("紧急联系电话");
        }
        if (b.id_card_no) {
          if (cur.id_card_no)
            return res.status(400).json({ success: false, error: "身份证号已录入，要更正请找店长" });
          const idn = String(b.id_card_no).trim().toUpperCase();
          if (!/^[0-9]{17}[0-9X]$/.test(idn))
            return res.status(400).json({ success: false, error: "身份证号要18位" });
          params.push(idn); sets.push(`id_card_no = $${params.length}`); done.push("身份证号");
        }
        if (b.id_card_base64) {
          if (cur.id_card_file)
            return res.status(400).json({ success: false, error: "身份证照片已上传过，要更换请找店长" });
          try {
            const rel = savePrivateIdCard(empId, b.id_card_filename, b.id_card_mime, b.id_card_base64);
            params.push(rel); sets.push(`id_card_file = $${params.length}`); done.push("身份证照片");
          } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        }

        if (!sets.length) return res.status(400).json({ success: false, error: "没有要保存的内容" });
        params.push(empId);
        await pool.query(`UPDATE hr_employees SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
        return res.status(200).json({ success: true, message: `已保存：${done.join("、")}` });
      }

      return res.status(400).json({ success: false, error: "action 只能是 unlock / checkin / checkout / leave / reimbursement / overtime / update_profile / checklist / agenda" });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
