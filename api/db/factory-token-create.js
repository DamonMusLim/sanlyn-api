// api/db/factory-token-create.js — 生成工厂填单 token（内部接口）
//
// POST /api/db/factory-token-create
//   body: { orderNo, factoryCompanyCode?, factoryNameCN?, ttlDays?, skuLines? }
//   auth: JWT, roles ∈ { admin, sales, logistics }
//
// 动作：
//   1. 生成 opaque 64-char token（crypto.randomBytes）
//   2. INSERT _idx_tokens（token → company_code 反向索引）
//   3. 若 factoryCompanyCode 缺失 → 建 CN-* stub（portal_role='factory', tax_id NULL）
//   4. customers.raw.activeTokens[] 追加 token 记录
//   5. 返回 { token, shortUrl, expiresAt }
//
// Frontend 用法：老板 or 业务在 AdminPanel 点"发链接给工厂"就打这个。
// 不暴露公开，公开的入口是 /f/<token> → factory-fill.html
import crypto from "crypto";
import { getPool, setCors } from "../db.js";

function newToken() {
  // 32 bytes → 64 hex chars，够抗猜测
  return crypto.randomBytes(32).toString("hex");
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // 鉴权：内部岗位 or 订单所属 customer 本人
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const INTERNAL_ROLES = ["admin", "sales", "logistics"];
  const isInternal = INTERNAL_ROLES.includes(req.user.role);
  const isCustomer = req.user.role === "customer";
  if (!isInternal && !isCustomer) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const pool = getPool();
    const body = req.body || {};
    const orderNo               = (body.orderNo || "").trim();
    let   factoryCompanyCode    = (body.factoryCompanyCode || "").trim();
    const factoryNameCN         = (body.factoryNameCN || "").trim();
    const ttlDays               = Math.min(Math.max(parseInt(body.ttlDays || 7), 1), 30);
    const skuLines              = Array.isArray(body.skuLines) ? body.skuLines : [];

    if (!orderNo) return res.status(400).json({ error: "orderNo required" });

    // 1) 订单存在性检查
    const or = await pool.query(
      "SELECT order_no, company_code, raw FROM orders WHERE order_no=$1",
      [orderNo]
    );
    if (or.rows.length === 0) return res.status(404).json({ error: "order not found" });

    // Customer 只能给自己的订单发链接
    if (isCustomer) {
      const orderOwner = or.rows[0].company_code || "";
      const userCodes = Array.isArray(req.user.companyCodes) ? req.user.companyCodes
                      : (req.user.companyCode ? [req.user.companyCode] : []);
      if (!orderOwner || !userCodes.includes(orderOwner)) {
        return res.status(403).json({ error: "Forbidden: not your order" });
      }
    }

    // 2) 若没指定工厂 → 建 CN-* stub
    if (!factoryCompanyCode) {
      factoryCompanyCode = "CN-" + Date.now().toString(36).toUpperCase() + "-" +
                           Math.random().toString(36).slice(2, 6).toUpperCase();
      await pool.query(
        `INSERT INTO customers (company_code, name_cn, portal_role, is_active, raw, updated_at)
         VALUES ($1, $2, 'factory', true, $3::jsonb, NOW())
         ON CONFLICT (company_code) DO NOTHING`,
        [
          factoryCompanyCode,
          factoryNameCN || "(待工厂填写)",
          JSON.stringify({ source: "factory-token-create", stub: true, createdFor: orderNo }),
        ]
      );
    } else {
      // 验证工厂存在
      const fr = await pool.query(
        "SELECT company_code FROM customers WHERE company_code=$1",
        [factoryCompanyCode]
      );
      if (fr.rows.length === 0) {
        return res.status(404).json({ error: "factory not found: " + factoryCompanyCode });
      }
    }

    // 3) 生成 token
    const token = newToken();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);

    // 4) 反向索引
    await pool.query(
      `INSERT INTO _idx_tokens (token, company_code, purpose, expires_at)
       VALUES ($1, $2, 'factory_fill', $3)`,
      [token, factoryCompanyCode, expiresAt]
    );

    // 5) 写入 customers.raw.activeTokens[]
    const tokenRecord = {
      token,
      orderNo,
      skuLines,
      purpose: "factory_fill",
      issuedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      issuedBy: req.user.username || req.user.userId || "system",
    };
    await pool.query(
      `UPDATE customers SET
         raw = jsonb_set(
           COALESCE(raw, '{}'::jsonb),
           '{activeTokens}',
           COALESCE(raw->'activeTokens', '[]'::jsonb) || $1::jsonb
         ),
         updated_at = NOW()
       WHERE company_code = $2`,
      [JSON.stringify(tokenRecord), factoryCompanyCode]
    );

    // 6) 订单上标记已发送
    await pool.query(
      `UPDATE orders SET
         raw = COALESCE(raw, '{}'::jsonb)
               || jsonb_build_object(
                    'factoryTokenSent',    NOW()::text,
                    'invoiceTokenSentAt',  NOW()::text
                  ),
         updated_at = NOW()
       WHERE order_no = $1`,
      [orderNo]
    );

    // 构造 short URL（老板可直接微信发）
    const PUBLIC_HOST = process.env.PUBLIC_HOST || "https://api.sanlyn.cn";
    const shortUrl = `${PUBLIC_HOST}/f/${token}`;

    return res.status(200).json({
      success: true,
      token,
      shortUrl,
      expiresAt: expiresAt.toISOString(),
      factoryCompanyCode,
      orderNo,
    });
  } catch (err) {
    console.error("[factory-token-create]", err);
    return res.status(500).json({ error: err.message });
  }
}
