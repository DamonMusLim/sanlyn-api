const MANAGER_ROLE_FALLBACKS = new Set(["store_manager", "manager", "boss"]);
const DEFAULT_BOSS_EMPLOYEE_IDS = "35";

function actorName(me) {
  return me?.name || me?.employee_code || `employee:${me?.id || ""}`;
}

async function capsForEmployee(pool, empId, me) {
  if (me?.__authForTest) return me.__authForTest;
  const reqLike = { user: { employee_id: empId } };
  const { resolvePerson, capSources } = await import("./authz.js");
  const person = await resolvePerson(reqLike, { pool, audit: false });
  const fallback = MANAGER_ROLE_FALLBACKS.has(String(me.role || ""));
  return { person, fallback, capSources };
}

function hasCap(auth, cap) {
  return auth.person?.caps?.includes(cap) || auth.fallback;
}

function reimbLimit(auth) {
  let n = 0;
  const sources = auth.capSources || (() => []);
  for (const src of sources(auth.person, "reimb.approve")) {
    const c = src.constraints || {};
    const amount = Number(c.amount || c.limit || c.final_limit_cny || 0);
    if (amount > n) n = amount;
  }
  return n || (auth.fallback ? 200 : 0);
}

function countRows(rows) {
  return rows?.[0]?.pending;
}

function isBossEmployee(me, empId) {
  const ids = String(process.env.BOSS_EMPLOYEE_IDS || DEFAULT_BOSS_EMPLOYEE_IDS)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const mine = String(me?.id || me?.employee_id || empId || "");
  return ids.includes(mine);
}

async function safePart(errors, key, label, fallback, fn) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err?.message || err}`);
    return fallback;
  }
}

function approvalTotal(summary) {
  return ["nearexp_ready", "price", "restock", "writeoff", "boss_tasks", "leave", "reimb"]
    .reduce((n, key) => n + (Number.isFinite(Number(summary[key])) ? Number(summary[key]) : 0), 0);
}

export async function buildApprovalsSummary(pool, { caps, me, empId, leaves, reimb }) {
  const errors = [];
  const canApprove = !!caps.approvals;
  const boss = isBossEmployee(me, empId);

  const nearexpReady = canApprove ? await safePart(errors, "nearexp_ready", "临期降价待批", null, async () => {
    const r = await pool.query(
      `SELECT DISTINCT
              COALESCE(NULLIF(product_code,''), '__nearexp:' || id::text) AS item_key,
              NULLIF(product_code,'') AS product_code
         FROM petstore_nearexp_proposals
        WHERE status='proposed' AND date_verified=true`);
    return r.rows || [];
  }) : [];

  const nearexpUnverified = canApprove ? await safePart(errors, "nearexp_unverified", "临期降价待核日期", null, async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS pending
         FROM petstore_nearexp_proposals
        WHERE status='proposed' AND COALESCE(date_verified,false)=false`);
    return countRows(r.rows) || 0;
  }) : 0;

  const priceRows = canApprove ? await safePart(errors, "price", "价格意图待批", null, async () => {
    const r = await pool.query(
      `SELECT DISTINCT
              COALESCE(NULLIF(product_code,''), '__price:' || id::text) AS item_key,
              NULLIF(product_code,'') AS product_code
         FROM petstore_price_intents
        WHERE status IN ('proposed','mgr_ok','pending')`);
    return r.rows || [];
  }) : [];

  const restock = canApprove && boss ? await safePart(errors, "restock", "补货意向待批", null, async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS pending
         FROM petstore_restock_intents
        WHERE status='proposed'`);
    return countRows(r.rows) || 0;
  }) : null;

  const writeoffRows = canApprove ? await safePart(errors, "writeoff", "报损待批", null, async () => {
    const r = await pool.query(
      `SELECT id, title, next_action, created_at
         FROM tasks
        WHERE status IN ('open','pending_review')
          AND source='dataops'
          AND (COALESCE(title,'') ~ '报损' OR COALESCE(dedupe_key,'') ~ 'writeoff|loss|risk')
          -- 0927:同批「下架+核日期」是给店员(PET-12)的,不是老板待批,只算交给 Damon 的
          AND lower(COALESCE(next_holder,''))='damon'
        ORDER BY created_at DESC NULLS LAST, id DESC`);
    return r.rows || [];
  }) : [];

  const bossTaskRows = canApprove ? await safePart(errors, "boss_tasks", "CAW需人工工单", null, async () => {
    const r = await pool.query(
      `SELECT id, title, next_action, created_at
         FROM tasks
        WHERE status=$1 AND task_prefix=$2 AND needs_human=$3
          AND lower(COALESCE(next_holder,''))='damon'
        ORDER BY created_at DESC NULLS LAST, id DESC`,
      ["open", "CAW", true]);
    return r.rows || [];
  }) : [];

  // 0927 Damon:「这些问题都可以转工单任务,不该到我这」—— 交给别人(AI/店员/技术)的工单只通知,不计入待审批
  const ticketsFyi = canApprove ? await safePart(errors, "tickets_fyi", "工单进行中", null, async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS pending
         FROM tasks
        WHERE status=$1 AND task_prefix=$2 AND needs_human=$3
          AND lower(COALESCE(next_holder,''))<>'damon'`,
      ["open", "CAW", true]);
    return countRows(r.rows) || 0;
  }) : null;

  const readyCodes = new Set((Array.isArray(nearexpReady) ? nearexpReady : [])
    .map((x) => x.product_code)
    .filter(Boolean));
  const price = Array.isArray(priceRows)
    ? priceRows.filter((x) => !x.product_code || !readyCodes.has(x.product_code)).length
    : null;
  const writeoffIds = new Set((Array.isArray(writeoffRows) ? writeoffRows : []).map((x) => String(x.id)));
  const bossTaskDeduped = Array.isArray(bossTaskRows)
    ? bossTaskRows.filter((x) => !writeoffIds.has(String(x.id)))
    : null;

  const summary = {
    nearexp_ready: Array.isArray(nearexpReady) ? nearexpReady.length : null,
    nearexp_unverified: nearexpUnverified,
    price,
    restock,
    writeoff: Array.isArray(writeoffRows) ? writeoffRows.length : null,
    boss_tasks: Array.isArray(bossTaskDeduped) ? bossTaskDeduped.length : null,
    leave: Array.isArray(leaves) ? leaves.length : null,
    reimb: Array.isArray(reimb) ? reimb.length : null,
    tickets_fyi: ticketsFyi,
    total: 0,
  };
  summary.total = approvalTotal(summary);
  if (errors.length) summary.errors = errors;
  return {
    summary,
    pricing_pending: summary.price,
    boss_tasks_pending: summary.boss_tasks,
    boss_tasks: Array.isArray(bossTaskDeduped) ? bossTaskDeduped.slice(0, 5).map((x) => ({
      id: x.id,
      title: x.title,
      next_action: x.next_action,
    })) : [],
  };
}

export async function managerExtras(pool, empId, me) {
  const auth = await capsForEmployee(pool, empId, me);
  const boss = isBossEmployee(me, empId);
  const caps = {
    dashboard: hasCap(auth, "store.dashboard.view") || hasCap(auth, "boss.dashboard.view"),
    approvals: hasCap(auth, "leave.approve") || hasCap(auth, "reimb.approve") || hasCap(auth, "pricing.review") || boss,
  };
  if (!caps.dashboard && !caps.approvals) return null;

  const errors = [];
  const [leaves, reimb, failures, employees] = await Promise.all([
    caps.approvals ? safePart(errors, "leave", "请假待批", { rows: null }, () => pool.query(
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
        ORDER BY l.created_at LIMIT 50`, [me.company_code])) : { rows: [] },
    caps.approvals ? safePart(errors, "reimb", "报销待批", { rows: null }, () => pool.query(
      `SELECT id, employee_id, employee_name, store_id, amount, item_desc,
              to_char(purchase_date,'YYYY-MM-DD') AS purchase_date,
              receipt_url, status, created_at
         FROM hr_reimbursements
        WHERE status='pending' AND COALESCE(company_code,$1)=$1
        ORDER BY created_at LIMIT 50`, [me.company_code])) : { rows: [] },
    caps.dashboard ? safePart(errors, "failures", "失败红灯", { rows: [] }, () => pool.query(
      `SELECT id, source, impact, error_message, first_seen_at, last_seen_at, seen_count
         FROM job_failures WHERE status='open'
        ORDER BY last_seen_at DESC LIMIT 20`)) : { rows: [] },
    caps.dashboard ? safePart(errors, "employees", "员工用工类型", { rows: [] }, () => pool.query(
      `SELECT id, name, position, pay_type,
              COALESCE(employment_type, CASE WHEN pay_type='monthly' THEN 'fulltime' ELSE 'parttime' END) AS employment_type
         FROM hr_employees
        WHERE company_code=$1 AND employment_status='active'
        ORDER BY name LIMIT 200`, [me.company_code])) : { rows: [] },
  ]);
  const reimbRows = (reimb.rows || []).map((x) => ({
    id: x.id, employee_id: x.employee_id, employee_name: x.employee_name,
    store_id: x.store_id, amount: x.amount, item_desc: x.item_desc,
    purchase_date: x.purchase_date, receipt_url: x.receipt_url, status: x.status, created_at: x.created_at,
  }));
  const rollup = await buildApprovalsSummary(pool, {
    caps,
    me,
    empId,
    leaves: leaves.rows,
    reimb: reimb.rows,
  });
  if (errors.length) {
    rollup.summary.errors = [...(rollup.summary.errors || []), ...errors];
  }

  return {
    capabilities: caps,
    constraints: { reimb_final_limit_cny: reimbLimit(auth) },
    approvals: {
      leave: leaves.rows || [],
      reimbursements: reimbRows,
      pricing_pending: rollup.pricing_pending,
      boss_tasks_pending: rollup.boss_tasks_pending,
      boss_tasks: rollup.boss_tasks,
      summary: rollup.summary,
    },
    failures: failures.rows,
    employees: employees.rows || [],
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

  if (action === "manager_employee_type") {
    if (!hasCap(auth, "store.dashboard.view") && !hasCap(auth, "boss.dashboard.view")) {
      return res.status(403).json({ success: false, error: "无员工资料管理能力" });
    }
    const type = b.employment_type === "parttime" ? "parttime" : "fulltime";
    const r = await pool.query(
      `UPDATE hr_employees
          SET employment_type=$3
        WHERE id=$1 AND company_code=$2 AND employment_status='active'
        RETURNING id,name,employment_type`,
      [b.id, me.company_code, type]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
    return res.status(200).json({ success: true, data: r.rows[0] });
  }

  return res.status(400).json({ success: false, error: "未知店长动作" });
}
