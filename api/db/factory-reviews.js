// api/db/factory-reviews.js — Damon 审核工厂提交
//
// GET  /api/db/factory-reviews
//   → 列出 orders.raw.reviewStatus='pending_damon_review' 的订单
//   → 返回：order_no, company_code, brand, factoryResponses[]（原样透传）
//
// POST /api/db/factory-reviews
//   body: { orderNo, responseIndex=latest, action: 'approve'|'reject', note? }
//   approve:
//     - orders.raw.reviewStatus = 'approved'
//     - orders.production_status = 'in_production'
//     - 把 factoryResponses[i].lines 里每行产品自动 upsert 到 products 表
//       * 若行里带 sku/productCode → 按 sku 主键 upsert
//       * 若只有 productName → 用"工厂代号-orderNo-idx"作 placeholder sku
//     - 通知客户（stub：写 orders.raw.customerNotifications[]，邮件待接）
//   reject:
//     - orders.raw.reviewStatus = 'rejected'
//     - orders.raw.rejectNote = note
//     - 不自动重发 token，由人工处理
//
// 鉴权：admin 或 sales
import { getPool, setCors } from "../db.js";

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

async function upsertProductsFromFactoryLines(pool, order, lines, factoryCompanyCode) {
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const rawSku       = (l.sku || l.productCode || "").trim();
    const productName  = (l.productName || l.desc || "").trim();
    if (!productName) continue;

    // SKU 规则：已有 code 就用，没有就"工厂代号-订单号-序号" placeholder
    const sku = rawSku || `${factoryCompanyCode}-${order.order_no}-${i + 1}`;
    const brand = order.brand || null;

    // upsert — 仅写基本字段，价格/重量/CBM 由工厂 response 填入
    await pool.query(
      `INSERT INTO products (sku, product_name, brand, factory_price, cbm, raw, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (sku) DO UPDATE SET
         product_name  = COALESCE(EXCLUDED.product_name, products.product_name),
         factory_price = COALESCE(EXCLUDED.factory_price, products.factory_price),
         cbm           = COALESCE(EXCLUDED.cbm, products.cbm),
         raw           = products.raw || EXCLUDED.raw,
         updated_at    = NOW()`,
      [
        sku,
        productName,
        brand,
        parseFloat(l.unitPrice) || null,
        parseFloat(l.cbm) || null,
        JSON.stringify({
          source: "factory_response",
          factoryCompanyCode,
          fromOrder: order.order_no,
          qty: parseFloat(l.qty) || 0,
          canIssueVat: !!l.canIssueVat,
          note: l.note || null,
          ingestedAt: new Date().toISOString(),
        }),
      ]
    );
    results.push({ sku, productName, isPlaceholder: !rawSku });
  }
  return results;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!req.user || !["admin", "sales"].includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden: admin/sales only" });
  }

  const pool = getPool();

  try {
    // ── GET: 列待审核订单 ──────────────────────────────────
    if (req.method === "GET") {
      const r = await pool.query(`
        SELECT
          order_no,
          company_code,
          company_name_cn,
          brand,
          currency,
          total_qty,
          total_amount,
          production_status,
          raw,
          updated_at
        FROM orders
        WHERE raw->>'reviewStatus' = 'pending_damon_review'
        ORDER BY updated_at DESC
        LIMIT 200
      `);
      const rows = r.rows.map(o => ({
        orderNo:          o.order_no,
        companyCode:      o.company_code,
        companyNameCN:    o.company_name_cn,
        brand:            o.brand,
        currency:         o.currency,
        totalQty:         o.total_qty,
        totalAmount:      o.total_amount,
        productionStatus: o.production_status,
        reviewStatus:     "pending_damon_review",
        factoryResponses: Array.isArray(o.raw?.factoryResponses) ? o.raw.factoryResponses : [],
        updatedAt:        o.updated_at,
      }));
      return res.status(200).json({ success: true, data: rows, count: rows.length });
    }

    // ── POST: 审核决策 ──────────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};
      const orderNo = (body.orderNo || "").trim();
      const action  = (body.action || "").trim();
      const note    = (body.note || "").trim();
      if (!orderNo) return res.status(400).json({ error: "orderNo required" });
      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      }

      const or = await pool.query(
        "SELECT order_no, company_code, brand, raw FROM orders WHERE order_no=$1",
        [orderNo]
      );
      if (or.rows.length === 0) return res.status(404).json({ error: "order not found" });
      const order = or.rows[0];
      const responses = Array.isArray(order.raw?.factoryResponses) ? order.raw.factoryResponses : [];
      if (responses.length === 0) return res.status(400).json({ error: "no factory responses to review" });

      const idx = Number.isInteger(body.responseIndex) ? body.responseIndex : responses.length - 1;
      const chosen = responses[idx];
      if (!chosen) return res.status(400).json({ error: "responseIndex out of range" });

      const reviewer = req.user.username || req.user.userId || "admin";

      if (action === "approve") {
        // Auto-ingest products
        const factoryCompanyCode = chosen.factoryCompanyCode ||
                                   chosen.factoryInfo?.companyCode ||
                                   "UNKNOWN";
        const ingested = await upsertProductsFromFactoryLines(
          pool, order, chosen.lines || [], factoryCompanyCode
        );

        // 写客户通知队列（customer 能在订单详情看到"交货期：xxx"）
        const deliveryPromised = chosen.delivery?.promised || null;
        const notification = {
          type: "factory_confirmed",
          ts: new Date().toISOString(),
          deliveryPromised,
          contractNo: chosen.contractNo,
          by: reviewer,
          note: note || null,
        };

        await pool.query(
          `UPDATE orders SET
             raw = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(
                     COALESCE(raw, '{}'::jsonb),
                     '{reviewStatus}',
                     '"approved"'
                   ),
                   '{reviewedAt}',
                   to_jsonb(NOW()::text)
                 ),
                 '{reviewedBy}',
                 to_jsonb($1::text)
               ),
               '{customerNotifications}',
               COALESCE(raw->'customerNotifications', '[]'::jsonb) || $2::jsonb
             ),
             production_status = 'in_production',
             updated_at = NOW()
           WHERE order_no = $3`,
          [reviewer, JSON.stringify(notification), orderNo]
        );

        return res.status(200).json({
          success: true,
          action: "approved",
          orderNo,
          productsIngested: ingested,
          customerNotification: notification,
        });
      }

      // ── reject ──
      await pool.query(
        `UPDATE orders SET
           raw = jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   COALESCE(raw, '{}'::jsonb),
                   '{reviewStatus}',
                   '"rejected"'
                 ),
                 '{reviewedAt}',
                 to_jsonb(NOW()::text)
               ),
               '{reviewedBy}',
               to_jsonb($1::text)
             ),
             '{rejectNote}',
             to_jsonb($2::text)
           ),
           updated_at = NOW()
         WHERE order_no = $3`,
        [reviewer, note, orderNo]
      );

      return res.status(200).json({
        success: true,
        action: "rejected",
        orderNo,
        note,
        hint: "No auto re-token. Damon will handle follow-up manually.",
      });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("[factory-reviews]", err);
    return res.status(500).json({ error: err.message });
  }
}
