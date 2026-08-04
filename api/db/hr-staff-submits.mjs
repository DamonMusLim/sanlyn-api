// /api/db/hr-staff-submits.mjs — 员工端「只能提、不能批」的那几个动作
//   请假 / 报销 / 加班 / 调休 / 建议
//
// 从 hr-staff-portal.mjs 拆出来（0804，单文件≤500行铁律）。
// 共同点：**status 一律 pending，员工改不了自己的审批状态**；审批在后台各自的模块里。
// 返回 true = 已处理并已 res.json()，调用方直接 return。
import { saveReceipt } from "./hr-staff-portal-lib.mjs";

export async function tryStaffSubmit(ctx) {
  const { action, b, res, pool, me, empId, today } = ctx;
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

    // 选这周的休息日(上六休一,员工自己挑)
    // 调休申请（0804 Damon：「申请后要等审批」）。
    // 原来这里是 restday —— 员工点一下直接改 hr_shifts，等于自己给自己批假，已拆掉。
    // 现在只写申请单；批准了由 hr-rest 的 review 去动排班。
    if (action === "restday" || action === "rest_change") {
      const od = String(b.orig_date || "");
      const nd = String(b.new_date || b.date || "");
      const ok = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x);
      if (!ok(od) || !ok(nd))
        return res.status(400).json({ success:false, error:"要选「本来休哪天」和「想换到哪天」" });
      if (od === nd) return res.status(400).json({ success:false, error:"换的是同一天" });
      if (nd < today) return res.status(400).json({ success:false, error:"不能把休息改到过去" });
      const dup = await pool.query(
        "SELECT id FROM hr_rest_change_requests WHERE employee_id=$1 AND orig_date=$2 AND status='pending'",
        [empId, od]);
      if (dup.rows.length)
        return res.status(409).json({ success:false, error:"这天已经提过一次了，等店长批" });
      await pool.query(
        `INSERT INTO hr_rest_change_requests
           (company_code, employee_id, employee_name, orig_date, new_date, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [me.company_code, empId, me.name, od, nd, String(b.reason || "").slice(0, 200) || null]);
      return res.status(200).json({ success:true, message:"交上去了，等店长批" });
    }

    // 员工提建议。只能提，改不了状态 —— 采纳与否是店长的事。
    if (action === "suggest") {
      const c = String(b.content || "").trim();
      if (c.length < 4) return res.status(400).json({ success:false, error:"多写两句，太短看不明白" });
      if (c.length > 1000) return res.status(400).json({ success:false, error:"太长了，说重点" });
      const recent = await pool.query(
        `SELECT COUNT(*) n FROM hr_suggestions
          WHERE employee_id=$1 AND created_at > now() - INTERVAL '10 minutes'`, [empId]);
      if (Number(recent.rows[0].n) >= 3)
        return res.status(429).json({ success:false, error:"一会儿提太多了，歇会儿再说" });
      await pool.query(
        `INSERT INTO hr_suggestions (company_code, employee_id, employee_name, content)
         VALUES ($1,$2,$3,$4)`, [me.company_code, empId, me.name, c]);
      return res.status(200).json({ success:true, message:"收到了，店长会看 🙏" });
    }
  return false;
}
