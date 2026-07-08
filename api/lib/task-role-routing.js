const ACTIVE_TASK_STATUSES = ["open", "doing"];

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

async function hasColumn(pool, tableName, columnName) {
  const r = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [tableName, columnName]
  );
  return r.rowCount > 0;
}

async function loadTaskCounts(pool) {
  const hasAssigneeUserId = await hasColumn(pool, "tasks", "assignee_user_id");
  const hasAssignedTo = await hasColumn(pool, "tasks", "assigned_to");
  if (!hasAssigneeUserId && !hasAssignedTo) return new Map();

  const selects = [];
  if (hasAssigneeUserId) {
    selects.push(
      `SELECT assignee_user_id::text AS user_id, NULL::text AS username, COUNT(*)::int AS task_count
         FROM tasks
        WHERE status = ANY($1)
          AND assignee_user_id IS NOT NULL
        GROUP BY assignee_user_id`
    );
  }
  if (hasAssignedTo) {
    selects.push(
      `SELECT NULL::text AS user_id, assigned_to::text AS username, COUNT(*)::int AS task_count
         FROM tasks
        WHERE status = ANY($1)
          AND assigned_to IS NOT NULL
        GROUP BY assigned_to`
    );
  }

  const r = await pool.query(selects.join(" UNION ALL "), [ACTIVE_TASK_STATUSES]);
  const counts = new Map();
  for (const row of r.rows) {
    if (row.user_id) counts.set("id:" + row.user_id, (counts.get("id:" + row.user_id) || 0) + row.task_count);
    if (row.username) counts.set("username:" + row.username, (counts.get("username:" + row.username) || 0) + row.task_count);
  }
  return counts;
}

function scoreCandidate(candidate, counts) {
  return (
    (candidate.user_id ? counts.get("id:" + candidate.user_id) || 0 : 0) +
    (candidate.username ? counts.get("username:" + candidate.username) || 0 : 0)
  );
}

async function loadCandidates(pool, logicalRole) {
  const role = normalizeRole(logicalRole);
  if (!role) return [];

  const r = await pool.query(
    `WITH routes AS (
       SELECT logical_role, match_type, match_value, priority
         FROM role_routing
        WHERE active = TRUE
          AND logical_role = $1
     ),
     by_title AS (
       SELECT r.priority, r.match_type, r.match_value,
              e.user_id::text AS user_id, e.id AS employee_id, e.name AS employee_name,
              a.username, a.role AS account_role
         FROM routes r
         JOIN employees e ON e.title_key = r.match_value AND e.status = 'ACTIVE'
         LEFT JOIN accounts a ON a.id::text = e.user_id::text
        WHERE r.match_type = 'employees.title_key'
     ),
     by_account_role AS (
       SELECT r.priority, r.match_type, r.match_value,
              e.user_id::text AS user_id, e.id AS employee_id, e.name AS employee_name,
              a.username, a.role AS account_role
         FROM routes r
         JOIN accounts a ON a.role = r.match_value
         JOIN employees e ON e.user_id::text = a.id::text AND e.status = 'ACTIVE'
        WHERE r.match_type = 'accounts.role'
     ),
     by_username AS (
       SELECT r.priority, r.match_type, r.match_value,
              e.user_id::text AS user_id, e.id AS employee_id, e.name AS employee_name,
              a.username, a.role AS account_role
         FROM routes r
         JOIN accounts a ON a.username = r.match_value
         LEFT JOIN employees e ON e.user_id::text = a.id::text AND e.status = 'ACTIVE'
        WHERE r.match_type = 'accounts.username'
          AND (e.id IS NOT NULL OR a.role = 'admin')
     )
     SELECT DISTINCT ON (COALESCE(user_id, username), match_type, match_value)
            priority, match_type, match_value, user_id, employee_id, employee_name, username, account_role
       FROM (
         SELECT * FROM by_title
         UNION ALL SELECT * FROM by_account_role
         UNION ALL SELECT * FROM by_username
       ) s
      ORDER BY COALESCE(user_id, username), match_type, match_value, priority`,
    [role]
  );
  return r.rows;
}

async function loadFallbackCandidates(pool) {
  const r = await pool.query(
    `SELECT a.id::text AS user_id, e.id AS employee_id, COALESCE(e.name, a.username) AS employee_name,
            a.username, a.role AS account_role, 1000 AS priority,
            'fallback' AS match_type, a.username AS match_value
       FROM accounts a
       LEFT JOIN employees e ON e.user_id::text = a.id::text AND e.status = 'ACTIVE'
      WHERE (a.username IN ('damon_sl','damon','Damon') OR a.role = 'admin')
        AND a.username <> 'claude_qa'
        AND a.is_active = TRUE
      ORDER BY CASE WHEN a.username = 'damon_sl' THEN 0 WHEN LOWER(a.username) LIKE 'damon%' THEN 1 ELSE 2 END, a.created_at ASC NULLS LAST
      LIMIT 20`
  );
  return r.rows;
}

export async function resolveActiveAssignee(pool, logicalRole) {
  const role = normalizeRole(logicalRole);
  const counts = await loadTaskCounts(pool);
  let candidates = await loadCandidates(pool, role);
  let fallback = false;

  if (candidates.length === 0) {
    candidates = await loadFallbackCandidates(pool);
    fallback = true;
  }

  const ranked = candidates
    .map((candidate) => ({ ...candidate, active_task_count: scoreCandidate(candidate, counts) }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.active_task_count !== b.active_task_count) return a.active_task_count - b.active_task_count;
      return String(a.username || a.user_id || "").localeCompare(String(b.username || b.user_id || ""));
    });

  const primary = ranked[0] || null;
  return {
    logical_role: role,
    found: !!primary && !fallback,
    fallback,
    reason: primary ? (fallback ? "no_active_role_match_fallback_admin" : "active_role_match") : "no_route_and_no_admin_fallback",
    assignee_user_id: primary ? primary.user_id : null,
    assigned_to: primary ? primary.username : null,
    assignee: primary,
    notify_user_ids: ranked.map((row) => row.user_id).filter(Boolean),
    notify_usernames: ranked.map((row) => row.username).filter(Boolean),
    candidates: ranked,
  };
}

export default resolveActiveAssignee;
