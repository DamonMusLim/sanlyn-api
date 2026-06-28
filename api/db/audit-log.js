// api/db/audit-log.js — S94: 升级版 audit-log
// 兼容 S75 原有功能 (vault certKey 日志) + S94 新增通用审计日志
//
// 模式1 (S75 兼容): POST { contractNo, certKey, log, patch, table? }
//   → 写入 orders/shipping_plans 的 vault JSONB
//
// 模式2 (S94 通用): POST { action, operator, role, ... } (无 certKey)
//   → 写入 audit_logs 表
//
// GET /api/db/audit-log
//   ?contract=xxx    → 按合同号查审计日志
//   ?action=download → 按操作类型
//   ?operator=xxx    → 按操作人
//   ?limit=50

import { getPool, setCors } from "../db.js";

const ALLOWED_TABLES = { orders: "contract_no", shipping_plans: "shipment_no" };

const CREATE_AUDIT_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    action VARCHAR(50) NOT NULL,
    operator VARCHAR(100),
    role VARCHAR(50),
    company VARCHAR(200),
    contract_no VARCHAR(100),
    document_id VARCHAR(200),
    document_name VARCHAR(200),
    document_key VARCHAR(50),
    detail JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ═══ GET: 查询审计日志 ═══
  if (req.method === "GET") {
    try {
      // 确保表存在
      await pool.query(CREATE_AUDIT_TABLE).catch(function () {});

      const { contract, action, operator, limit: rawLimit } = req.query;
      const lim = Math.min(Number(rawLimit) || 50, 500);

      let sql = "SELECT * FROM audit_logs";
      const vals = [];
      const conds = [];

      if (contract) { vals.push(contract); conds.push("contract_no = $" + vals.length); }
      if (action) { vals.push(action); conds.push("action = $" + vals.length); }
      if (operator) { vals.push(operator); conds.push("operator = $" + vals.length); }

      if (conds.length) sql += " WHERE " + conds.join(" AND ");
      sql += " ORDER BY created_at DESC LIMIT " + lim;

      const result = await pool.query(sql, vals);
      return res.status(200).json({ success: true, data: result.rows, count: result.rows.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ═══ POST ═══
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};

    // ── 模式判断: 有 certKey → S75 vault 模式, 否则 → S94 通用模式 ──
    if (body.certKey) {
      // ══ S75 兼容: vault 日志 ══
      const { contractNo, certKey, log, patch, table: rawTable } = body;
      const table = ALLOWED_TABLES[rawTable] ? rawTable : "orders";
      const matchCol = ALLOWED_TABLES[table];

      if (!contractNo) {
        return res.status(400).json({ success: false, error: "contractNo and certKey required" });
      }

      // 确保 vault 列存在
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS vault JSONB DEFAULT '{}'::jsonb`);

      // 初始化 vault
      await pool.query(
        `UPDATE ${table} SET vault = COALESCE(vault, '{}'::jsonb) WHERE ${matchCol} = $1`,
        [contractNo]
      );

      // 初始化 certKey 节点
      await pool.query(
        `UPDATE ${table} SET vault = jsonb_set(vault, $2, COALESCE(vault->$3, '{}'::jsonb)) WHERE ${matchCol} = $1`,
        [contractNo, `{${certKey}}`, certKey]
      );

      // 追加 auditLog
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

      // 批量更新 vault.{certKey}
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
    }

    // ══ S94 通用审计日志: 写入 audit_logs 表 ══
    await pool.query(CREATE_AUDIT_TABLE).catch(function () {});

    const {
      action, operator, role, company,
      contractNo, contract_no,
      documentId, document_id,
      documentName, document_name,
      documentKey, document_key,
      timestamp,
      ...rest
    } = body;

    if (!action) {
      return res.status(400).json({ success: false, error: "action required" });
    }

    // 收集额外字段到 detail JSONB
    const detail = {};
    Object.keys(rest).forEach(function (k) {
      // 排除已提取的标准字段
      if (!["certKey", "log", "patch", "table"].includes(k)) {
        detail[k] = rest[k];
      }
    });
    if (timestamp) detail.timestamp = timestamp;

    const result = await pool.query(
      `INSERT INTO audit_logs (action, operator, role, company, contract_no, document_id, document_name, document_key, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, action, operator, created_at`,
      [
        action,
        operator || "unknown",
        role || "unknown",
        company || "",
        contractNo || contract_no || "",
        documentId || document_id || "",
        documentName || document_name || "",
        documentKey || document_key || "",
        JSON.stringify(detail),
      ]
    );

    return res.status(200).json({ success: true, data: result.rows[0] });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
