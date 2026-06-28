// /api/db/pending-token-create.js — issue a share link for factory pending-date confirmation.
//
// POST /api/db/pending-token-create
//   body: { orderNo, factoryCompanyCode?, factoryNameCN?, ttlDays? }
//   auth: JWT, roles ∈ { admin, sales, trader, logistics }
//
// Mirrors factory-token-create.js but uses purpose='pending_confirm'.
// If factoryCompanyCode is omitted, we try orders.raw.factoryCompanyCode,
// else create a CN-* stub.
//
// Response: { token, shortUrl, expiresAt, factoryCompanyCode, orderNo }
// Frontend uses shortUrl for AdminPanel "📤 Generate share link" button.

import crypto from "crypto";
import { getPool, setCors } from "../db.js";

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const INTERNAL_ROLES = ["admin", "sales", "trader", "logistics"];
  if (!INTERNAL_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const pool = getPool();
    const body = req.body || {};
    const orderNo = (body.orderNo || "").trim();
    let factoryCompanyCode = (body.factoryCompanyCode || "").trim();
    const factoryNameCN = (body.factoryNameCN || "").trim();
    const ttlDays = Math.min(Math.max(parseInt(body.ttlDays || 14), 1), 60);

    if (!orderNo) return res.status(400).json({ error: "orderNo required" });

    // Locate order
    const or = await pool.query(
      "SELECT order_no, company_code, raw FROM orders WHERE order_no=$1",
      [orderNo]
    );
    if (or.rows.length === 0) return res.status(404).json({ error: "order not found" });
    const orderRow = or.rows[0];

    // Fallback: try to infer factory from the order's raw payload
    if (!factoryCompanyCode) {
      factoryCompanyCode =
        orderRow.raw?.factoryCompanyCode ||
        orderRow.raw?.factory?.companyCode ||
        "";
    }

    if (!factoryCompanyCode) {
      factoryCompanyCode =
        "CN-" +
        Date.now().toString(36).toUpperCase() +
        "-" +
        Math.random().toString(36).slice(2, 6).toUpperCase();
      await pool.query(
        `INSERT INTO customers (company_code, name_cn, portal_role, is_active, raw, updated_at)
         VALUES ($1, $2, 'factory', true, $3::jsonb, NOW())
         ON CONFLICT (company_code) DO NOTHING`,
        [
          factoryCompanyCode,
          factoryNameCN || "(Pending factory)",
          JSON.stringify({
            source: "pending-token-create",
            stub: true,
            createdFor: orderNo,
          }),
        ]
      );
    } else {
      const fr = await pool.query(
        "SELECT company_code FROM customers WHERE company_code=$1",
        [factoryCompanyCode]
      );
      if (fr.rows.length === 0) {
        // Create stub anyway so the token lookup works
        await pool.query(
          `INSERT INTO customers (company_code, name_cn, portal_role, is_active, raw, updated_at)
           VALUES ($1, $2, 'factory', true, $3::jsonb, NOW())
           ON CONFLICT (company_code) DO NOTHING`,
          [
            factoryCompanyCode,
            factoryNameCN || "(Pending factory)",
            JSON.stringify({
              source: "pending-token-create",
              stub: true,
              createdFor: orderNo,
            }),
          ]
        );
      }
    }

    const token = newToken();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);

    await pool.query(
      `INSERT INTO _idx_tokens (token, company_code, purpose, expires_at)
       VALUES ($1, $2, 'pending_confirm', $3)`,
      [token, factoryCompanyCode, expiresAt]
    );

    const tokenRecord = {
      token,
      orderNo,
      purpose: "pending_confirm",
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

    // Stamp the order so admin UI can show "share link sent"
    await pool.query(
      `UPDATE orders SET
         raw = COALESCE(raw, '{}'::jsonb)
               || jsonb_build_object(
                    'pendingTokenSentAt', NOW()::text,
                    'pendingTokenFactory', $2::text
                  ),
         updated_at = NOW()
       WHERE order_no = $1`,
      [orderNo, factoryCompanyCode]
    );

    const PUBLIC_HOST = process.env.PUBLIC_WEB_HOST || "https://ai.sanlyn.cn";
    const shortUrl = `${PUBLIC_HOST}/p/${token}`;

    return res.status(200).json({
      success: true,
      token,
      shortUrl,
      expiresAt: expiresAt.toISOString(),
      factoryCompanyCode,
      orderNo,
    });
  } catch (err) {
    console.error("[pending-token-create]", err);
    return res.status(500).json({ error: err.message });
  }
}
