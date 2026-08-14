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
import { getPool, setCors } from "./db.js";
import { verifyToken } from "./auth.js";
import { restWeekdayOn } from "./hr-rest.mjs";
import { tryStaffSubmit } from "./hr-staff-submits.mjs";
import {
  D, PRIVATE_ROOT, agendaFor, reviewPhoto, openChecklist,
  todoFor, saveReceipt, savePrivateIdCard, monthOf,
} from "./hr-staff-portal-lib.mjs";

// 员工自己传的证件也进凭据柜(hr_employee_docs)。存不进去不影响他交资料 —— 快捷指针已经写了。
async function vaultPut(pool, company, empId, kind, rel, mime) {
  try {
    await pool.query(
      `INSERT INTO hr_employee_docs (company_code, employee_id, kind, file_path, mime, source, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,'staff_app',$6)`,
      [company, empId, kind, rel, mime || null, `self:${empId}`]);
    await pool.query(
      `UPDATE hr_employee_docs SET archived_at=now(), archived_by='system', archive_note='被员工自己传的新版本替换'
        WHERE employee_id=$1 AND kind=$2 AND file_path<>$3 AND archived_at IS NULL`, [empId, kind, rel]);
  } catch (e) { console.error("[vaultPut]", e.message); }
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
              pay_type, pay_rate, emergency_contact, emergency_phone,
              id_card_back_file, bank_account_no, bank_name, materials_done_at
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
      const pt = await pool.query(
        `SELECT code, label, lat, lng, radius_m FROM hr_checkin_points
          WHERE company_code=$1 AND is_active=true ORDER BY code LIMIT 1`, [me.company_code]);
      const restWd = await restWeekdayOn(pool, me.company_code, empId, today);
      const restNext = await pool.query(
        `SELECT weekday, to_char(effective_from,'YYYY-MM-DD') AS effective_from, note
           FROM hr_rest_rules
          WHERE company_code=$1 AND (employee_id IS NULL OR employee_id=$2)
            AND effective_from > $3
          ORDER BY effective_from LIMIT 1`, [me.company_code, empId, today]);
      const sug = await pool.query(
        `SELECT id, content, status, reply, replied_by,
                to_char(created_at AT TIME ZONE 'Asia/Shanghai','MM-DD') AS created_at
           FROM hr_suggestions WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 10`, [empId]);
      const restReq = await pool.query(
        `SELECT id, to_char(orig_date,'YYYY-MM-DD') AS orig_date,
                to_char(new_date,'YYYY-MM-DD') AS new_date,
                reason, status, review_note,
                to_char(created_at AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI') AS created_at
           FROM hr_rest_change_requests
          WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 8`, [empId]);
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
              emergency_contact: me.emergency_contact, emergency_phone: me.emergency_phone,
              has_id_card_back: !!me.id_card_back_file,
              // 卡号只回后4位 —— 员工端也没必要把整串亮在屏幕上
              bank_tail: me.bank_account_no ? String(me.bank_account_no).slice(-4) : null,
              bank_name: me.bank_name,
              missing: [
                me.id_card_no ? null : "身份证号",
                me.id_card_file ? null : "身份证人像面",
                me.id_card_back_file ? null : "身份证国徽面",
                me.emergency_contact ? null : "紧急联系人",
                me.bank_account_no ? null : "工资卡",
              ].filter(Boolean) },
        month,
        // 打卡点回给前端 —— 开门确认弹窗要拿它算「你离店多远」
        point: pt.rows[0] || null,
        // 休息日规则（每周几）+ 我的调休申请。规则说了算,员工改不动,只能申请。
        rest_weekday: restWd,
        rest_next: restNext.rows[0] || null,   // 下一条还没生效的规则(有就提前告诉员工)
        rest_requests: restReq.rows,
        suggestions: sug.rows,          // 我提过的建议(含店长回复)
        todo: todoFor(me.company_code),
        checklist: await openChecklist(pool, me.company_code, today, "open"),
        checklist_close: await openChecklist(pool, me.company_code, today, "close"),
        agenda: await agendaFor(pool, me.company_code, today),
        shifts: shifts.rows, leaves: leaves.rows, reimbursements: reimb.rows,
        payslips: pay.rows, overtime: ot.rows, handbook: book.rows,
      });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const action = b.action;
      // 「今天」按 +08 算,unlock 和调休都用这一个,别各算各的
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

      // ── 打卡开门（0730 Damon 定名）─────────────────────────────
      // 一个动作 = 开门 + 打卡 + 摄像头抓拍。设计意图(Damon原话)：
      //   "打卡开门 + 监控拍照，也是刚好测试员工的诚信度"
      //   —— 在家远程点开门，照片里没人，诚信问题自己就暴露。
      // 编排放在 HR 侧(forge 评审推荐方案c)：员工身份只认 staff JWT，
      // 门锁能力仍只在网关一处，HR 用服务令牌代调，不把 HR 鉴权扩散进 yudao。
      // 铁律：**门没开成绝不记打卡**；开了但记打卡失败要能看出来(留 suspicious)。
      if (action === "unlock") {
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
          // ⚠️ 摄像头只有 mini 够得着,而且腾讯的 127.0.0.1:3721 是本机的 pet-ai-clerk(没这个路由,
          //    一直静默 404 → 每条打卡都标「无抓拍」)。这里走 tailscale 直连 mini。
          const CAP = process.env.CHECKIN_CAPTURE_URL || "http://100.87.134.113:3721/api/checkin/capture";
          const cr = await fetch(CAP, { signal: AbortSignal.timeout(15000) });
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
        } else {
          // 0802 Damon 定：**下班不打卡，只记上班**。再点开门 = 只开门，绝不动打卡记录。
          what = "今天已打卡";
        }
        return res.status(200).json({ success:true, opened:true,
          message: `门已开 · ${what}`, distance_m: distance, suspicious: susp });
      }

      // 扫墙上二维码打卡（保留：没门禁的点位/门锁故障时兜底）
      // 首次标定店址。**只有还没标过才让设** —— 否则有人在家一点就把店"搬"到自己家了。
      // 要改已标定的，去后台改，不走员工端。谁设的/什么时候设的都留痕。
      if (action === "set_point_location") {
        const la = Number(b.lat), ln = Number(b.lng), acc = Number(b.accuracy);
        if (!Number.isFinite(la) || !Number.isFinite(ln))
          return res.status(400).json({ success:false, error:"没拿到定位" });
        if (Number.isFinite(acc) && acc > 100)
          return res.status(400).json({ success:false, error:`定位精度只有 ±${Math.round(acc)} 米，太飘了，到门口再试` });
        const cur = (await pool.query(
          `SELECT code, lat FROM hr_checkin_points
            WHERE company_code=$1 AND is_active=true ORDER BY code LIMIT 1`, [me.company_code])).rows[0];
        if (!cur) return res.status(400).json({ success:false, error:"没配打卡点位" });
        if (cur.lat != null)
          return res.status(409).json({ success:false, error:"店址已经标定过了，要改找店长在后台改" });
        await pool.query(
          `UPDATE hr_checkin_points
              SET lat=$1, lng=$2, located_by=$3, located_at=now()
            WHERE code=$4`, [la, ln, `${me.name}/${empId}`, cur.code]);
        return res.status(200).json({ success:true,
          message:"店址标好了，以后开门会显示你离店多远" });
      }

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

      // 员工「只能提不能批」的那几个动作(请假/报销/加班/调休/建议)拆到 hr-staff-submits.mjs
      if (await tryStaffSubmit({ action, b, res, pool, me, empId, today })) return;

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
          `SELECT id_card_no, id_card_file, id_card_back_file, emergency_contact, bank_account_no
             FROM hr_employees WHERE id=$1`, [empId])).rows[0] || {};
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
        if ("bank_account_no" in b) {
          const acc = String(b.bank_account_no || "").replace(/\s/g, "");
          if (acc && !/^\d{12,25}$/.test(acc))
            return res.status(400).json({ success: false, error: "卡号只填数字，12~25位" });
          params.push(acc || null); sets.push(`bank_account_no = $${params.length}`); done.push("工资卡");
        }
        if ("bank_name" in b) {
          params.push(String(b.bank_name || "").trim().slice(0, 40) || null);
          sets.push(`bank_name = $${params.length}`); done.push("开户行");
        }
        if (b.id_card_back_base64) {
          if (cur.id_card_back_file)
            return res.status(400).json({ success: false, error: "国徽面已上传过，要更换请找店长" });
          try {
            const rel = savePrivateIdCard(empId, b.id_card_back_filename, b.id_card_back_mime, b.id_card_back_base64);
            params.push(rel); sets.push(`id_card_back_file = $${params.length}`); done.push("身份证国徽面");
            await vaultPut(pool, me.company_code, empId, "id_card_back", rel, b.id_card_back_mime);
          } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        }
        if (b.id_card_base64) {
          if (cur.id_card_file)
            return res.status(400).json({ success: false, error: "身份证照片已上传过，要更换请找店长" });
          try {
            const rel = savePrivateIdCard(empId, b.id_card_filename, b.id_card_mime, b.id_card_base64);
            params.push(rel); sets.push(`id_card_file = $${params.length}`); done.push("身份证照片");
            await vaultPut(pool, me.company_code, empId, "id_card_front", rel, b.id_card_mime);
          } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        }

        if (!sets.length) return res.status(400).json({ success: false, error: "没有要保存的内容" });
        params.push(empId);
        await pool.query(`UPDATE hr_employees SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
        // 五样都齐了就盖个时间戳，店长后台照这个标「资料未齐」。只盖一次，不回退。
        await pool.query(
          `UPDATE hr_employees SET materials_done_at = now()
            WHERE id = $1 AND materials_done_at IS NULL
              AND id_card_no IS NOT NULL AND id_card_file IS NOT NULL
              AND id_card_back_file IS NOT NULL AND emergency_contact IS NOT NULL
              AND bank_account_no IS NOT NULL`, [empId]);
        return res.status(200).json({ success: true, message: `已保存：${done.join("、")}` });
      }

      return res.status(400).json({ success: false, error: "action 只能是 unlock / set_point_location / checkin / checkout / leave / reimbursement / reimbursement_ocr / overtime / update_profile / checklist / agenda / rest_change / suggest" });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
