import { getPool } from "../db.js";

const TEXT_ARRAY_FIELDS = ["service_regions", "advantage_carriers", "cooperating_carriers", "carriers", "rank_lists"];
const SKIPPED_PAYLOAD_FIELDS = new Set([
  "goldFlag",
  "userFlag",
  "compositeFlag",
  "potentialFlag",
  "specialFlag",
  "weight",
]);

function setSyncCors(req, res, methods = "GET, POST, OPTIONS") {
  const origin = req.headers.origin || "";
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Sync-Key");
}

function isoDate(value) {
  const m = String(value || "").match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : new Date().toISOString().slice(0, 10);
}

function textOrNull(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function textArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((x) => String(x || "").trim()).filter(Boolean))];
}

function cleanRawPayload(obj) {
  const out = { ...(obj || {}) };
  for (const field of SKIPPED_PAYLOAD_FIELDS) delete out[field];
  return out;
}

function normalizeRow(row, capturedOn) {
  const out = {
    captured_on: capturedOn,
    port_name: textOrNull(row.port_name),
    port_token: textOrNull(row.port_token),
    location_code: textOrNull(row.location_code),
    location_cn_name: textOrNull(row.location_cn_name),
    company_name: textOrNull(row.company_name),
    supplier_id: intOrNull(row.supplier_id),
    supplier_code: textOrNull(row.supplier_code),
    contact_id: intOrNull(row.contact_id),
    like_count: intOrNull(row.like_count),
    weiyuntong_flag: intOrNull(row.weiyuntong_flag),
    service_regions: textArray(row.service_regions),
    advantage_carriers: textArray(row.advantage_carriers),
    cooperating_carriers: textArray(row.cooperating_carriers),
    carriers: textArray(row.carriers),
    intro: textOrNull(row.intro),
    intro_carriers_raw: textOrNull(row.intro_carriers_raw),
    intro_lanes_raw: textOrNull(row.intro_lanes_raw),
    contact_name: textOrNull(row.contact_name),
    phone: textOrNull(row.phone),
    phone_number: textOrNull(row.phone_number),
    contacts_number: textOrNull(row.contacts_number),
    phone_masked: textOrNull(row.phone_masked),
    cooperation_date: textOrNull(row.cooperation_date),
    coop_years: intOrNull(row.coop_years),
    verified: boolOrNull(row.verified),
    certified: boolOrNull(row.certified),
    rank_lists: textArray(row.rank_lists),
    source_url: textOrNull(row.source_url),
    raw: cleanRawPayload(row.raw && typeof row.raw === "object" ? row.raw : row),
    data_domain: "freight",
  };
  if (!out.company_name) return null;
  return out;
}

async function lanePorts(pool) {
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'market_sailing_lanes'`
  );
  const cols = new Set(colRes.rows.map((r) => r.column_name));
  const candidates = ["pol_name_cn", "pol_cn", "origin_port_cn", "port_name", "pol", "origin_port"];
  const selected = candidates.filter((c) => cols.has(c));
  if (selected.length === 0) return [];
  const expr = selected.map((c) => `NULLIF(btrim(${c}::text),'')`).join(", ");
  const sql = `SELECT DISTINCT COALESCE(${expr}) AS name_cn
               FROM market_sailing_lanes
               WHERE COALESCE(${expr}) IS NOT NULL
               ORDER BY 1`;
  return (await pool.query(sql)).rows;
}

async function upsertRows(pool, rows) {
  const fields = [
    "captured_on", "port_name", "port_token", "location_code", "location_cn_name", "company_name", "supplier_id",
    "supplier_code", "contact_id",
    "like_count", "weiyuntong_flag", "service_regions", "advantage_carriers",
    "cooperating_carriers", "carriers", "intro", "contact_name",
    "intro_carriers_raw", "intro_lanes_raw", "phone", "phone_number",
    "contacts_number", "phone_masked", "cooperation_date",
    "coop_years", "verified", "certified", "rank_lists", "source_url", "raw",
    "data_domain",
  ];
  const updates = fields
    .filter((f) => !["captured_on", "supplier_id", "port_token", "company_name"].includes(f))
    .map((f) => `${f}=EXCLUDED.${f}`)
    .concat("updated_at=now()")
    .join(", ");
  const placeholders = fields.map((f, i) => {
    if (TEXT_ARRAY_FIELDS.includes(f)) return `$${i + 1}::text[]`;
    if (f === "raw") return `$${i + 1}::jsonb`;
    return `$${i + 1}`;
  });
  const supplierSql = `INSERT INTO weiyun_suppliers (${fields.join(", ")})
                       VALUES (${placeholders.join(", ")})
                       ON CONFLICT (captured_on, supplier_id) WHERE supplier_id IS NOT NULL
                       DO UPDATE SET ${updates}`;
  const fallbackSql = `INSERT INTO weiyun_suppliers (${fields.join(", ")})
                       VALUES (${placeholders.join(", ")})
                       ON CONFLICT (captured_on, (COALESCE(port_token, ''::text)), company_name) WHERE supplier_id IS NULL
                       DO UPDATE SET ${updates}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let upserted = 0;
    for (const row of rows) {
      const params = fields.map((f) => (f === "raw" ? JSON.stringify(row.raw || {}) : row[f]));
      await client.query(row.supplier_id == null ? fallbackSql : supplierSql, params);
      upserted += 1;
    }
    await client.query("COMMIT");
    return upserted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setSyncCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const expected = process.env.WEIYUN_SYNC_KEY;
  const got = req.headers["x-sync-key"];
  if (!expected) return res.status(500).json({ ok: false, error: "WEIYUN_SYNC_KEY not configured" });
  if (!got || String(got) !== String(expected)) return res.status(401).json({ ok: false, error: "bad sync key" });

  const pool = getPool();
  try {
    if (req.method === "GET") {
      const ports = await lanePorts(pool);
      return res.status(200).json({ ok: true, source: "market_sailing_lanes", ports });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const body = req.body || {};
    if (body.table && body.table !== "weiyun_suppliers") {
      return res.status(400).json({ ok: false, error: "table must be weiyun_suppliers" });
    }
    const capturedOn = isoDate(body.captured_on);
    const rows = (Array.isArray(body.rows) ? body.rows : [])
      .map((r) => normalizeRow(r, capturedOn))
      .filter(Boolean);
    if (rows.length === 0) return res.status(400).json({ ok: false, error: "rows required" });

    const upserted = await upsertRows(pool, rows);
    const fullPhones = rows.filter((r) => r.phone).length;
    const contactIds = rows.filter((r) => r.contact_id != null).length;
    const supplierIds = rows.filter((r) => r.supplier_id != null).length;
    return res.status(200).json({ ok: true, table: "weiyun_suppliers", captured_on: capturedOn, received: rows.length, upserted, full_phone_rows: fullPhones, contact_id_rows: contactIds, supplier_id_rows: supplierIds });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
