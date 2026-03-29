// api/db/audit-log.js — S75: auditLog 持久化端点
// 功能：向 orders.vault JSONB 的指定 certKey 追加 auditLog 记录
// 调用：POST { contractNo, certKey, log: {icon,user,action,time,detail} }
// 也支持批量更新 vault 子字段：PATCH { contractNo, certKey, patch: {...} }
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { contractNo, certKey, log, patch } = req.body;

    if (!contractNo || !certKey) {
      return res.status(400).json({ success: false, error: "contractNo and certKey required" });
    }

    // ── Step 1: 确保 vault 列存在（首次会自动建列）──
    // 这个 ALTER TABLE 是幂等的，IF NOT EXISTS 保证不会报错
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS vault JSONB DEFAULT '{}'::jsonb
    `);

    // ── Step 2: 初始化 vault 和 vault.{certKey} 如果不存在 ──
    await pool.query(`
      UPDATE orders
      SET vault = COALESCE(vault, '{}'::jsonb)
      WHERE contract_no = $1
    `, [contractNo]);

    // 初始化 certKey 节点
    await pool.query(`
      UPDATE orders
      SET vault = jsonb_set(vault, $2, COALESCE(vault->$3, '{}'::jsonb))
      WHERE contract_no = $1
    `, [contractNo, `{${certKey}}`, certKey]);

    // ── Step 3: 追加 auditLog 记录 ──
    if (log) {
      // 确保 auditLog 数组存在
      await pool.query(`
        UPDATE orders
        SET vault = jsonb_set(
          vault,
          $2,
          COALESCE(vault->$3->'auditLog', '[]'::jsonb)
        )
        WHERE contract_no = $1
        AND (vault->$3->'auditLog') IS NULL
      `, [contractNo, `{${certKey},auditLog}`, certKey]);

      // 追加新日志
      const result = await pool.query(`
        UPDATE orders
        SET vault = jsonb_set(
          vault,
          $2,
          (COALESCE(vault->$3->'auditLog', '[]'::jsonb)) || $4::jsonb,
          true
        ),
        updated_at = NOW()
        WHERE contract_no = $1
        RETURNING contract_no, vault->$3 as cert_vault
      `, [contractNo, `{${certKey},auditLog}`, certKey, JSON.stringify([log])]);

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Order not found: " + contractNo });
      }
      return res.status(200).json({
        success: true,
        contractNo,
        certKey,
        certVault: result.rows[0].cert_vault,
      });
    }

    // ── Step 4: 批量更新 vault.{certKey} 子字段（如 uploaded, url, stampPurpose 等）──
    if (patch) {
      const result = await pool.query(`
        UPDATE orders
        SET vault = jsonb_set(
          vault,
          $2,
          (COALESCE(vault->$3, '{}'::jsonb)) || $4::jsonb,
          true
        ),
        updated_at = NOW()
        WHERE contract_no = $1
        RETURNING contract_no, vault->$3 as cert_vault
      `, [contractNo, `{${certKey}}`, certKey, JSON.stringify(patch)]);

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Order not found: " + contractNo });
      }
      return res.status(200).json({
        success: true,
        contractNo,
        certKey,
        certVault: result.rows[0].cert_vault,
      });
    }

    return res.status(400).json({ success: false, error: "Must provide log or patch" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
