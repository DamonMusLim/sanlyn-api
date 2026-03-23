import { setCors, getPool } from "./db.js";

const CW = {
  companyCode:      "_widget_1771622930859",  // 客户代号（可能是空）
  selectCompany:    "_widget_1766650731323",  // 选择公司（linkdata，关联公司表代号）
  relatedFactories: "_widget_1774282924445",  // 关联工厂
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
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-customer-sync" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    const op   = body.op || "";
    if (op === "data_remove") return res.status(200).json({ ok: true, skip: "delete" });

    const row = body.data?.data || body.data || body;
    // 优先用「选择公司」linkdata字段，fallback到「客户代号」
    const selectCompanyRaw = get(row, CW.selectCompany);
    const linkedCode = Array.isArray(selectCompanyRaw)
      ? (selectCompanyRaw[0]?._id || selectCompanyRaw[0])
      : (typeof selectCompanyRaw === "object" ? selectCompanyRaw?._id : selectCompanyRaw);
    const companyCode = linkedCode || get(row, CW.companyCode);
    if (!companyCode) return res.status(200).json({ ok: true, skip: "no companyCode" });

    const factoriesRaw = get(row, CW.relatedFactories);
    const factories = Array.isArray(factoriesRaw) ? factoriesRaw : (factoriesRaw ? [factoriesRaw] : []);

    const pool = getPool();
    const r = await pool.query(`
      UPDATE customers SET
        raw = raw || jsonb_build_object('relatedFactories', $1::jsonb),
        updated_at = NOW()
      WHERE company_code = $2
        OR raw->>'companyCode' = $2
        OR raw->>'shortCode' = $2
      RETURNING company_code
    `, [JSON.stringify(factories), companyCode]);

    return res.status(200).json({ ok: true, updated: r.rowCount, companyCode, factories });
  } catch (err) {
    console.error("[jdy-customer-sync]", err);
    return res.status(500).json({ error: err.message });
  }
}
