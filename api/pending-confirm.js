// /api/pending-confirm.js
// Public (no-login) endpoint for factory pending-date confirmation via share link.
//
//   GET  ?token=<tok>                 → { order, factory, isAgent, readOnly }
//   POST { token, committedDate, stampUrl?, note? }
//                                     → writes orders.raw + flips status to producing,
//                                       marks token single-use.
//
// Token origin: /api/db/pending-token-create (admin-only)
//
// Reuses the same token plumbing as factory-fill.js:
//   - _idx_tokens row with purpose='pending_confirm'
//   - customers.raw.activeTokens[] entry with orderNo + usedAt audit
//
// 代理 vs 自营 branching:
//   isAgentOrder(shipperCompany) decides whether stamp is required.
//   Agent orders (Sanlyn as shipper)  → stampUrl required
//   Self-operated (factory as shipper) → stampUrl optional

import { getPool, setCors } from "./db.js";

// ─── Agent detection — keep in sync with frontend FactoryFinanceTab.OUR_COMPANIES ──
const OUR_COMPANIES = [
  "XIAMEN PET BABY IMPORT AND EXPORT",
  "PET BABY",
  "上海洋宝宝",
  "洋宝宝",
  "富城山凌",
  "建平中砂",
  "厦门巴匕",
  "巴匕",
  "三林进出口",
  "厦门三林",
];
function isAgentOrder(shipperCompany) {
  if (!shipperCompany) return true; // default agent — safer (blocks submit without stamp)
  const upper = String(shipperCompany).toUpperCase();
  return OUR_COMPANIES.some((c) => upper.includes(c.toUpperCase()));
}

async function findTokenContext(pool, token) {
  const tr = await pool.query(
    "SELECT company_code, purpose, expires_at FROM _idx_tokens WHERE token=$1",
    [token]
  );
  if (tr.rows.length === 0) return { error: "token_not_found" };
  const { company_code, purpose, expires_at } = tr.rows[0];
  if (purpose !== "pending_confirm") return { error: "token_wrong_purpose" };
  if (new Date(expires_at) < new Date()) return { error: "token_expired" };

  const fr = await pool.query(
    "SELECT company_code, name_cn, tax_id, raw FROM customers WHERE company_code=$1",
    [company_code]
  );
  const factory = fr.rows[0] || null;
  const tokens =
    factory && factory.raw && Array.isArray(factory.raw.activeTokens)
      ? factory.raw.activeTokens
      : [];
  const trec = tokens.find((t) => t.token === token) || null;
  const alreadyUsed = !!(trec && trec.usedAt);

  let order = null;
  if (trec && trec.orderNo) {
    const or = await pool.query(
      `SELECT order_no, company_code, company_name_cn, customer, brand,
              total_qty, total_amount, currency, products, raw, status
         FROM orders WHERE order_no=$1`,
      [trec.orderNo]
    );
    order = or.rows[0] || null;
  }
  return { factory, tokenRecord: trec, order, company_code, alreadyUsed };
}

function safeOrderView(order) {
  if (!order) return null;
  const raw = order.raw || {};
  const shipper = raw.shipperCompany || raw.shipper || order.company_name_cn || "";
  const agent = isAgentOrder(shipper);
  // Return only what the factory needs to see — hide customer identity + sale price.
  const products = Array.isArray(order.products) ? order.products : [];
  const visibleProducts = products.map((p) => ({
    productName: p.productName || p.desc || p.name || null,
    qty: p.qty || p.quantity || null,
    unit: p.unit || null,
    // unitPrice intentionally omitted
  }));
  return {
    orderNo: order.order_no,
    contractNo: raw.contractNo || raw.piNo || order.order_no,
    subCategory: raw.subCategory || raw.category || null,
    cartons: raw.cartons || raw.packages || null,
    containerType: raw.containerType || null,
    customerDeadline: raw.customerDeadline || raw.requiredArrival || null,
    tradeTerm: raw.tradeTerm || null,
    pol: raw.pol || null,
    currency: order.currency || null,
    isAgent: agent,
    stampRequired: agent, // agent = must stamp; self-op = optional
    contractUrl: raw.contractUrl || raw?.vault?.PO?.url || null,
    products: visibleProducts,
    alreadyCommittedDate: raw.factoryCommittedDate || null,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    // ── GET: read-only lookup ─────────────────────────────
    if (req.method === "GET") {
      const token = (req.query.token || req.query.t || "").trim();
      if (!token) return res.status(400).json({ error: "token required" });
      const ctx = await findTokenContext(pool, token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (ctx.alreadyUsed) {
        return res.status(410).json({
          error: "token_used",
          message: "This link has already been used. Contact Sanlyn for a new one.",
        });
      }
      if (!ctx.order) {
        return res.status(404).json({ error: "order_not_found" });
      }
      return res.status(200).json({
        success: true,
        token,
        order: safeOrderView(ctx.order),
        factory: ctx.factory
          ? {
              companyCode: ctx.factory.company_code,
              nameCN: ctx.factory.name_cn,
              isRegistered: !!ctx.factory.tax_id,
            }
          : null,
        expiresAt: ctx.tokenRecord?.expiresAt,
      });
    }

    // ── POST: factory submits committed date (+ optional stamp) ─────────
    if (req.method === "POST") {
      const body = req.body || {};
      const token = (body.token || "").trim();
      if (!token) return res.status(400).json({ error: "token required" });

      const ctx = await findTokenContext(pool, token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      if (ctx.alreadyUsed) {
        return res.status(410).json({
          error: "token_used",
          message: "This link has already been used.",
        });
      }
      if (!ctx.order) {
        return res.status(404).json({ error: "order_not_found" });
      }

      const committedDate = (body.committedDate || "").trim();
      if (!committedDate || !/^\d{4}-\d{2}-\d{2}$/.test(committedDate)) {
        return res.status(400).json({ error: "committedDate must be YYYY-MM-DD" });
      }
      // Sanity check — no past dates, no more than 1y out
      const d = new Date(committedDate + "T00:00:00Z");
      const now = new Date();
      const oneYear = 365 * 24 * 3600 * 1000;
      if (isNaN(d.getTime()) || d.getTime() < now.getTime() - 24 * 3600 * 1000) {
        return res.status(400).json({ error: "committedDate cannot be in the past" });
      }
      if (d.getTime() > now.getTime() + oneYear) {
        return res.status(400).json({ error: "committedDate too far out" });
      }

      const shipper =
        ctx.order.raw?.shipperCompany ||
        ctx.order.raw?.shipper ||
        ctx.order.company_name_cn ||
        "";
      const agent = isAgentOrder(shipper);
      const stampUrl = (body.stampUrl || "").trim() || null;
      if (agent && !stampUrl && !ctx.order.raw?.contractStamped && !ctx.order.raw?.stampUrl) {
        return res.status(400).json({
          error: "stamp_required",
          message: "Agent orders require a stamped contract upload.",
        });
      }

      const note = (body.note || "").slice(0, 500) || null;
      const clientIp = (
        req.headers["x-forwarded-for"] ||
        req.headers["x-real-ip"] ||
        req.socket?.remoteAddress ||
        ""
      )
        .toString()
        .split(",")[0]
        .trim();
      const userAgent = (req.headers["user-agent"] || "").slice(0, 200);
      const nowIso = new Date().toISOString();

      const pendingResponse = {
        committedDate,
        stampUrl,
        note,
        submittedAt: nowIso,
        submittedVia: "share_link",
        audit: { ip: clientIp || null, userAgent: userAgent || null },
      };

      // Patch orders.raw atomically (merge object + set timestamp)
      const patch = {
        factoryCommittedDate: committedDate,
        factoryPendingResponse: pendingResponse,
        factoryConfirmedAt: nowIso,
      };
      if (stampUrl) {
        patch.contractStamped = true;
        patch.stampUrl = stampUrl;
      }

      await pool.query(
        `UPDATE orders SET
           raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb,
           production_status = 'producing',
           status = COALESCE(NULLIF(status, 'pending_date'), 'producing'),
           updated_at = NOW()
         WHERE order_no = $2`,
        [JSON.stringify(patch), ctx.order.order_no]
      );

      // Mark token used (preserve audit trail; do not delete)
      await pool.query(
        `UPDATE customers SET raw = jsonb_set(
           raw,
           '{activeTokens}',
           (
             SELECT COALESCE(jsonb_agg(
               CASE WHEN t->>'token' = $1
                    THEN t || jsonb_build_object('usedAt', NOW()::text)
                    ELSE t END
             ), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(raw->'activeTokens', '[]'::jsonb)) AS t
           )
         )
         WHERE company_code=$2`,
        [token, ctx.company_code]
      );

      return res.status(200).json({
        success: true,
        message: "Committed date received. Order moved to producing.",
        orderNo: ctx.order.order_no,
        committedDate,
      });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("[pending-confirm]", err);
    return res.status(500).json({ error: err.message });
  }
}
