/**
 * migrate-upstream-type.js
 *
 * 上游公司类型标记 (2026-05-19)
 *
 * 在 accounts 表加 upstream_type 字段，精确区分：
 *   oem_factory   — 纯代工厂（有 SC/生产许可，直接生产）
 *   trade_factory — 工贸一体（自有工厂 + 贸易出口能力）
 *   trading_co    — 贸易公司（无生产资质，中间商，竞争风险）
 *   intermediary  — 居间/出口主体（连接工厂与客户，如巴匕）
 *   NULL          — 非上游账号（客户/物流/内部，不填）
 *
 * 同步在 customers 表 raw JSONB 写入 upstream_type，供前端读取。
 *
 * Idempotent. 调用：
 *   curl -X POST https://api.sanlyn.cn/api/db/migrate-upstream-type \
 *        -H "Authorization: Bearer <ADMIN_JWT>"
 */

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const STATEMENTS = [
  // ── 1. 加字段（idempotent）────────────────────────────────────────────────
  `ALTER TABLE accounts
     ADD COLUMN IF NOT EXISTS upstream_type VARCHAR(32) DEFAULT NULL`,

  // ── 2. 在 accounts 里打标 ─────────────────────────────────────────────────

  // 贸易公司 — 恒安（名称含"国际贸易"，无工厂资质，背后工厂未对接）
  `UPDATE accounts
     SET upstream_type = 'trading_co'
   WHERE company ILIKE '%恒安国际贸易%'
     AND upstream_type IS DISTINCT FROM 'trading_co'`,

  // 工贸一体 — 烟台中宠股份（上市品牌母体，有工厂也做贸易）
  `UPDATE accounts
     SET upstream_type = 'trade_factory'
   WHERE company_code = 'zc-brand'
     AND upstream_type IS DISTINCT FROM 'trade_factory'`,

  // 纯工厂 — 中宠食品（中宠OEM生产子公司）
  `UPDATE accounts
     SET upstream_type = 'oem_factory'
   WHERE company_code IN ('zc-oem', 'CN-00055', 'ca', 'CN-00052', 'td')
     AND upstream_type IS DISTINCT FROM 'oem_factory'`,

  // 居间/出口主体 — 巴匕（进出口公司，工厂-客户中间枢纽）
  `UPDATE accounts
     SET upstream_type = 'intermediary'
   WHERE company_code = 'BABI'
     AND upstream_type IS DISTINCT FROM 'intermediary'`,

  // ── 3. 同步写入 customers.raw->>'upstream_type' ───────────────────────────

  // 恒安 → trading_co
  `UPDATE customers
     SET raw = jsonb_set(COALESCE(raw,'{}'), '{upstream_type}', '"trading_co"')
   WHERE company_code = 'CN-00061'`,

  // 中宠股份（brand）→ trade_factory
  `UPDATE customers
     SET raw = jsonb_set(COALESCE(raw,'{}'), '{upstream_type}', '"trade_factory"')
   WHERE name_cn = '烟台中宠股份有限公司'`,

  // 纯工厂
  `UPDATE customers
     SET raw = jsonb_set(COALESCE(raw,'{}'), '{upstream_type}', '"oem_factory"')
   WHERE company_code IN ('CN-00051','CN-00055','CN-00052')
      OR name_cn IN ('辽宁宠爱宠物食品有限公司')`,

  // 巴匕 → intermediary
  `UPDATE customers
     SET raw = jsonb_set(COALESCE(raw,'{}'), '{upstream_type}', '"intermediary"')
   WHERE company_code = 'BABI'`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }

  const pool = getPool();
  const results = [];
  try {
    for (const sql of STATEMENTS) {
      const r = await pool.query(sql);
      results.push({ sql: sql.trim().slice(0, 80) + "…", rowCount: r.rowCount ?? 0 });
    }
    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
