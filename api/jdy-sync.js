import { setCors, getPool } from "./db.js";

const ENTRY = {
  docs:       "691e76b3cb637ee7ef1f25ca",  // 单证归档
  company:    "692a7c7d85918bdb075ee048",  // 公司表
  customer:   "68da2738987870a88c839d6e",  // 客户档案
};

// 客户档案字段
const CUSTW = {
  companyCode:     "_widget_1771622930859",  // 客户代号
  relatedFactories:"_widget_1774282924445",  // 关联工厂(checkboxgroup)
};

const CN_WIDGET = "_widget_1766730818801";

// 公司表字段
const CW = {
  nameCN:      "_widget_1764392061244",
  nameEN:      "_widget_1764392061245",
  companyCode: "_widget_1764478692413",
  factoryCode: "_widget_1764483220499",
  pol:         "_widget_1765086870619",
  pod:         "_widget_1765087459517",
  portalRoles: "_widget_1771814282260",  // combocheck 复选
  shortCode:   "_widget_1764392061246",
  country:     "_widget_1764394732261",
};

function get(row, w) {
  const v = row[w];
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return v.value ?? null;
  return v;
}

async function syncCompany(row, jdyId, pool) {
  const portalRolesRaw = get(row, CW.portalRoles);
  const portalRoles = Array.isArray(portalRolesRaw)
    ? portalRolesRaw.join(",")
    : (portalRolesRaw || "");

  const companyCode = get(row, CW.companyCode) || jdyId;

  await pool.query(`
    UPDATE customers SET
      raw = raw || jsonb_build_object(
        'pol', $1::text,
        'pod', $2::text,
        'portalRoles', $3::text,
        'factoryCode', $4::text
      ),
      updated_at = NOW()
    WHERE company_code = $5
  `, [
    get(row, CW.pol)         || null,
    get(row, CW.pod)         || null,
    portalRoles              || null,
    get(row, CW.factoryCode) || null,
    companyCode,
  ]);

  console.log(`[jdy-sync] company synced: ${companyCode} pol=${get(row, CW.pol)}`);
  return { synced: "company", companyCode };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-sync v2" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) return res.status(200).json({ ok: true });

    const entryId = body.data?.entryId || body.entryId || "";
    const row     = body.data?.data || body.data || body;
    const jdyId   = row._id || "";

    // 单证归档
    if (entryId === ENTRY.docs || entryId === "") {
      const contractNo = row[CN_WIDGET] || "";
      const docsRes = await fetch("https://sanlyn-api.vercel.app/api/jdy/docs-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: row, contractNo })
      });
      const result = await docsRes.json();
      return res.status(200).json(result);
    }

    // 公司表
    if (entryId === ENTRY.company) {
      const pool = getPool();
      const result = await syncCompany(row, jdyId, pool);
      return res.status(200).json({ ok: true, ...result });
    }

    // 客户档案
    if (entryId === ENTRY.customer) {
      const pool = getPool();
      const companyCode = get(row, CUSTW.companyCode);
      const factoriesRaw = get(row, CUSTW.relatedFactories);
      const factories = Array.isArray(factoriesRaw) ? factoriesRaw : (factoriesRaw ? [factoriesRaw] : []);
      if (companyCode) {
        await pool.query(`
          UPDATE customers SET
            raw = raw || jsonb_build_object('relatedFactories', $1::jsonb),
            updated_at = NOW()
          WHERE company_code = $2
        `, [JSON.stringify(factories), companyCode]);
        console.log(\`[jdy-sync] customer \${companyCode} factories=\${factories.join(",")}\`);
      }
      return res.status(200).json({ ok: true, synced: "customer", companyCode, factories });
    }

    return res.status(200).json({ ok: true, skip: "unknown entryId", entryId });

  } catch (err) {
    console.error("[jdy-sync]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
