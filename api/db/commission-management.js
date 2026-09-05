// 补提成管理 · no-data guard. Never invents commission rules or rates.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.27-1";
const READ_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const WRITE_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const REASON = "提成规则尚未配置，需先定义提成基数与比例";
const FIELDS = [
  ["commission_base", "提成基数"],
  ["commission_rate", "提成比例"],
  ["commission_rule", "提成规则"],
  ["commission_payable", "应提金额"],
  ["commission_owner", "提成对象"],
];
const TABLE_PATTERNS = [
  "%commission%", "%提成%", "%sales_bonus%", "%bonus_rule%",
  "%incentive%", "%payable_commission%",
];
const COLUMN_PATTERNS = ["%commission%", "%提成%", "%sales_bonus%", "%bonus%"];
const WRITE_TABLES = ["commission_rules", "commission_payables"];

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra });
}

function noDataPayload(extra = {}) {
  return {
    success: true,
    version: VERSION,
    generated_at: new Date().toISOString(),
    state: "no_data",
    reason: REASON,
    data: [],
    selected: null,
    metrics: {
      reseller_count: null,
      paid_order_count: null,
      alert_count: null,
      by_currency: [],
    },
    facets: {
      owners: [],
      currencies: [],
      months: [],
      states: ["no_data"],
    },
    coverage: {
      tables: [],
      fields: FIELDS.map(([name, label]) => ({
        table: "commission_rules",
        name,
        label,
        state: "not_connected",
        filled: 0,
        total: 0,
        fill_rate: null,
        reason: REASON,
      })),
    },
    missing_tables: ["commission_rules", "commission_payables"],
    missing_reason: REASON,
    page_hint: "未接入：缺提成基数与比例配置。",
    ...extra,
  };
}

async function discoverCommissionSources(pool) {
  const tables = await pool.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND (${TABLE_PATTERNS.map((_, i) => `table_name ILIKE $${i + 1}`).join(" OR ")})
      ORDER BY table_name`,
    TABLE_PATTERNS
  );
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (${COLUMN_PATTERNS.map((_, i) => `column_name ILIKE $${i + 1}`).join(" OR ")})
      ORDER BY table_name, column_name`,
    COLUMN_PATTERNS
  );
  return {
    tables: tables.rows,
    columns: columns.rows,
  };
}

async function writeUnavailable(pool, req) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = String(req?.body?.id || req?.query?.id || "").trim();
    for (const table of WRITE_TABLES) {
      const exists = await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
      if (exists.rows[0]?.name && id) {
        await client.query(`SELECT * FROM ${table} WHERE id::text=$1 FOR UPDATE`, [id]);
        break;
      }
    }
    throw new Error(REASON);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");

  const pool = getPool();
  if (req.method !== "GET") {
    if (!WRITE_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
    try {
      await writeUnavailable(pool, req);
    } catch (err) {
      return fail(res, 409, err.message, { state: "no_data", version: VERSION });
    }
  }

  try {
    const discovered = await discoverCommissionSources(pool);
    return res.status(200).json(noDataPayload({ discovered_sources: discovered }));
  } catch (err) {
    console.error("[commission-management]", err);
    return fail(res, 500, err.message);
  }
}
