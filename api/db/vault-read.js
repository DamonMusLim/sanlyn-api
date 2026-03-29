// api/db/vault-read.js — S75: 读取 vault (v2: 支持 orders + shipping_plans)
// GET ?contractNo=xxx  →  orders.vault
// GET ?contractNo=xxx&table=shipping_plans  →  shipping_plans.vault (用 shipment_no 匹配)
import { getPool, setCors } from "../db.js";

const ALLOWED_TABLES = { orders: "contract_no", shipping_plans: "shipment_no" };

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { contractNo, certKey, table: rawTable } = req.query;
    const table = ALLOWED_TABLES[rawTable] ? rawTable : "orders";
    const matchCol = ALLOWED_TABLES[table];

    if (!contractNo) {
      return res.status(400).json({ success: false, error: "contractNo required" });
    }

    const result = await pool.query(
      `SELECT ${matchCol}, vault FROM ${table} WHERE ${matchCol} = $1 LIMIT 1`,
      [contractNo]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Record not found" });
    }

    const vault = result.rows[0].vault || {};

    if (certKey) {
      return res.status(200).json({ success: true, contractNo, certKey, table, certVault: vault[certKey] || {} });
    }

    return res.status(200).json({ success: true, contractNo, table, vault });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
