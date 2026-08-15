import { existsSync, readFileSync } from "fs";
import { getPool } from "../api/db.js";
import { resolvePerson } from "../api/db/authz.js";

function loadEnv() {
  const file = existsSync(".env") ? ".env" : "/home/damon/.env";
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function capList(resolved) {
  return resolved.caps.map((cap) => {
    const from = (resolved.source.caps[cap] || []).map((x) => {
      const limit = x.constraints?.amount ? ` <=${x.constraints.amount}${x.constraints.currency || ""}` : "";
      return `${x.hat_code}${limit}`;
    }).join("+");
    return `${cap}(来自${from})`;
  });
}

function printPerson(label, resolved) {
  if (!resolved) {
    console.log(`${label}:  无法映射`);
    return;
  }
  console.log(`${label}:  person_id=${resolved.person_id} hats=[${resolved.hats.join(", ")}] caps=[${capList(resolved).join(", ")}]`);
}

function hasCap(resolved, cap) {
  return !!resolved?.caps?.includes(cap);
}

function hasAnyApproveOrDecide(resolved) {
  return (resolved?.caps || []).some((cap) => /\.approve$|\.decide$/.test(cap));
}

async function resolveByCandidates(pool, candidates) {
  return resolvePerson({ method: "SELF_CHECK", path: "/scripts/authz-self-check" }, { pool, candidates, audit: false });
}

async function main() {
  loadEnv();
  const pool = getPool();
  try {
    const damonBackend = await resolveByCandidates(pool, [
      { source_system: "backend", identity_type: "username", identity_key: "damon_sl", label: "damon_sl" },
    ]);
    const damonClerk = await resolveByCandidates(pool, [
      { source_system: "clerk", identity_type: "session_user", identity_key: "35", label: "hr employee session 35" },
    ]);
    const test999 = await resolveByCandidates(pool, [
      { source_system: "hr", identity_type: "employee_id", identity_key: "39", label: "TEST999 employee 39" },
    ]);
    const wangRow = (await pool.query(
      "SELECT person_id, source_hr_employee_id FROM people WHERE display_name = $1 LIMIT 1",
      ["汪卫云"]
    )).rows[0];
    const wang = wangRow ? await resolveByCandidates(pool, [
      { source_system: "hr", identity_type: "employee_id", identity_key: String(wangRow.source_hr_employee_id), label: "汪卫云 hr employee" },
    ]) : null;
    const managerOnlyRow = (await pool.query(
      `SELECT p.person_id, p.display_name, p.source_hr_employee_id
         FROM people p
         JOIN person_hats ph ON ph.person_id = p.person_id AND ph.hat_code = 'store_manager'
          AND ph.valid_until IS NULL
    LEFT JOIN person_hats ceo ON ceo.person_id = p.person_id AND ceo.hat_code = 'ceo'
          AND ceo.valid_until IS NULL
        WHERE ceo.person_hat_id IS NULL
        ORDER BY p.person_id
        LIMIT 1`
    )).rows[0];
    const managerOnly = managerOnlyRow ? await resolveByCandidates(pool, [
      { source_system: "hr", identity_type: "employee_id", identity_key: String(managerOnlyRow.source_hr_employee_id), label: "store manager only" },
    ]) : null;
    const unmappedAccounts = (await pool.query(
      `SELECT a.id, a.username, a.role
         FROM accounts a
    LEFT JOIN person_identities iu ON iu.source_system='backend'
          AND iu.identity_type='username'
          AND lower(iu.identity_key)=lower(a.username)
          AND iu.is_active
    LEFT JOIN person_identities ii ON ii.source_system='backend'
          AND ii.identity_type='user_id'
          AND ii.identity_key=a.id::text
          AND ii.is_active
        WHERE COALESCE(a.is_active, true)
          AND iu.identity_id IS NULL
          AND ii.identity_id IS NULL
        ORDER BY a.username
        LIMIT 200`
    )).rows;

    printPerson("Damon(后台 damon_sl)", damonBackend);
    printPerson("Damon(clerk/session employee_id=35)", damonClerk);
    printPerson("汪卫云", wang);
    printPerson("TEST999", test999);
    printPerson(`只戴 store_manager${managerOnlyRow ? `(${managerOnlyRow.display_name})` : ""}`, managerOnly);
    console.log(`无法映射的账号: ${JSON.stringify(unmappedAccounts)}`);

    const checks = [
      ["Damon 后台账号和 clerk 会话解析到同一个 person_id", damonBackend?.person_id && damonBackend.person_id === damonClerk?.person_id],
      ["Damon 同时拥有 ceo + store_manager", damonBackend?.hats?.includes("ceo") && damonBackend?.hats?.includes("store_manager")],
      ["Damon 有 price.decide 且来源含 ceo", hasCap(damonBackend, "price.decide") && (damonBackend.source.caps["price.decide"] || []).some((x) => x.hat_code === "ceo")],
      ["只戴 store_manager 的人没有 price.decide", managerOnly ? !hasCap(managerOnly, "price.decide") : false],
      ["TEST999 没有任何 approve/decide 能力", test999 ? !hasAnyApproveOrDecide(test999) : false],
      ["无法映射的账号被列出来", Array.isArray(unmappedAccounts)],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
