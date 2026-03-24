// sanlyn-api/api/db/customs.js
// GET /api/db/customs              → 全部
// GET /api/db/customs?contract=xxx → 按合同号过滤
// GET /api/db/customs?shipment=xxx → 按出运编号过滤
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  try {
    const pool = getPool();
    const { contract, shipment } = req.query;

    let sql = "SELECT * FROM customs_data";
    const vals = [];
    const conds = [];

    if (contract) {
      conds.push(`contract_no = $${vals.length + 1}`);
      vals.push(contract);
    }
    if (shipment) {
      conds.push(`shipment_no = $${vals.length + 1}`);
      vals.push(shipment);
    }
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY updated_at DESC";

    const result = await pool.query(sql, vals);
    return res.status(200).json({ data: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
