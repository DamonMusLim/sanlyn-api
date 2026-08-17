import { getPool } from "../api/db.js";
import { exwBillableBreakdown, findPlan, resolvePayer } from "../api/db/lib/payer-resolver.js";

const cases = [
  ["OOLU2335623260", "CNY", "CN-00040", "40-LL-7/LL-8 EXW, customer pays CNY"],
  ["OOLU2335623260", "USD", "CN-00040", "40-LL-7/LL-8 EXW, customer pays ocean"],
  ["OOLU2335623070", "CNY", "BABI", "38-LL-23 FOB, self shipper"],
  ["OOLU2335623070", "USD", "CN-00038", "38-LL-23 FOB, customer pays ocean"],
  ["COAU6460845880", "CNY", "BABI", "FOB internal order; factory is not shipper"],
  ["COAU6460845880", "USD", "CN-00048", "FOB internal order; customer pays ocean"],
  ["COAU6460310450", "CNY", "CN-00061", "no-order external shipper CN-00061"],
  ["COAU6460310450", "USD", "CN-00048", "no-order plan customer pays ocean"],
  ["COAU6460522270", "CNY", "BABI", "internal-transfer signal, CNY to BABI"],
  ["COAU6460522270", "USD", "CN-00040", "internal-transfer signal, USD to customer"],
  ["COAU6460527060", "CNY", "BABI", "internal-transfer signal, CNY to BABI"],
  ["COAU6460527060", "USD", "CN-00048", "internal-transfer signal, USD to customer"],
];

function pickLine(rows, currency) {
  const cur = currency.toUpperCase();
  const same = rows.filter(r => String(r.currency || "CNY").toUpperCase() === cur);
  if (cur === "USD") return same.find(r => /海运|ocean/i.test(String(r.cost_category || ""))) || same[0];
  return same.find(r => !/海运|ocean/i.test(String(r.cost_category || ""))) || same[0];
}

function withoutPayerLocked(row) {
  if (!row) return row;
  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? { ...row.raw } : {};
  delete raw.payer_locked;
  return { ...row, raw };
}

async function loadCase(pool, bl) {
  const plan = await findPlan(pool, { bl_no: bl });
  if (!plan) throw new Error(`missing shipping_plan for ${bl}`);
  const br = await pool.query(
    `SELECT * FROM active_freight_supplier_bills
      WHERE BTRIM(bl_no)=BTRIM($1)
         OR BTRIM(link_plan_id)=BTRIM($2)
         OR (link_plan_id ~ '^[0-9]{1,6}$' AND link_plan_id::int=$3::int)
      ORDER BY id`,
    [bl, plan._id, plan.id]);
  return { plan, bills: br.rows };
}

async function loadLockedLine(pool) {
  const br = await pool.query(
    `SELECT *
       FROM active_freight_supplier_bills
      WHERE raw->>'payer_locked'='1'
        AND NULLIF(BTRIM(COALESCE(payer_company_code, payer, '')),'') IS NOT NULL
      ORDER BY id DESC LIMIT 1`);
  if (!br.rows.length) throw new Error("missing real locked bill line");
  const row = br.rows[0];
  const plan = await findPlan(pool, row);
  if (!plan) throw new Error(`missing shipping_plan for locked line ${row.id}`);
  return { plan, row };
}

async function loadMissingTerms(pool) {
  const r = await pool.query(
    `SELECT sp.*
       FROM shipping_plans sp
       JOIN orders o ON o.shipping_plan_id=sp.id
      WHERE sp.deleted_at IS NULL
        AND o.deleted_at IS NULL
        AND NULLIF(BTRIM(COALESCE(o.trade_terms, o.freight_term, '')),'') IS NULL
      ORDER BY sp.id DESC LIMIT 1`);
  if (!r.rows.length) throw new Error("missing plan with blank order trade_terms");
  const plan = r.rows[0];
  const br = await pool.query(
    `SELECT * FROM active_freight_supplier_bills
      WHERE (BTRIM(bl_no)=BTRIM($1) OR BTRIM(link_plan_id)=BTRIM($2) OR (link_plan_id ~ '^[0-9]{1,6}$' AND link_plan_id::int=$3::int))
        AND COALESCE(currency,'CNY') IN ('CNY','RMB','')
      ORDER BY id LIMIT 1`,
    [plan.bl_no, plan._id, plan.id]);
  return { plan, row: br.rows[0] || { bl_no: plan.bl_no, currency: "CNY", cost_category: "港杂费", amount: 0 } };
}

async function checkAsk(pool) {
  await pool.query("BEGIN");
  try {
    const { plan, row } = await loadMissingTerms(pool);
    const got = await resolvePayer(pool, plan, withoutPayerLocked(row));
    const task = await pool.query("SELECT id FROM tasks WHERE id=$1 AND status='open' AND source='payer-guard'", [`terms-${row.bl_no || plan.bl_no}`]);
    const pass = got.ask?.options?.includes("EXW") && got.ask?.options?.includes("FOB") && task.rows.length === 1;
    console.log([pass ? "OK" : "FAIL", "missing-terms-ask", `basis=${got.basis || ""}`, `task=${task.rows[0]?.id || ""}`, got.ask?.question || ""].join(" | "));
    return pass;
  } finally {
    await pool.query("ROLLBACK");
  }
}

async function checkExwBreakdown(pool) {
  const { plan } = await loadCase(pool, "OOLU2335623260");
  const got = await exwBillableBreakdown(pool, plan);
  const perContainerQty = Math.max(0, ...got.per_container_items.map(r => Number(r.container_qty || 0)));
  const perContainerBillable = got.per_container_items.reduce((sum, r) => sum + Number(r.billable_amount || 0), 0);
  const trucking = got.trucking_items.reduce((sum, r) => sum + Number(r.billable_amount || r.amount || 0), 0);
  const pass = perContainerQty >= 2 && perContainerBillable > 0 && trucking >= 5600 && got.po_allocation.length > 0;
  console.log([pass ? "OK" : "FAIL", "exw-breakdown", `perContainerQty=${perContainerQty}`, `perContainerBillable=${perContainerBillable}`, `trucking=${trucking}`, `po=${got.po_allocation.map(x => `${x.po}:${x.amount}`).join(",")}`].join(" | "));
  return pass;
}

async function main() {
  const pool = getPool();
  let ok = 0;
  try {
    for (const [bl, currency, expected, reason] of cases) {
      const { plan, bills } = await loadCase(pool, bl);
      const line = withoutPayerLocked(pickLine(bills, currency));
      const got = line ? await resolvePayer(pool, plan, line) : { payer: null, reason: `missing ${currency} bill line` };
      const pass = got.payer === expected;
      if (pass) ok += 1;
      console.log([pass ? "OK" : "FAIL", bl, currency, `expected=${expected} got=${got.payer || ""}`, `basis=${got.basis || ""}`, reason].join(" | "));
    }

    const locked = await loadLockedLine(pool);
    const lockedGot = await resolvePayer(pool, locked.plan, locked.row);
    const lockedExpected = String(locked.row.payer_company_code || locked.row.payer || "").trim();
    const lockedPass = lockedGot.payer === lockedExpected && lockedGot.basis === "locked";
    console.log([lockedPass ? "OK" : "FAIL", "locked-row", `expected=${lockedExpected} got=${lockedGot.payer || ""}`, `basis=${lockedGot.basis || ""}`].join(" | "));

    const askPass = await checkAsk(pool);
    const exwPass = await checkExwBreakdown(pool);
    console.log(`summary ${ok}/${cases.length} payer cases; locked ${lockedPass ? "OK" : "FAIL"}; ask ${askPass ? "OK" : "FAIL"}; exw ${exwPass ? "OK" : "FAIL"}`);
    process.exitCode = ok === cases.length && lockedPass && askPass && exwPass ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
