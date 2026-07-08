import "dotenv/config";
import { getPool } from "../api/db.js";

const thresholdKg = Number(process.argv[2] || 1);

const SQL = `
WITH cb AS (
  SELECT
    cb.id,
    cb.shipping_plan_id,
    cb.bl_no,
    cb.container_no,
    cb.contract_no,
    NULLIF(cb.cargo_weight_kg, 0)::numeric AS measured_gw_kg
  FROM container_bookings cb
  WHERE cb.container_no IS NOT NULL
    AND NULLIF(cb.cargo_weight_kg, 0) IS NOT NULL
),
oli AS (
  SELECT
    cb.id AS container_booking_id,
    SUM(COALESCE(li.gw_ctn, p.gross_weight, 0)::numeric * COALESCE(li.qty_ctn, 0)::numeric) AS oli_gw_kg
  FROM cb
  LEFT JOIN orders o
    ON (o.order_no = cb.contract_no OR o.contract_no = cb.contract_no)
   AND (cb.bl_no IS NULL OR o.bl_no = cb.bl_no)
  LEFT JOIN order_line_items li ON li.order_id = o.id
  LEFT JOIN products p ON p.id = li.product_id
  GROUP BY cb.id
)
SELECT
  COALESCE(sp._id, sp.id::text) AS plan_id,
  cb.bl_no,
  cb.container_no,
  cb.contract_no,
  ROUND(cb.measured_gw_kg, 3) AS measured_gw_kg,
  ROUND(COALESCE(oli.oli_gw_kg, 0), 3) AS oli_gw_kg,
  ROUND(cb.measured_gw_kg - COALESCE(oli.oli_gw_kg, 0), 3) AS diff_kg
FROM cb
LEFT JOIN shipping_plans sp ON sp.id = cb.shipping_plan_id
LEFT JOIN oli ON oli.container_booking_id = cb.id
WHERE ABS(cb.measured_gw_kg - COALESCE(oli.oli_gw_kg, 0)) > $1
ORDER BY ABS(cb.measured_gw_kg - COALESCE(oli.oli_gw_kg, 0)) DESC, cb.bl_no, cb.container_no;
`;

function printTable(rows) {
  const headers = ["plan_id", "bl_no", "container_no", "contract_no", "measured_gw_kg", "oli_gw_kg", "diff_kg"];
  console.log(headers.join("\t"));
  for (const row of rows) {
    console.log(headers.map((key) => row[key] ?? "").join("\t"));
  }
}

async function main() {
  const pool = getPool();
  try {
    const { rows } = await pool.query(SQL, [thresholdKg]);
    const plans = new Set(rows.map((row) => row.plan_id).filter(Boolean));
    const containers = new Set(rows.map((row) => row.container_no).filter(Boolean));

    console.log(`threshold_kg=${thresholdKg}`);
    console.log(`mismatch_plans=${plans.size}`);
    console.log(`mismatch_containers=${containers.size}`);
    console.log(`mismatch_rows=${rows.length}`);
    printTable(rows);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
