// api/db/vault-read.js — S75: 读取 orders.vault
// GET ?contractNo=XM-xxx  →  返回 vault JSON
// GET ?contractNo=XM-xxx&certKey=PC  →  返回单个 certKey 的 vault
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { contractNo, certKey } = req.query;

    if (!contractNo) {
      return res.status(400).json({ success: false, error: "contractNo required" });
    }

    const result = await pool.query(
      `SELECT contract_no, vault FROM orders WHERE contract_no = $1 LIMIT 1`,
      [contractNo]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    const vault = result.rows[0].vault || {};

    if (certKey) {
      return res.status(200).json({
        success: true,
        contractNo,
        certKey,
        certVault: vault[certKey] || {},
      });
    }

    return res.status(200).json({
      success: true,
      contractNo,
      vault,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
