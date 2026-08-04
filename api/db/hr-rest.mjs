// /api/db/hr-rest.mjs — 固定休息日规则 + 调休申请审批（后台端，需登录）
//
//   GET  ?view=rules              → 休息日规则（含「现在生效的是哪条」）
//   GET  ?view=requests&status=   → 调休申请
//   POST {action:'set_rule', weekday, effective_from, employee_id?, note?}
//        → 新起一条规则，自动把上一条封口。**不改旧行** —— 否则查不出「那会儿规矩是什么」
//   POST {action:'review', id, status:'approved'|'rejected', review_note?}
//        → 批准时同步写 hr_shifts：orig_date 改上班、new_date 改休息
//
// 🔒 人事域，白名单闸在 api/auth.js 的 hrGate 统一管（不在这里各写一遍）。
import { getPool, setCors } from "./db.js";
import { requireAuth } from "./auth.js";

const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export const WEEKDAY_LABEL = WD;

// 某天该不该休：个人规则优先于全店规则，同级取 effective_from 最新的那条
export async function restWeekdayOn(pool, companyCode, employeeId, onDate) {
  const r = await pool.query(
    `SELECT weekday, employee_id
       FROM hr_rest_rules
      WHERE company_code=$1
        AND (employee_id IS NULL OR employee_id=$2)
        AND effective_from <= $3
        AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY (employee_id IS NOT NULL) DESC, effective_from DESC
      LIMIT 1`, [companyCode, employeeId || null, onDate]);
  return r.rows[0] ? Number(r.rows[0].weekday) : null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const company = req.query?.company_code || req.body?.company_code || "JINFANG";
  const who = req.user?.username || req.user?.name || "admin";

  try {
    if (req.method === "GET" && req.query?.view === "requests") {
      const st = req.query.status;
      const p = [company]; const c = ["company_code=$1"];
      if (st) { p.push(st); c.push(`status=$${p.length}`); }
      const r = await pool.query(
        `SELECT id, employee_id, employee_name,
                to_char(orig_date,'YYYY-MM-DD') AS orig_date,
                to_char(new_date,'YYYY-MM-DD')  AS new_date,
                reason, status, review_note, reviewed_by,
                to_char(created_at  AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI') AS created_at,
                to_char(reviewed_at AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI') AS reviewed_at
           FROM hr_rest_change_requests WHERE ${c.join(" AND ")}
          ORDER BY (status='pending') DESC, created_at DESC LIMIT 300`, p);
      const n = await pool.query(
        "SELECT COUNT(*) AS pending FROM hr_rest_change_requests WHERE company_code=$1 AND status='pending'", [company]);
      return res.status(200).json({ success: true, data: r.rows, pending: Number(n.rows[0].pending) });
    }

    if (req.method === "GET") {
      const r = await pool.query(
        `SELECT id, employee_id, weekday, note, created_by,
                to_char(effective_from,'YYYY-MM-DD') AS effective_from,
                to_char(effective_to,'YYYY-MM-DD')   AS effective_to,
                (effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)) AS active
           FROM hr_rest_rules WHERE company_code=$1
          ORDER BY effective_from DESC, id DESC`, [company]);
      return res.status(200).json({
        success: true, data: r.rows.map((x) => ({ ...x, weekday_label: WD[x.weekday] })),
        weekdays: WD,
      });
    }

    const b = req.body || {};

    // 换规矩 = 新增一条 + 把上一条封口。绝不就地改旧行。
    if (b.action === "set_rule") {
      const wd = Number(b.weekday);
      const from = String(b.effective_from || "");
      if (!Number.isInteger(wd) || wd < 0 || wd > 6)
        return res.status(400).json({ success: false, error: "weekday 只能是 0~6（0=周日）" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from))
        return res.status(400).json({ success: false, error: "生效日期格式要 YYYY-MM-DD" });
      const emp = b.employee_id ? Number(b.employee_id) : null;

      // 上一条（同一适用范围）封口到新规则生效日的前一天
      await pool.query(
        `UPDATE hr_rest_rules
            SET effective_to = ($3::date - INTERVAL '1 day')::date
          WHERE company_code=$1
            AND employee_id IS NOT DISTINCT FROM $2
            AND effective_from < $3
            AND (effective_to IS NULL OR effective_to >= $3)`, [company, emp, from]);

      const r = await pool.query(
        `INSERT INTO hr_rest_rules (company_code, employee_id, weekday, effective_from, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [company, emp, wd, from, b.note || null, who]);
      return res.status(200).json({ success: true, id: r.rows[0].id,
        message: `${from} 起改成${WD[wd]}休息` });
    }

    // 审批调休。批准才动 hr_shifts —— 待审期间排班表不变，免得看着像已经同意了
    if (b.action === "review") {
      const st = b.status;
      if (!["approved", "rejected"].includes(st))
        return res.status(400).json({ success: false, error: "status 只能 approved / rejected" });
      const cur = (await pool.query(
        "SELECT * FROM hr_rest_change_requests WHERE id=$1 AND company_code=$2", [b.id, company])).rows[0];
      if (!cur) return res.status(404).json({ success: false, error: "申请不存在" });
      if (cur.status !== "pending")
        return res.status(409).json({ success: false, error: `这条已经是「${cur.status}」了，不能再批` });

      await pool.query(
        `UPDATE hr_rest_change_requests
            SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now(),
                applied_at = CASE WHEN $1='approved' THEN now() ELSE NULL END
          WHERE id=$4`, [st, b.review_note || null, who, b.id]);

      if (st === "approved") {
        // 原本该休那天 → 改上班；想换那天 → 改休息。没有排班行就补一行。
        for (const [d, rest] of [[cur.orig_date, false], [cur.new_date, true]]) {
          const up = await pool.query(
            `UPDATE hr_shifts SET is_rest_day=$1, note='调休(批准#' || $4 || ')'
              WHERE employee_id=$2 AND work_date=$3 RETURNING id`, [rest, cur.employee_id, d, b.id]);
          if (!up.rows.length) {
            await pool.query(
              `INSERT INTO hr_shifts (employee_id, employee_name, company_code, work_date,
                                      start_time, end_time, shift_label, is_rest_day, note)
               VALUES ($1,$2,$3,$4,'12:00','22:00',$5,$6,'调休(批准#' || $7 || ')')`,
              [cur.employee_id, cur.employee_name, company, d, rest ? "休息" : "营业", rest, b.id]);
          }
        }
      }
      return res.status(200).json({ success: true,
        message: st === "approved" ? "批了，排班已经跟着改" : "已驳回，排班不动" });
    }

    return res.status(400).json({ success: false, error: "action 只能是 set_rule / review" });
  } catch (e) {
    console.error("[hr-rest]", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
