import { getPool, setCors } from "../db.js";

const READ_ROLES = new Set(["admin", "finance", "operator"]);

function requireReadAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }
  if (!READ_ROLES.has(req.user.role)) {
    res.status(403).json({ success: false, error: "admin, finance or operator role required" });
    return false;
  }
  return true;
}

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function intValue(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function blMissing(v) {
  return String(v ?? "").trim() === "";
}

function mapOrphanBill(row) {
  const missing = blMissing(row.bl_no);
  const out = {
    bl_no: row.bl_no,
    bill_lines: intValue(row.bill_lines),
    suppliers: row.suppliers || "",
    cny_total: money(row.cny_total),
    usd_total: money(row.usd_total),
    earliest_bill_at: row.earliest_bill_at,
    blMissing: missing,
  };
  if (missing) {
    out.note = "⚠️ 连BL号都没填，没法靠BL去认领，需要人工按供应商/日期/金额去对";
  }
  return out;
}

function mapReplacement(row) {
  return {
    id: row.id,
    shipment_no: row.shipment_no,
    bl_no: row.bl_no,
    contract_nos: row.contract_nos || [],
    order_nos: row.order_nos || [],
    container_count: intValue(row.container_count),
  };
}

function mapVoidRow(row, replacements) {
  const containerCount = intValue(row.container_count);
  const suspected = replacements.some(function(rep) {
    return rep.container_count < containerCount;
  });
  return {
    id: row.id,
    shipment_no: row.shipment_no,
    bl_no: row.bl_no,
    contract_nos: row.contract_nos || [],
    order_nos: row.order_nos || [],
    container_count: containerCount,
    has_cost_lines: Boolean(row.has_cost_lines),
    replacements: replacements,
    suspectedDataLoss: suspected,
  };
}

async function fetchOrphanBills(pool) {
  const r = await pool.query(
    `SELECT fsb.bl_no,
            count(*) AS bill_lines,
            string_agg(DISTINCT fsb.supplier, '、') AS suppliers,
            sum(CASE WHEN fsb.currency='CNY' THEN fsb.amount ELSE 0 END) AS cny_total,
            sum(CASE WHEN fsb.currency='USD' THEN fsb.amount ELSE 0 END) AS usd_total,
            min(fsb.created_at) AS earliest_bill_at
       FROM freight_supplier_bills fsb
      WHERE NOT EXISTS (
        SELECT 1 FROM shipping_plans sp
         WHERE sp.deleted_at IS NULL
           AND (sp.bl_no = fsb.bl_no OR sp.mbl_no = fsb.bl_no OR sp.hbl_no = fsb.bl_no)
      )
      GROUP BY fsb.bl_no
      ORDER BY cny_total DESC NULLS LAST`
  );
  const rows = (r.rows || []).map(mapOrphanBill);
  return {
    count: rows.length,
    totalCny: money(rows.reduce(function(sum, row) { return sum + row.cny_total; }, 0)),
    totalUsd: money(rows.reduce(function(sum, row) { return sum + row.usd_total; }, 0)),
    rows: rows,
  };
}

async function fetchReplacements(pool, voidRow) {
  if (blMissing(voidRow.bl_no)) return [];
  const r = await pool.query(
    `SELECT id, shipment_no, bl_no, contract_nos, order_nos,
            jsonb_array_length(COALESCE(containers_detail,'[]'::jsonb)) AS container_count
       FROM shipping_plans
      WHERE deleted_at IS NULL
        AND id <> $1
        AND shipment_no NOT ILIKE 'VOID-%'
        AND bl_no = $2
      ORDER BY created_at DESC NULLS LAST, id DESC`,
    [voidRow.id, voidRow.bl_no]
  );
  return (r.rows || []).map(mapReplacement);
}

async function fetchVoidAnomalies(pool) {
  const r = await pool.query(
    `SELECT id, shipment_no, bl_no, contract_nos, order_nos,
            jsonb_array_length(COALESCE(containers_detail,'[]'::jsonb)) AS container_count,
            (raw->'cost_lines') IS NOT NULL AS has_cost_lines
       FROM shipping_plans
      WHERE shipment_no ILIKE 'VOID-%'
        AND containers_detail IS NOT NULL
        AND jsonb_array_length(containers_detail) > 0`
  );

  const rows = [];
  for (const row of r.rows || []) {
    const replacements = await fetchReplacements(pool, row);
    rows.push(mapVoidRow(row, replacements));
  }
  return {
    count: rows.length,
    rows: rows,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!requireReadAuth(req, res)) return;

  const pool = getPool();
  try {
    const orphanBills = await fetchOrphanBills(pool);
    const voidAnomalies = await fetchVoidAnomalies(pool);
    return res.json({
      success: true,
      orphanBills: orphanBills,
      voidAnomalies: voidAnomalies,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[shipping-data-integrity-audit] GET failed:", err);
    return res.status(500).json({ success: false, error: "shipping data integrity audit failed", detail: err.message });
  }
}
