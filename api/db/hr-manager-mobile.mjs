import { signUploadUrl } from "./lib/upload-link.mjs";
import { buildBossdesk, tryBossdeskAction } from "./hr-bossdesk.mjs"; // 0929 老板「待我处理」页后台
const MANAGER_ROLE_FALLBACKS = new Set(["store_manager", "manager", "boss"]);
const DEFAULT_BOSS_EMPLOYEE_IDS = "35";
// 0929 Nora(店长 PET-01)审核第一版·影子模式:NORA_REVIEW=on 时,临期降价建议由
// ~/wt-nora-review/nora-review.mjs 判完统一升成「要我拍板」tasks,本页不再直列
// petstore_nearexp_proposals(同一件事别出现在两处);不设或≠on 时行为完全不变。
// 0929 Claude:默认开(不改服务器 .env);要临时关设 NORA_REVIEW=off
const noraReviewOn = () => String(process.env.NORA_REVIEW || "on").toLowerCase() !== "off";

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

// 0929 Damon:「待审批页很乱,点击不了,看不到」—— 汇总卡从「类别+数字+去处理(跳页)」改成
// 逐条下发明细(每类最多 20 条),前端页内直接拍板。已拍板的(见 boss_decide)按 dedupe_key 排除,不再出现。
const KIND_LABEL = { nearexp: "临期降价", price: "价格", restock: "补货", writeoff: "报损", boss: "要我拍板" };
const DECIDED_FILTER = (ref) => `NOT EXISTS (SELECT 1 FROM tasks t
                         WHERE t.dedupe_key = 'bossdecide:' || ${ref}
                           AND t.status NOT IN ('done','cancelled'))`;

// 0929:Nora 升上来的条目,把「Nora 建议」和「DeepSeek 复核」拆开给 Damon 看(之前截 80 字只看得到 Nora,看不到 DeepSeek 反对)
function noraBrief(desc) {
  const s = String(desc ?? "");
  if (!s.startsWith("Nora建议:")) return null;
  const nora = s.split(" | ")[0].slice(0, 90);
  const ds = (s.match(/DeepSeek:[^|]*/) || [""])[0].trim().slice(0, 70);
  return nora + (ds ? "\n" + ds : "");
}
function detailRow(kind, id, title, desc) {
  const brief = noraBrief(desc);
  return { kind, id, title: String(title ?? "").slice(0, 120), next_action: brief ?? String(desc ?? "").slice(0, 80) };
}

export async function buildApprovalsSummary(pool, { caps, me, empId, leaves, reimb }) {
  const errors = [];
  const canApprove = !!caps.approvals;
  const boss = isBossEmployee(me, empId);

  const nearexpReady = canApprove && !noraReviewOn() ? await safePart(errors, "nearexp_ready", "临期降价待批", null, async () => {
    const r = await pool.query(
      `SELECT DISTINCT ON (product_code)
              product_code, product_name, spec, expiry_date, days_left,
              current_price, suggest_price, stock
         FROM petstore_nearexp_proposals p
        WHERE status='proposed' AND date_verified=true
          AND ${DECIDED_FILTER("'nearexp:' || p.product_code")}
        ORDER BY product_code, expiry_date, id DESC`);
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
      `SELECT DISTINCT ON (product_code)
              product_code, product_name, channel, old_price, target_price, reason, status
         FROM petstore_price_intents p
        WHERE status IN ('proposed','mgr_ok','pending')
          AND ${DECIDED_FILTER("'price:' || p.product_code")}
        ORDER BY product_code, id DESC`);
    return r.rows || [];
  }) : [];

  const restockRows = canApprove && boss ? await safePart(errors, "restock", "补货意向待批", null, async () => {
    const r = await pool.query(
      `SELECT id, product_code, product_name, suggest_qty, min_order
         FROM petstore_restock_intents p
        WHERE status='proposed'
          AND ${DECIDED_FILTER("'restock:' || p.id::text")}
        ORDER BY id`);
    return r.rows || [];
  }) : [];

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
  const priceOnly = Array.isArray(priceRows)
    ? priceRows.filter((x) => !x.product_code || !readyCodes.has(x.product_code))
    : null;
  const writeoffIds = new Set((Array.isArray(writeoffRows) ? writeoffRows : []).map((x) => String(x.id)));
  const bossTaskDeduped = Array.isArray(bossTaskRows)
    ? bossTaskRows.filter((x) => !writeoffIds.has(String(x.id)))
    : null;

  const summary = {
    nearexp_ready: Array.isArray(nearexpReady) ? nearexpReady.length : null,
    nearexp_unverified: nearexpUnverified,
    price: Array.isArray(priceOnly) ? priceOnly.length : null,
    restock: Array.isArray(restockRows) ? restockRows.length : null,
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
    detail: {
      nearexp: (Array.isArray(nearexpReady) ? nearexpReady : []).slice(0, 20).map((x) => detailRow(
        "nearexp", x.product_code, x.product_name || x.product_code || "未命名商品",
        `到期 ${x.expiry_date ?? "?"} · 现 ${x.current_price ?? "?"} → 建议 ${x.suggest_price ?? "?"}` +
        (x.stock != null ? ` · 库存 ${x.stock}` : ""))),
      price: (priceOnly || []).slice(0, 20).map((x) => detailRow(
        "price", x.product_code, x.product_name || x.product_code || "未命名商品",
        `${x.channel || "门店"} ${x.old_price ?? "?"}→${x.target_price ?? "?"} · ${KIND_LABEL.price}意图 ${x.status}`)),
      restock: (Array.isArray(restockRows) ? restockRows : []).slice(0, 20).map((x) => detailRow(
        "restock", x.id, x.product_name || x.product_code || "未命名商品",
        `建议补 ${x.suggest_qty ?? "?"}` + (x.min_order != null ? ` · 起订 ${x.min_order}` : ""))),
      writeoff: (Array.isArray(writeoffRows) ? writeoffRows : []).slice(0, 20).map((x) => detailRow(
        "writeoff", x.id, x.title, x.next_action)),
      boss: (Array.isArray(bossTaskDeduped) ? bossTaskDeduped : []).slice(0, 20).map((x) => detailRow(
        "boss", x.id, x.title, x.next_action)),
    },
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
    purchase_date: x.purchase_date, receipt_url: signUploadUrl(x.receipt_url), status: x.status, created_at: x.created_at,
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
    boss,   // 前端据此决定要不要显示「同意/不同意」——只有老板能拍板(boss_decide 后端再兜一道)
    approvals: {
      leave: leaves.rows || [],
      reimbursements: reimbRows,
      pricing_pending: rollup.pricing_pending,
      boss_tasks_pending: rollup.boss_tasks_pending,
      detail: rollup.detail,
      summary: rollup.summary,
      // 0929 老板「待我处理」页数据(groups+done);非老板返回 null,错误自己兜住不炸本页
      bossdesk: await buildBossdesk(pool, me, empId),
    },
    failures: failures.rows,
    employees: employees.rows || [],
  };
}

export async function tryManagerAction({ action, b, res, pool, me, empId }) {
  // 0929 老板「待我处理」页后台 4 个 action(boss_decide_batch/note/assign/undo);
  // 不是它的 action 返回 false,继续走下面的老通道
  if (await tryBossdeskAction({ action, b, res, pool, me, empId }) !== false) return true;

  if (action !== "boss_decide" && !String(action || "").startsWith("manager_")) return false;

  // 0929 boss_decide:老板在手机上对单条待批直接拍板。只记录决定、不执行 ——
  // 报损/要我拍板(tasks 表):next_holder 转 claude,旧 next_action 保留在后面;
  // 临期/价格/补货:建一条 tasks 转 claude(现成批准接口 petstore-pricing-decide /
  // petstore-restock-decide / petstore-nearexp-act 都是桌面 person/uid 或网关头鉴权,
  // staff 会话调不了,不自造执行逻辑)。dedupe_key 跟 buildApprovalsSummary 的
  // DECIDED_FILTER 对上,拍过的条目不再回到待批列表。
  if (action === "boss_decide") {
    if (!isBossEmployee(me, empId)) return res.status(403).json({ success: false, error: "只有老板能拍板" });
    const kind = String(b.kind || "");
    const decision = b.decision === "no" ? "不同意" : "同意";
    const note = String(b.note || "").trim().slice(0, 200);
    const when = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
    const verdict = `Damon 拍板:${decision}${note ? `(${note})` : ""} · ${when}`;

    if (kind === "writeoff" || kind === "boss") {
      const r = await pool.query(
        `UPDATE tasks
            SET next_holder='claude',
                next_action = $2 || COALESCE(' | old: ' || NULLIF(next_action, ''), ''),
                updated_at = now()
          WHERE id=$1 AND lower(COALESCE(next_holder,''))='damon'
          RETURNING id`,
        [b.task_id, verdict]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "这条已处理或不在你名下" });
      return res.status(200).json({ success: true, data: { id: r.rows[0].id } });
    }

    if (kind === "nearexp" || kind === "price" || kind === "restock") {
      const ref = String(b.task_id ?? "");
      let row = null, desc = "";
      if (kind === "restock") {
        const rid = Number(ref);
        if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ success: false, error: "bad_id" });
        row = (await pool.query(
          `SELECT product_name, product_code, suggest_qty FROM petstore_restock_intents
            WHERE id=$1 AND status='proposed' LIMIT 1`, [rid])).rows[0] || null;
        if (row) desc = `补货 ${row.product_name || row.product_code} · 建议补 ${row.suggest_qty ?? "?"}`;
      } else if (kind === "nearexp") {
        row = (await pool.query(
          `SELECT product_name, product_code, expiry_date, current_price, suggest_price
             FROM petstore_nearexp_proposals
            WHERE product_code=$1 AND status='proposed' AND date_verified=true
            ORDER BY expiry_date, id DESC LIMIT 1`, [ref])).rows[0] || null;
        if (row) desc = `临期降价 ${row.product_name || row.product_code} · 到期 ${row.expiry_date ?? "?"} · ${row.current_price ?? "?"}→${row.suggest_price ?? "?"}`;
      } else {
        row = (await pool.query(
          `SELECT product_name, product_code, channel, old_price, target_price
             FROM petstore_price_intents
            WHERE product_code=$1 AND status IN ('proposed','mgr_ok','pending')
            ORDER BY id DESC LIMIT 1`, [ref])).rows[0] || null;
        if (row) desc = `改价 ${row.product_name || row.product_code} ${row.channel || "门店"} ${row.old_price ?? "?"}→${row.target_price ?? "?"}`;
      }
      if (!row) return res.status(404).json({ success: false, error: "这条已处理或不存在" });
      await pool.query(
        `INSERT INTO tasks (id, title, next_action, status, source, dedupe_key, next_holder, created_at, updated_at)
         VALUES ($1,$2,$3,'open','boss-decide',$4,'claude',now(),now())
         ON CONFLICT (id) DO UPDATE          -- 同一条再次拍板(如上次的任务已做完又回到待批):最新拍板覆盖,别静默丢
           SET next_action=$3, status='open', next_holder='claude', updated_at=now()`,
        [`bd-${kind}-${ref}`, `[拍板]${KIND_LABEL[kind]} ${row.product_name || row.product_code}`,
         `${verdict} | ${desc}`, `bossdecide:${kind}:${ref}`]);
      return res.status(200).json({ success: true, data: { kind, ref } });
    }
    return res.status(400).json({ success: false, error: "未知类别" });
  }

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
