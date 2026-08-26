// GET/PATCH /api/db/order-staff-slots — 订单8个人员角色槽，对接 ai_staff 花名册
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const INTERNAL_ROLES = new Set(["admin", "logistics", "sales", "operator", "superadmin", "ceo"]);
const SLOT_ROLES = [
  ["sales_owner", "业务负责人"],
  ["merchandiser", "跟单负责人"],
  ["booking_owner", "订舱负责人"],
  ["customs_owner", "报关负责人"],
  ["document_owner", "单证负责人"],
  ["trucking_owner", "拖车负责人"],
  ["finance_owner", "财务负责人"],
  ["qc_owner", "验货负责人"],
];

function clean(v, max = 160) { return String(v ?? "").trim().slice(0, max); }
function isInternal(req) { return req.user && INTERNAL_ROLES.has(req.user.role); }
function actor(req) {
  const u = req.user || {};
  return clean(u.username || u.name || u.email || u.uid || u.sub || "unknown", 120);
}
async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", ["public." + table]);
  return Boolean(r.rows[0]?.name);
}
async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
function coverageText(filled, total) {
  if (!total) return "未接入";
  return `样本 ${total} 行，已填 ${filled || 0} 行`;
}
function nameExpr(alias) {
  return `COALESCE(to_jsonb(${alias})->>'name_cn',to_jsonb(${alias})->>'name',to_jsonb(${alias})->>'name_en')`;
}
function slotReady(cols) {
  return cols.has("order_id") && cols.has("role_key") && cols.has("staff_no");
}
function activePredicate(alias, cols) {
  if (cols.has("is_active")) return `COALESCE(${alias}.is_active,true) IS TRUE`;
  if (cols.has("status")) return `COALESCE(${alias}.status,'active') NOT IN ('inactive','left','disabled')`;
  return "TRUE";
}

async function loadOrder(pool, q) {
  const orderId = clean(q.order_id || q.id, 40);
  const orderNo = clean(q.order_no || q.orderNo, 80);
  if (!orderId && !orderNo) return { error: "order_id or order_no required" };
  const conds = [];
  const vals = [];
  if (orderId) { vals.push(orderId); conds.push(`id::text=$${vals.length}`); }
  if (orderNo) {
    vals.push(orderNo);
    conds.push(`(order_no=$${vals.length} OR contract_no=$${vals.length} OR customer_po=$${vals.length})`);
  }
  const r = await pool.query(
    `SELECT id, order_no, contract_no, customer_po, status,
            COALESCE(NULLIF(company_name_en,''),NULLIF(company_name_cn,''),NULLIF(customer,''),company_code) AS customer
       FROM orders
      WHERE deleted_at IS NULL AND (${conds.join(" OR ")})
      ORDER BY id DESC LIMIT 1`,
    vals
  );
  return r.rows[0] || null;
}

async function loadRoster(pool, staffOk, staffCols) {
  if (!staffOk || !staffCols.has("staff_no")) return [];
  const r = await pool.query(
    `SELECT staff_no, ${nameExpr("ai_staff")} AS name,
            ${staffCols.has("domain") ? "domain" : "NULL::text AS domain"},
            ${staffCols.has("duty") ? "duty" : "NULL::text AS duty"},
            ${staffCols.has("status") ? "status" : "NULL::text AS status"}
       FROM ai_staff
      WHERE ${activePredicate("ai_staff", staffCols)}
      ORDER BY ${staffCols.has("seat_no") ? "seat_no NULLS LAST," : ""} staff_no
      LIMIT 300`
  );
  return r.rows;
}

async function loadCoverage(pool, slotOk, slotCols) {
  const totalQ = await pool.query("SELECT COUNT(*)::int AS total FROM orders WHERE deleted_at IS NULL");
  const total = Number(totalQ.rows[0]?.total || 0);
  const counts = new Map();
  if (slotOk) {
    const r = await pool.query(
      `SELECT role_key, COUNT(DISTINCT order_id)::int AS filled
         FROM order_staff_slots
        WHERE NULLIF(BTRIM(staff_no),'') IS NOT NULL
          AND ${activePredicate("order_staff_slots", slotCols)}
        GROUP BY role_key`
    );
    r.rows.forEach((x) => counts.set(clean(x.role_key, 60), Number(x.filled || 0)));
  }
  return { total, counts };
}

function buildEmptySlots(coverage, missing) {
  return SLOT_ROLES.map(([key, label]) => {
    const filled = coverage.counts.get(key) || 0;
    return {
      role_key: key,
      label,
      state: "no_data",
      staff_no: "",
      staff_name: "",
      missing_fields: missing,
      fill_rate: coverageText(filled, coverage.total),
    };
  });
}

async function loadSlots(pool, order, slotOk, slotCols, staffOk, staffCols, coverage) {
  const missing = [];
  if (!slotOk) missing.push("order_staff_slots.order_id/role_key/staff_no");
  if (!staffOk || !staffCols.has("staff_no")) missing.push("ai_staff.staff_no");
  if (!slotOk || !order) return buildEmptySlots(coverage, missing);
  const joined = staffOk && staffCols.has("staff_no");
  const r = await pool.query(
    `SELECT s.role_key, s.staff_no,
            ${joined ? nameExpr("a") : "NULL::text"} AS staff_name,
            ${slotCols.has("note") ? "s.note" : "NULL::text AS note"},
            ${slotCols.has("updated_at") ? "to_char(s.updated_at,'YYYY-MM-DD HH24:MI')" : "NULL::text"} AS updated_at
       FROM order_staff_slots s
       ${joined ? "LEFT JOIN ai_staff a ON a.staff_no=s.staff_no" : ""}
      WHERE s.order_id=$1 AND ${activePredicate("s", slotCols)}`,
    [String(order.id)]
  );
  const byRole = new Map(r.rows.map((x) => [x.role_key, x]));
  return SLOT_ROLES.map(([key, label]) => {
    const row = byRole.get(key);
    const filled = coverage.counts.get(key) || 0;
    if (!row || !clean(row.staff_no)) {
      return {
        role_key: key, label, state: "no_data", staff_no: "", staff_name: "",
        missing_fields: ["order_staff_slots.staff_no", "ai_staff.staff_no"],
        fill_rate: coverageText(filled, coverage.total),
      };
    }
    return {
      role_key: key, label, state: "assigned",
      staff_no: row.staff_no, staff_name: row.staff_name || "",
      note: row.note || "", updated_at: row.updated_at || "",
      source_fields: ["order_staff_slots.staff_no", "ai_staff.staff_no"],
      fill_rate: coverageText(filled, coverage.total),
    };
  });
}

async function validateStaff(pool, staffCols, staffNos) {
  const vals = [...new Set(staffNos.map((x) => clean(x, 80)).filter(Boolean))];
  if (!vals.length) return;
  if (!staffCols.has("staff_no")) throw Object.assign(new Error("未接入: 缺 ai_staff.staff_no"), { status: 409 });
  const r = await pool.query(
    `SELECT staff_no FROM ai_staff WHERE staff_no = ANY($1::text[]) AND ${activePredicate("ai_staff", staffCols)}`,
    [vals]
  );
  const ok = new Set(r.rows.map((x) => x.staff_no));
  const bad = vals.filter((x) => !ok.has(x));
  if (bad.length) throw Object.assign(new Error("人员不在 ai_staff 有效花名册: " + bad.join(",")), { status: 400 });
}

async function patchSlots(req, pool, body, slotCols, staffCols) {
  if (!isInternal(req)) throw Object.assign(new Error("Forbidden: internal only"), { status: 403 });
  if (!slotReady(slotCols)) throw Object.assign(new Error("未接入: 缺 order_staff_slots.order_id/role_key/staff_no"), { status: 409 });
  if (!slotCols.has("updated_at") || !slotCols.has("updated_by") || !slotCols.has("is_active")) {
    throw Object.assign(new Error("未接入: 缺 order_staff_slots.updated_at/updated_by/is_active"), { status: 409 });
  }
  const order = await loadOrder(pool, body || {});
  if (!order) throw Object.assign(new Error("order not found"), { status: 404 });
  const slots = body.slots && typeof body.slots === "object" ? body.slots : {};
  const allowed = new Map(SLOT_ROLES);
  const entries = Object.entries(slots).filter(([k]) => allowed.has(k));
  await validateStaff(pool, staffCols, entries.map(([, v]) => v));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [roleKey, staffNoRaw] of entries) {
      const staffNo = clean(staffNoRaw, 80);
      if (!staffNo) {
        await client.query(
          `UPDATE order_staff_slots SET is_active=false, updated_at=now(), updated_by=$1
            WHERE order_id=$2 AND role_key=$3`,
          [actor(req), String(order.id), roleKey]
        );
      } else {
        await client.query(
          `INSERT INTO order_staff_slots(order_id,role_key,staff_no,is_active,updated_by)
           VALUES($1,$2,$3,true,$4)
           ON CONFLICT(order_id,role_key)
           DO UPDATE SET staff_no=EXCLUDED.staff_no,is_active=true,updated_at=now(),updated_by=EXCLUDED.updated_by`,
          [String(order.id), roleKey, staffNo, actor(req)]
        );
      }
    }
    await client.query("COMMIT");
    return order;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  try {
    const staffOk = await tableExists(pool, "ai_staff");
    const slotOkTable = await tableExists(pool, "order_staff_slots");
    const staffCols = staffOk ? await tableColumns(pool, "ai_staff") : new Set();
    const slotCols = slotOkTable ? await tableColumns(pool, "order_staff_slots") : new Set();
    if (req.method === "PATCH") await patchSlots(req, pool, req.body || {}, slotCols, staffCols);
    if (req.method !== "GET" && req.method !== "PATCH") {
      return res.status(405).json({ success: false, error: "GET/PATCH required" });
    }
    const order = await loadOrder(pool, req.method === "PATCH" ? req.body || {} : req.query || {});
    const slotOk = slotOkTable && slotReady(slotCols);
    const coverage = await loadCoverage(pool, slotOk, slotCols);
    const slots = await loadSlots(pool, order, slotOk, slotCols, staffOk, staffCols, coverage);
    return res.status(200).json({
      success: true,
      order,
      slots,
      roster: await loadRoster(pool, staffOk, staffCols),
      roster_status: staffOk && staffCols.has("staff_no") ? "connected" : "no_data",
      missing_fields: [
        ...(slotOk ? [] : ["order_staff_slots.order_id/role_key/staff_no"]),
        ...(staffOk && staffCols.has("staff_no") ? [] : ["ai_staff.staff_no"]),
      ],
    });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.message });
  }
}
