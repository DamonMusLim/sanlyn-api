// GET /api/db/trucking-rates — truck/customs quotes from service_rates + trucking_routes.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.27-4";
const FEE_STATUS = Object.freeze({ RECORDED: "fee_recorded", COMPLETED: "fee_completed" });
const SERVICE_COLS = [
  "id", "service", "quote_owner_company_id", "executor_company_id", "payable_company_id",
  "issuing_company_id", "issuing_company", "factory_company_id", "factory_name",
  "pol", "pod", "container_type", "tier", "rate", "currency", "unit",
  "valid_from", "valid_to", "is_active", "source", "notes", "raw",
  "price_side", "pickup_place", "customs_port", "customs_type", "vehicle_type",
];
const COMPANY_TYPES = {
  truck: "trucking",
  customs: "customs_broker",
};

function clean(v, max = 160) {
  return String(v ?? "").trim().slice(0, max);
}

function bad(res, status, error, message) {
  return res.status(status).json({ success: false, error, message });
}

function parseRateId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function defaultBillMonth() {
  return new Date().toISOString().slice(0, 7);
}

function truthy(v, fallback = true) {
  if (v === undefined || v === null || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(v).trim().toLowerCase());
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function maybe(cols, name, expr = `s.${name}`, alias = name) {
  return cols.has(name) ? `${expr} AS ${alias}` : `NULL AS ${alias}`;
}

function serviceSelect(cols) {
  return SERVICE_COLS.map((c) => {
    if (c === "valid_from") return maybe(cols, c, "to_char(s.valid_from,'YYYY-MM-DD')");
    if (c === "valid_to") return maybe(cols, c, "to_char(s.valid_to,'YYYY-MM-DD')");
    return maybe(cols, c);
  }).join(", ");
}

function addLike(q, params, conds, key, expr) {
  const value = clean(q[key]);
  if (!value) return;
  params.push(`%${value}%`);
  conds.push(`${expr} ILIKE $${params.length}`);
}

function addExact(q, params, conds, key, expr) {
  const value = clean(q[key], 48);
  if (!value) return;
  params.push(value);
  conds.push(`${expr} = $${params.length}`);
}

function addRouteLike(q, params, conds, key, exprs) {
  const value = clean(q[key]);
  if (!value) return;
  params.push(`%${value}%`);
  conds.push(`(${exprs.map((expr) => `${expr} ILIKE $${params.length}`).join(" OR ")})`);
}

function addRouteExact(q, params, conds, key, expr) {
  const value = clean(q[key], 48);
  if (!value) return;
  params.push(value);
  conds.push(`${expr} = $${params.length}`);
}

function filters(q, cols, service) {
  const params = [service];
  const conds = ["s.service = $1"];
  if (truthy(q.active_only, false) && cols.has("is_active")) {
    conds.push("s.is_active IS TRUE");
    if (cols.has("valid_to")) conds.push("(s.valid_to IS NULL OR s.valid_to >= CURRENT_DATE)");
  }
  if (cols.has("price_side")) addExact(q, params, conds, "price_side", "s.price_side");
  if (service === "truck") {
    if (cols.has("pickup_place")) addLike(q, params, conds, "pickup_place", "s.pickup_place");
    if (cols.has("pol")) addLike(q, params, conds, "pol", "s.pol");
    if (cols.has("container_type")) addExact(q, params, conds, "container_type", "s.container_type");
    if (cols.has("tier")) addExact(q, params, conds, "tier", "s.tier");
  } else {
    if (cols.has("customs_port")) addLike(q, params, conds, "customs_port", "s.customs_port");
    else if (cols.has("pol")) addLike(q, params, conds, "customs_port", "s.pol");
    if (cols.has("customs_type")) addLike(q, params, conds, "customs_type", "s.customs_type");
    if (cols.has("unit")) addExact(q, params, conds, "unit", "s.unit");
  }
  return { params, where: conds.join(" AND ") };
}

async function partners(pool, type) {
  const r = await pool.query(
    `SELECT id, code, COALESCE(NULLIF(name_cn,''), NULLIF(name_en,''), code) AS name
       FROM companies
      WHERE type = $1
      ORDER BY name`,
    [type]
  );
  return r.rows;
}

async function rates(pool, q, service, cols) {
  const built = filters(q, cols, service);
  const pickupOrder = cols.has("pickup_place") ? "s.pickup_place" : "s.factory_name";
  const vehicleOrder = cols.has("vehicle_type") ? "s.vehicle_type NULLS LAST," : "";
  const r = await pool.query(
    `SELECT ${serviceSelect(cols)},
            'service_rates' AS rate_source,
            NULL AS route_id,
            NULL AS pickup_city,
            NULL AS pol_terminal,
            NULL::numeric AS distance_km,
            NULL::boolean AS tax_included,
            FALSE AS pending_confirm,
            c.id AS company_id,
            c.code AS company_code,
            COALESCE(NULLIF(c.name_cn,''), NULLIF(c.name_en,''), c.code) AS company_name
       FROM service_rates s
       LEFT JOIN companies c ON c.id = s.executor_company_id
      WHERE ${built.where}
      ORDER BY COALESCE(${pickupOrder}, ''), s.pol NULLS LAST,
               s.container_type NULLS LAST, s.tier NULLS LAST,
               ${vehicleOrder} COALESCE(c.name_cn, c.name_en, c.code, ''), s.rate NULLS LAST`,
    built.params
  );
  return r.rows;
}

function routeFilters(q) {
  const params = [];
  const conds = ["tr.rates IS NOT NULL", "jsonb_typeof(tr.rates) = 'object'"];
  if (truthy(q.active_only, false)) conds.push("(tr.valid_to IS NULL OR tr.valid_to >= CURRENT_DATE)");
  addRouteLike(q, params, conds, "pickup_place", ["tr.factory_name", "tr.pickup_city"]);
  addRouteLike(q, params, conds, "pol", ["tr.pol"]);
  addRouteExact(q, params, conds, "container_type", "split_part(rate_item.key, '-', 1)");
  addRouteExact(q, params, conds, "tier", "substring(rate_item.key from '^[^-]+-(.*)$')");
  addRouteExact(q, params, conds, "price_side", "'cost'");
  return { params, where: conds.join(" AND ") };
}

async function truckingRoutes(pool, q, routeCols) {
  if (!routeCols.size) return [];
  const built = routeFilters(q);
  const r = await pool.query(
    `SELECT
            NULL::integer AS id,
            'truck' AS service,
            NULL::integer AS quote_owner_company_id,
            tr.vendor_id AS executor_company_id,
            tr.vendor_id AS payable_company_id,
            NULL::integer AS issuing_company_id,
            NULL AS issuing_company,
            tr.factory_company_id,
            tr.factory_name,
            tr.pol,
            NULL AS pod,
            split_part(rate_item.key, '-', 1) AS container_type,
            substring(rate_item.key from '^[^-]+-(.*)$') AS tier,
            CASE
              WHEN jsonb_typeof(rate_item.value) = 'object'
               AND COALESCE(rate_item.value->>'cost', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (rate_item.value->>'cost')::numeric
              WHEN jsonb_typeof(rate_item.value) = 'number'
                THEN (rate_item.value #>> '{}')::numeric
              ELSE NULL::numeric
            END AS rate,
            COALESCE(tv.currency, 'CNY') AS currency,
            'per_container' AS unit,
            to_char(tr.valid_from,'YYYY-MM-DD') AS valid_from,
            to_char(tr.valid_to,'YYYY-MM-DD') AS valid_to,
            TRUE AS is_active,
            'trucking_routes' AS source,
            tr.notes,
            NULL::jsonb AS raw,
            'cost' AS price_side,
            COALESCE(NULLIF(tr.factory_name,''), NULLIF(tr.pickup_city,'')) AS pickup_place,
            NULL AS customs_port,
            NULL AS customs_type,
            NULL AS vehicle_type,
            'trucking_routes' AS rate_source,
            tr._id AS route_id,
            tr.pickup_city,
            tr.pol_terminal,
            tr.distance_km,
            tr.tax_included,
            (tr.valid_from IS NULL AND tr.valid_to IS NULL)
              OR COALESCE(tr.notes, '') ~ '(待确认|参考|口述)' AS pending_confirm,
            NULL::integer AS company_id,
            NULL AS company_code,
            COALESCE(NULLIF(tv.vendor_cn,''), '未绑定承运商') AS company_name
       FROM trucking_routes tr
       LEFT JOIN trucking_vendors tv ON tv._id = tr.vendor_id
       CROSS JOIN LATERAL jsonb_each(tr.rates) AS rate_item(key, value)
      WHERE ${built.where}
      ORDER BY COALESCE(tr.factory_name, tr.pickup_city, ''), tr.pol NULLS LAST,
               split_part(rate_item.key, '-', 1), substring(rate_item.key from '^[^-]+-(.*)$'),
               COALESCE(tv.vendor_cn, ''), rate`,
    built.params
  );
  return r.rows;
}

async function truckingCoverage(pool, routeCols) {
  const routeCount = routeCols.size
    ? Number((await pool.query("SELECT COUNT(*)::int AS n FROM trucking_routes")).rows[0]?.n || 0)
    : 0;
  const sp = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(factory_company_id)::int AS with_factory_company_id
       FROM shipping_plans`
  );
  return {
    trucking_route_count: routeCount,
    shipping_plan_count: Number(sp.rows[0]?.total || 0),
    shipping_plan_factory_company_id_count: Number(sp.rows[0]?.with_factory_company_id || 0),
  };
}

function mergeRows(serviceRows, routeRows, service) {
  if (service !== "truck") return serviceRows;
  return serviceRows.concat(routeRows);
}

function partnerKey(row) {
  return row.company_id || row.company_name || row.executor_company_id || null;
}

function quotedRateRows(rows) {
  return rows.filter((row) => row.source !== "derived_from_bills");
}

async function adoptRate(req, res) {
  const body = req.body || {};
  const rateId = parseRateId(body.rate_id || body.service_rate_id);
  const blNo = clean(body.bl_no, 80);
  const linkPlanId = clean(body.link_plan_id, 80);
  const billMonth = clean(body.bill_month, 16) || defaultBillMonth();

  if (!rateId) return bad(res, 400, "missing_rate_id", "rate_id required");
  if (!blNo || !linkPlanId) {
    return bad(res, 400, "missing_shipment_context", "bl_no and link_plan_id required");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const rateResult = await client.query(
      `
        SELECT
          s.id, s.service, s.executor_company_id, s.rate, s.currency,
          c.code AS supplier_company_code,
          COALESCE(NULLIF(c.name_cn,''), NULLIF(c.name_en,''), c.code) AS supplier
        FROM service_rates s
        LEFT JOIN companies c ON c.id = s.executor_company_id
        WHERE s.id = $1 AND s.service IN ('truck', 'customs')
        FOR SHARE
      `,
      [rateId]
    );

    if (!rateResult.rows.length) {
      await client.query("ROLLBACK");
      return bad(res, 404, "rate_not_found", "service rate not found");
    }

    const rate = rateResult.rows[0];
    if (!rate.executor_company_id || !rate.supplier) {
      await client.query("ROLLBACK");
      return bad(res, 422, "rate_missing_executor", "该报价未绑定承运商，无法生成费用行");
    }

    const amount = Number(rate.rate);
    if (!Number.isFinite(amount)) {
      await client.query("ROLLBACK");
      return bad(res, 422, "rate_missing_amount", "service rate amount is missing");
    }

    const costCategory = rate.service === "customs" ? "报关费" : "拖车费";
    const dupResult = await client.query(
      `
        SELECT id
        FROM freight_supplier_bills
        WHERE COALESCE(bl_no, '') = $1
          AND cost_category = $2
          AND supplier = $3
          AND COALESCE(rebill_status, '') <> 'voided'
        LIMIT 1
      `,
      [blNo, costCategory, rate.supplier]
    );

    if (dupResult.rows.length) {
      await client.query("ROLLBACK");
      return bad(
        res,
        409,
        "freight_bill_exists",
        `同一 bl_no/cost_category/supplier 已存在费用行：${blNo} / ${costCategory} / ${rate.supplier}`
      );
    }

    const inserted = await client.query(
      `
        INSERT INTO freight_supplier_bills (
          supplier,
          supplier_company_code,
          bl_no,
          link_plan_id,
          cost_category,
          amount,
          currency,
          bill_month,
          fee_status,
          sale_amount
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
        RETURNING id, supplier, supplier_company_code, bl_no, link_plan_id,
                  cost_category, amount, currency, bill_month, fee_status, sale_amount
      `,
      [
        rate.supplier,
        rate.supplier_company_code,
        blNo,
        linkPlanId,
        costCategory,
        amount,
        rate.currency,
        billMonth,
        FEE_STATUS.RECORDED,
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      bill: inserted.rows[0],
      bill_id: inserted.rows[0].id,
      ocean_url: `/ocean?q=${encodeURIComponent(blNo)}`,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[trucking-rates:adopt]", err);
    return bad(res, 500, "adopt_failed", err.message);
  } finally {
    client.release();
  }
}

function summarize(rows, partnerCount, service) {
  if (service === "customs" && rows.length === 0) {
    return "未接入：报关报价尚无数据，需先录入";
  }
  const quoted = new Set(quotedRateRows(rows).map(partnerKey).filter(Boolean)).size;
  if (partnerCount && quoted < partnerCount) return `未接入：该线路仅 ${quoted} 家有报价`;
  return rows.length ? "ready" : "未接入：该线路仅 0 家有报价";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ success: false, error: "GET/POST required" });
  if (!requireAuth(req, res)) return;
  if (req.method === "POST") return adoptRate(req, res);
  try {
    const service = clean(req.query.service || "truck", 16) === "customs" ? "customs" : "truck";
    const pool = getPool();
    const cols = await tableColumns(pool, "service_rates");
    const routeCols = await tableColumns(pool, "trucking_routes");
    const partnerRows = await partners(pool, COMPANY_TYPES[service]);
    const serviceRows = await rates(pool, req.query || {}, service, cols);
    const routeRows = service === "truck" ? await truckingRoutes(pool, req.query || {}, routeCols) : [];
    const rateRows = mergeRows(serviceRows, routeRows, service);
    const routeCoverage = service === "truck" ? await truckingCoverage(pool, routeCols) : null;
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      service,
      source: { tables: service === "truck" ? ["service_rates", "trucking_routes"] : ["service_rates"], service_value: service },
      partners: partnerRows,
      rows: rateRows,
      state: rateRows.length ? "ready" : "not_connected",
      message: summarize(rateRows, partnerRows.length, service),
      coverage: { partner_count: partnerRows.length, quoted_partner_count: new Set(quotedRateRows(rateRows).map(partnerKey).filter(Boolean)).size },
      trucking_context: routeCoverage,
    });
  } catch (err) {
    console.error("[trucking-rates]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
