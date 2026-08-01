import "dotenv/config";
import { getPool } from "../api/db/db.js";
import { parseVesselVoyage } from "../api/db/lib/vessel-voyage-parse.js";

function manualFlag(result) {
  return result.confidence === "high" ? "no" : "yes";
}

function cell(value) {
  return value == null || value === "" ? "" : String(value).replace(/\t/g, " ");
}

const pool = getPool();

try {
  const { rows } = await pool.query(
    `SELECT route_code
       FROM freight_rates
      WHERE route_code IS NOT NULL
        AND btrim(route_code) <> ''
      ORDER BY route_code`
  );

  const counts = { high: 0, low: 0, no_vessel: 0 };
  console.log("raw_route_code\tvessel_name\tvoyage_no\tconfidence\tmanual_required\treason");

  for (const row of rows) {
    const parsed = parseVesselVoyage(row.route_code);
    counts[parsed.confidence] += 1;
    console.log([
      cell(row.route_code),
      cell(parsed.vessel),
      cell(parsed.voyage),
      parsed.confidence,
      manualFlag(parsed),
      parsed.reason,
    ].join("\t"));
  }

  console.log("");
  console.log(`total=${rows.length}`);
  console.log(`high=${counts.high}`);
  console.log(`low=${counts.low}`);
  console.log(`no_vessel=${counts.no_vessel}`);
} finally {
  await pool.end();
}
