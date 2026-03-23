import { setCors, getPool } from "./db.js";

const CW = {
  companyCode: "_widget_1764478692413",
  pol:         "_widget_1765086870619",
  pod:         "_widget_1765087459517",
  portalRoles: "_widget_1771814282260",
  factoryCode: "_widget_1764483220499",
};

function get(row, w) {
  const v = row[w];
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return v.value ?? null;
  return v;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS, GET");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-company-sync" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    const op   = body.op || "";
    if (op === "data_remove") return res.status(200).json({ ok: true, skip: "delete" });

    const row  = body.data?.data || body.data || body;
    const companyCode = get(row, CW.companyCode);
    if (!companyCode) return res.status(200).json({ ok: true, skip: "no companyCode" });

    const pol = get(row, CW.pol) || null;
    const pod = get(row, CW.pod) || null;
    const portalRolesRaw = get(row, CW.portalRoles);
    const portalRoles = Array.isArray(portalRolesRaw) ? portalRolesRaw.join(",") : (portalRolesRaw || null);
    const factoryCode = get(row, CW.factoryCode) || null;

    const pool = getPool();
    const r = await pool.query(`
      UPDATE customers SET
        raw = raw || jsonb_build_object(
          'pol', $1::text,
          'pod', $2::text,
          'portalRoles', $3::text,
          'factoryCode', $4::text
        ),
        updated_at = NOW()
      WHERE company_code = $5
      RETURNING company_code
    `, [pol, pod, portalRoles, factoryCode, companyCode]);

    return res.status(200).json({ ok: true, updated: r.rowCount, companyCode, pol });
  } catch (err) {
    console.error("[jdy-company-sync]", err);
    return res.status(500).json({ error: err.message });
  }
}
