// company-products.js
// GET    /api/db/company-products?company_code=XX   → 列出公司产品目录
// POST   /api/db/company-products                   → 添加产品到目录
// PATCH  /api/db/company-products/:id               → 更新价格/可见性
// DELETE /api/db/company-products/:id               → 移除（软删除 active=false）
//
// 权限:
//   admin / trader / internal → 全局访问
//   factory                   → 只能操作自己 company_code 的记录
//   customer                  → 403 (走 order-create-v2 的 customer-products 接口)

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function normalizeCode(c) {
  return c ? String(c).trim().toUpperCase() : null;
}

// 从 req.user 提取 factory 自己的 company codes（数组）
function getFactoryCodes(user) {
  const raw = user.companyCodes ?? user.companyCode ?? null;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  return arr.map(c => normalizeCode(c)).filter(Boolean);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const role = req.user?.role || "";
  if (role === "customer") {
    return res.status(403).json({ error: "Use /api/db/order-create-v2?action=customer-products to read your catalog." });
  }

  const isAdmin   = role === "admin";
  const isTrader  = role === "trader" || role === "internal";
  const isFactory = role === "factory";
  const factoryCodes = isFactory ? getFactoryCodes(req.user) : [];

  const pool = getPool();

  // ── GET: 列出产品目录 ──────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { company_code, product_id, limit = 200, offset = 0 } = req.query;
    let where = "WHERE cp.active = true";
    const params = [];

    if (isFactory) {
      // factory only sees own codes
      if (!factoryCodes.length) return res.status(403).json({ error: "No company scope in JWT." });
      const ph = factoryCodes.map((_, i) => `$${i + 1}`).join(",");
      where += ` AND cust.company_code IN (${ph})`;
      params.push(...factoryCodes);
    } else if (company_code) {
      params.push(normalizeCode(company_code));
      where += ` AND cust.company_code = $${params.length}`;
    }
    if (product_id) {
      params.push(product_id);
      where += ` AND cp.product_id = $${params.length}`;
    }

    params.push(parseInt(limit), parseInt(offset));
    const sql = `
      SELECT cp.id, cp.product_id, cp.alias_sku, cp.price_cny, cp.price_usd, cp.price_visible,
             cp.moq, cp.lead_time_days, cp.notes, cp.active,
             cust.company_code, cust.name_en AS company_name,
             p.sku, p.name_en, p.name_cn, p.brand, p.size, p.unit,
             p.cbm, p.gross_weight, p.net_weight, p.hs_code, p.image_url
      FROM company_products cp
      JOIN customers cust ON cust.id = cp.company_id
      JOIN products p     ON p.id    = cp.product_id
      ${where}
      ORDER BY cust.company_code, p.name_en
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const r = await pool.query(sql, params);
    return res.status(200).json({ success: true, data: r.rows, count: r.rows.length });
  }

  // ── POST: 添加产品到目录 ───────────────────────────────────────────────────
  if (req.method === "POST") {
    const {
      company_code, product_id, price_cny, price_usd,
      price_visible = true, moq, lead_time_days, notes, alias_sku
    } = req.body || {};

    if (!company_code || !product_id) {
      return res.status(400).json({ error: "company_code and product_id are required" });
    }

    const code = normalizeCode(company_code);
    if (isFactory && !factoryCodes.includes(code)) {
      return res.status(403).json({ error: "You can only add products to your own company catalog." });
    }

    // Look up company_id
    const custRow = await pool.query(
      "SELECT id FROM customers WHERE company_code = $1 LIMIT 1", [code]
    );
    if (!custRow.rows.length) return res.status(404).json({ error: "Company not found: " + code });
    const companyId = custRow.rows[0].id;

    // Compute price_usd from CNY if not provided
    let computedUsd = price_usd || null;
    if (price_cny && !computedUsd) {
      try {
        const rateRow = await pool.query(
          `SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`
        );
        if (rateRow.rows.length) {
          const rate = parseFloat(rateRow.rows[0].rate);
          computedUsd = Math.round((parseFloat(price_cny) / rate + 0.1) * 100) / 100;
        }
      } catch (_) {}
    }

    const r = await pool.query(`
      INSERT INTO company_products
        (company_id, product_id, price_cny, price_usd, price_visible, moq, lead_time_days, notes, alias_sku, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
      ON CONFLICT (company_id, product_id) DO UPDATE SET
        price_cny=EXCLUDED.price_cny, price_usd=EXCLUDED.price_usd,
        price_visible=EXCLUDED.price_visible, moq=EXCLUDED.moq,
        lead_time_days=EXCLUDED.lead_time_days, notes=EXCLUDED.notes,
        alias_sku=EXCLUDED.alias_sku, active=true
      RETURNING id
    `, [companyId, product_id, price_cny || null, computedUsd, price_visible,
        moq || null, lead_time_days || null, notes || null, alias_sku || null]);

    return res.status(200).json({ success: true, id: r.rows[0]?.id });
  }

  // ── PATCH: 更新字段 ────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    // Support both /api/db/company-products?id=X and /api/db/company-products/X
    const urlParts = req.url.split("?")[0].split("/");
    const id = req.query.id || urlParts[urlParts.length - 1];
    if (!id || id === "company-products") return res.status(400).json({ error: "id required" });

    // 权限检查: factory 只能改自己的
    if (isFactory) {
      const check = await pool.query(
        `SELECT cust.company_code FROM company_products cp
         JOIN customers cust ON cust.id = cp.company_id
         WHERE cp.id = $1 LIMIT 1`, [id]
      );
      if (!check.rows.length) return res.status(404).json({ error: "Not found" });
      if (!factoryCodes.includes(normalizeCode(check.rows[0].company_code))) {
        return res.status(403).json({ error: "Not your record." });
      }
    }

    const body = req.body || {};
    const allowed = ["price_cny", "price_usd", "price_visible", "moq", "lead_time_days", "notes", "alias_sku", "active"];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (body[k] !== undefined) {
        vals.push(body[k]);
        sets.push(`${k}=$${vals.length}`);
      }
    }

    // Auto-recompute price_usd if price_cny changed but price_usd not explicitly provided
    if (body.price_cny !== undefined && body.price_usd === undefined) {
      try {
        const rateRow = await pool.query(
          `SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`
        );
        if (rateRow.rows.length) {
          const rate = parseFloat(rateRow.rows[0].rate);
          const newUsd = Math.round((parseFloat(body.price_cny) / rate + 0.1) * 100) / 100;
          vals.push(newUsd);
          sets.push(`price_usd=$${vals.length}`);
        }
      } catch (_) {}
    }

    if (!sets.length) return res.status(400).json({ error: "No valid fields to update" });
    vals.push(id);
    await pool.query(`UPDATE company_products SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    return res.status(200).json({ success: true });
  }

  // ── DELETE: 软删除（active=false）────────────────────────────────────────
  if (req.method === "DELETE") {
    const urlParts = req.url.split("?")[0].split("/");
    const id = req.query.id || urlParts[urlParts.length - 1];
    if (!id || id === "company-products") return res.status(400).json({ error: "id required" });

    if (isFactory) {
      const check = await pool.query(
        `SELECT cust.company_code FROM company_products cp
         JOIN customers cust ON cust.id = cp.company_id
         WHERE cp.id = $1 LIMIT 1`, [id]
      );
      if (!check.rows.length) return res.status(404).json({ error: "Not found" });
      if (!factoryCodes.includes(normalizeCode(check.rows[0].company_code))) {
        return res.status(403).json({ error: "Not your record." });
      }
    }

    await pool.query(`UPDATE company_products SET active=false WHERE id=$1`, [id]);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
