// api/db/audit-log.js — S75: auditLog 持久化端点 (v2: 支持 orders + shipping_plans)
// 调用：POST { contractNo, certKey, log, patch, table? }
// table: "orders"(默认) 或 "shipping_plans"
// orders 用 contract_no 匹配，shipping_plans 用 shipment_no 匹配
import { getPool, setCors } from "../db.js";

const ALLOWED_TABLES = { orders: "contract_no", shipping_plans: "shipment_no" };

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { contractNo, certKey, log, patch, table: rawTable } = req.body;
    const table = ALLOWED_TABLES[rawTable] ? rawTable : "orders";
    const matchCol = ALLOWED_TABLES[table];

    if (!contractNo || !certKey) {
      return res.status(400).json({ success: false, error: "contractNo and certKey required" });
    }

    // ── Step 1: 确保 vault 列存在 ──
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS vault JSONB DEFAULT '{}'::jsonb`);

    // ── Step 2: 初始化 vault ──
    await pool.query(`UPDATE ${table} SET vault = COALESCE(vault, '{}'::jsonb) WHERE ${matchCol} = $1`, [contractNo]);

    // 初始化 certKey 节点
    await pool.query(
      `UPDATE ${table} SET vault = jsonb_set(vault, $2, COALESCE(vault->$3, '{}'::jsonb)) WHERE ${matchCol} = $1`,
      [contractNo, `{${certKey}}`, certKey]
    );

    // ── Step 3: 追加 auditLog 记录 ──
    if (log) {
      await pool.query(
        `UPDATE ${table} SET vault = jsonb_set(vault, $2, COALESCE(vault->$3->'auditLog', '[]'::jsonb)) WHERE ${matchCol} = $1 AND (vault->$3->'auditLog') IS NULL`,
        [contractNo, `{${certKey},auditLog}`, certKey]
      );

      const result = await pool.query(
        `UPDATE ${table} SET vault = jsonb_set(vault, $2, (COALESCE(vault->$3->'auditLog', '[]'::jsonb)) || $4::jsonb, true), updated_at = NOW() WHERE ${matchCol} = $1 RETURNING ${matchCol}, vault->$3 as cert_vault`,
        [contractNo, `{${certKey},auditLog}`, certKey, JSON.stringify([log])]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Record not found: " + contractNo + " in " + table });
      }
      return res.status(200).json({ success: true, contractNo, certKey, table, certVault: result.rows[0].cert_vault });
    }

    // ── Step 4: 批量更新 vault.{certKey} 子字段 ──
    if (patch) {
      const result = await pool.query(
        `UPDATE ${table} SET vault = jsonb_set(vault, $2, (COALESCE(vault->$3, '{}'::jsonb)) || $4::jsonb, true), updated_at = NOW() WHERE ${matchCol} = $1 RETURNING ${matchCol}, vault->$3 as cert_vault`,
        [contractNo, `{${certKey}}`, certKey, JSON.stringify(patch)]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Record not found: " + contractNo + " in " + table });
      }
      return res.status(200).json({ success: true, contractNo, certKey, table, certVault: result.rows[0].cert_vault });
    }

    return res.status(400).json({ success: false, error: "Must provide log or patch" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
