import { capSources } from "./authz.js";

const MANAGER_ROLE_FALLBACKS = new Set(["store_manager", "manager", "boss"]);

function actorName(me) {
  return me?.name || me?.employee_code || `employee:${me?.id || ""}`;
}

async function capsForEmployee(pool, empId, me) {
  const reqLike = { user: { employee_id: empId } };
  const { resolvePerson } = await import("./authz.js");
  const person = await resolvePerson(reqLike, { pool, audit: false });
  const fallback = MANAGER_ROLE_FALLBACKS.has(String(me.role || ""));
  return { person, fallback };
}

function hasCap(auth, cap) {
  return auth.person?.caps?.includes(cap) || auth.fallback;
}

function reimbLimit(auth) {
  let n = 0;
  for (const src of capSources(auth.person, "reimb.approve")) {
    const c = src.constraints || {};
    const amount = Number(c.amount || c.limit || c.final_limit_cny || 0);
    if (amount > n) n = amount;
  }
  return n || (auth.fallback ? 200 : 0);
}

export async function managerExtras(pool, empId, me) {
  const auth = await capsForEmployee(pool, empId, me);
  const caps = {
    dashboard: hasCap(auth, "store.dashboard.view") || hasCap(auth, "boss.dashboard.view"),
    approvals: hasCap(auth, "leave.approve") || hasCap(auth, "reimb.approve") || hasCap(auth, "pricing.review"),
  };
  if (!caps.dashboard && !caps.approvals) return null;

  const [leaves, reimb, prices, failures] = await Promise.all([
    caps.approvals ? pool.query(
      `SELECT l.id, l.employee_id, l.employee_name, l.store_id,
              to_char(l.leave_date_start,'YYYY-MM-DD') AS leave_date_start,
              to_char(l.leave_date_end,'YYYY-MM-DD') AS leave_date_end,
              l.leave_unit, l.reason, l.status, l.created_at,
              COALESCE(s.shift_days,0)::int AS shift_days
         FROM hr_leave_requests l
    LEFT JOIN LATERAL (
              SELECT COUNT(*) AS shift_days
                FROM hr_shifts s
               WHERE s.employee_id=l.employee_id
                 AND s.work_date BETWEEN l.leave_date_start AND l.leave_date_end
                 AND COALESCE(s.is_rest_day,false)=false
            ) s ON true
        WHERE l.status='pending' AND COALESCE(l.company_code,$1)=$1
        ORDER BY l.created_at LIMIT 50`, [me.company_code]) : { rows: [] },
    caps.approvals ? pool.query(
      `SELECT id, employee_id, employee_name, store_id, amount, item_desc,
              to_char(purchase_date,'YYYY-MM-DD') AS purchase_date,
              receipt_url, status, created_at
         FROM hr_reimbursements
        WHERE status='pending' AND COALESCE(company_code,$1)=$1
        ORDER BY created_at LIMIT 50`, [me.company_code]) : { rows: [] },
    caps.approvals ? pool.query(
      `SELECT COUNT(*)::int AS pending
         FROM petstore_price_intents
        WHERE status IN ('proposed','mgr_ok','pending','approved')`) : { rows: [{ pending: 0 }] },
    caps.dashboard ? pool.query(
      `SELECT id, source, impact, error_message, first_seen_at, last_seen_at, seen_count
         FROM job_failures WHERE status='open'
        ORDER BY last_seen_at DESC LIMIT 20`) : { rows: [] },
  ]);

  return {
    capabilities: caps,
    constraints: { reimb_final_limit_cny: reimbLimit(auth) },
    approvals: {
      leave: leaves.rows,
      reimbursements: reimb.rows.map((x) => ({
        id: x.id, employee_id: x.employee_id, employee_name: x.employee_name,
        store_id: x.store_id, amount: x.amount, item_desc: x.item_desc,
        purchase_date: x.purchase_date, receipt_url: x.receipt_url, status: x.status, created_at: x.created_at,
      })),
      pricing_pending: prices.rows[0]?.pending || 0,
    },
    failures: failures.rows,
  };
}

export async function tryManagerAction({ action, b, res, pool, me, empId }) {
  if (!String(action || "").startsWith("manager_")) return false;
  const auth = await capsForEmployee(pool, empId, me);
  const status = b.status === "rejected" ? "rejected" : "approved";
  const note = String(b.review_note || "").slice(0, 300) || null;
  const actor = actorName(me);

  if (action === "manager_leave_review") {
    if (!hasCap(auth, "leave.approve")) return res.status(403).json({ success: false, error: "无请假审批能力" });
    const before = (await pool.query(
      `SELECT id, employee_id, employee_name, leave_date_start, leave_date_end, leave_unit, reason, status
         FROM hr_leave_requests WHERE id=$1 AND status='pending'`, [b.id])).rows[0];
    if (!before) return res.status(404).json({ success: false, error: "请假单不存在或已处理" });
    const snap = { type: "leave", request: before, schedule_impact: b.schedule_impact || null };
    const r = await pool.query(
      `UPDATE hr_leave_requests
          SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now(),
              approval_snapshot=$5::jsonb, approval_actor_person_id=$6
        WHERE id=$1 AND status='pending' RETURNING *`,
      [b.id, status, note, actor, JSON.stringify(snap), auth.person?.person_id || null]);
    return res.status(200).json({ success: true, data: r.rows[0] });
  }

  if (action === "manager_reimb_review") {
    if (!hasCap(auth, "reimb.approve")) return res.status(403).json({ success: false, error: "无报销审批能力" });
    const limit = reimbLimit(auth);
    const before = (await pool.query(
      `SELECT id, employee_id, employee_name, amount, item_desc, purchase_date, receipt_url, status
         FROM hr_reimbursements WHERE id=$1 AND status='pending'`, [b.id])).rows[0];
    if (!before) return res.status(404).json({ success: false, error: "报销单不存在或已处理" });
    if (status === "approved" && Number(before.amount) > limit) {
      return res.status(403).json({ success: false, error: `超过店长终批额度 ${limit} 元，转 CEO`, requires_ceo: true });
    }
    const snap = { type: "reimbursement", request: before, limit_cny: limit };
    const r = await pool.query(
      `UPDATE hr_reimbursements
          SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now(),
              approval_snapshot=$5::jsonb, approval_actor_person_id=$6
        WHERE id=$1 AND status='pending' RETURNING *`,
      [b.id, status, note, actor, JSON.stringify(snap), auth.person?.person_id || null]);
    return res.status(200).json({ success: true, data: r.rows[0] });
  }

  return res.status(400).json({ success: false, error: "未知店长动作" });
}
