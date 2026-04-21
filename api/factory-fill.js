// /api/factory-fill.js
// Public (no-login) endpoint for factory token-based order fill.
// Authorized by opaque random token (stored in _idx_tokens + customers.raw.activeTokens).
//
//   GET  ?token=<tok>             → returns { order, prefill, factory(optional) }
//   POST { token, factoryInfo?, lines: [{qty,unitPrice,cbm,canIssueVat,note?}], acceptedPrefill }
//                                   → updates orders.raw + customers.raw, marks token used

import { getPool, setCors } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, "kb");

let _petCodes = null;
function loadPetCodes() {
  if (_petCodes) return _petCodes;
  try {
    _petCodes = JSON.parse(fs.readFileSync(path.join(KB_DIR, "tax-codes-pet.json"), "utf8")).codes || [];
  } catch (e) { _petCodes = []; }
  return _petCodes;
}

function tokenize(str) {
  if (!str) return [];
  const cleaned = String(str).toLowerCase().replace(/[0-9]+/g, " ").trim();
  const zh = (cleaned.match(/[\u4e00-\u9fa5]/g) || []);
  const en = (cleaned.match(/[a-z]+/g) || []).filter(w => w.length >= 2);
  return [...new Set([...zh, ...en])];
}

function prefillFromHint(itemHint) {
  const codes = loadPetCodes();
  const toks = tokenize(itemHint || "宠物用品");
  const scored = codes.map(c => {
    const blob = [c.name, c.shortName, c.keywords, c.description, c.customsName].filter(Boolean).join(" ").toLowerCase();
    let hits = 0;
    for (const t of toks) if (blob.includes(t)) hits++;
    return { c, s: hits * 10 + c.code.replace(/0+$/, "").length * 0.1 };
  }).filter(x => x.s > 0).sort((a,b) => b.s - a.s);

  // Fallback: 宠物专用品
  const top = (scored[0] && scored[0].c) || codes.find(c => c.code === "1060513040000000000") || null;
  if (!top) return null;
  const vatRaw = (top.vatRate || "").replace(/[^0-9.]/g, "");
  const vatNum = vatRaw ? parseFloat(vatRaw) / 100 : 0.13;
  return {
    taxCode: top.code,
    taxCodeName: top.name,
    invoiceName: top.shortName || top.name,
    vatRate: vatNum || 0.13,
    vatRateSource: vatNum ? "gov_tax_code_table_v32" : "sanlyn_default_13pct",
    hsHint: top.hsHint || null,
    alternatives: scored.slice(0, 4).map(x => ({
      taxCode: x.c.code,
      taxCodeName: x.c.name,
      invoiceName: x.c.shortName || x.c.name,
    })),
  };
}

async function findTokenContext(pool, token) {
  // 1. reverse-index lookup
  const tr = await pool.query(
    "SELECT company_code, purpose, expires_at FROM _idx_tokens WHERE token=$1",
    [token]
  );
  if (tr.rows.length === 0) return { error: "token_not_found" };
  const { company_code, expires_at } = tr.rows[0];
  if (new Date(expires_at) < new Date()) return { error: "token_expired" };

  // 2. load factory row (may be a stub "pending" factory for new-factory case)
  const fr = await pool.query(
    "SELECT company_code, name_cn, name_en, tax_id, phone_e164, raw FROM customers WHERE company_code=$1",
    [company_code]
  );
  const factory = fr.rows[0] || null;

  // 3. find the token record inside customers.raw.activeTokens
  const tokens = (factory && factory.raw && Array.isArray(factory.raw.activeTokens)) ? factory.raw.activeTokens : [];
  const trec = tokens.find(t => t.token === token) || null;
  const alreadyUsed = !!(trec && trec.usedAt);

  // 4. load the referenced order
  let order = null;
  if (trec && trec.orderNo) {
    const or = await pool.query(
      "SELECT order_no, company_code, company_name_cn, brand, factory, total_qty, total_amount, declare_amount, vat_rate, currency, products, raw, status FROM orders WHERE order_no=$1",
      [trec.orderNo]
    );
    order = or.rows[0] || null;
  }

  return { factory, tokenRecord: trec, order, company_code, alreadyUsed };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();

  try {
    // ── GET: fetch context + prefill ─────────────────────────
    if (req.method === "GET") {
      const token = (req.query.token || req.query.t || "").trim();
      if (!token) return res.status(400).json({ error: "token required" });
      const ctx = await findTokenContext(pool, token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      // Single-use: if token already submitted, block (except lookup sub-action)
      if (ctx.alreadyUsed && !req.query.lookupTaxId) {
        return res.status(410).json({ error: "token_used", message: "此链接已提交过，如需修改请联系客户重新发送。" });
      }

      // ── Optional: quick-login lookup by tax id ──
      // If factory already has a Sanlyn profile under this taxId,
      // return read-only identity so they don't re-enter.
      const lookupTaxId = (req.query.lookupTaxId || "").trim();
      if (lookupTaxId) {
        if (lookupTaxId.length !== 18) {
          return res.status(400).json({ error: "taxId must be 18 chars" });
        }
        const lr = await pool.query(
          "SELECT company_code, name_cn, phone_e164, address FROM customers WHERE tax_id=$1 LIMIT 1",
          [lookupTaxId]
        );
        // 信息泄漏防护：不区分 matched/unmatched 文案，但前端需要此区分来决定UI流程
        // (若未来需要彻底防枚举，可改为统一返回 matched:false 并要求 phone 辅助校验)
        if (lr.rows.length === 0) {
          return res.status(200).json({ success: true, matched: false });
        }
        const hit = lr.rows[0];
        return res.status(200).json({
          success: true,
          matched: true,
          factory: {
            companyCode: hit.company_code,
            nameCN:      hit.name_cn,
            taxId:       lookupTaxId,
            phone:       hit.phone_e164,
            address:     hit.address,
          },
        });
      }

      // Build prefill from order's product hint (or generic)
      let itemHint = "宠物用品";
      if (ctx.order && Array.isArray(ctx.order.products) && ctx.order.products[0]) {
        itemHint = ctx.order.products[0].productName || ctx.order.products[0].desc || itemHint;
      } else if (ctx.tokenRecord && Array.isArray(ctx.tokenRecord.skuLines) && ctx.tokenRecord.skuLines[0]) {
        itemHint = ctx.tokenRecord.skuLines[0].desc || itemHint;
      }
      const prefill = prefillFromHint(itemHint);

      // Strip sensitive: hide customer identity AND brand (brand可能泄漏客户品牌)
      // 只返回订单号 + 币种，产品明细工厂自己填
      const safeOrder = ctx.order ? {
        orderNo: ctx.order.order_no,
        currency: ctx.order.currency,
        // brand / total_qty / products / customer_name_* intentionally omitted
      } : null;

      return res.status(200).json({
        success: true,
        token,
        order: safeOrder,
        factory: ctx.factory ? {
          companyCode: ctx.factory.company_code,
          nameCN: ctx.factory.name_cn,
          taxId: ctx.factory.tax_id,
          phone: ctx.factory.phone_e164,
          isRegistered: !!ctx.factory.tax_id,
        } : null,
        prefill,
        expiresAt: ctx.tokenRecord?.expiresAt,
      });
    }

    // ── POST: factory submits ────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};
      const token = (body.token || "").trim();
      if (!token) return res.status(400).json({ error: "token required" });
      const ctx = await findTokenContext(pool, token);
      if (ctx.error) return res.status(404).json({ error: ctx.error });
      // Single-use enforcement: reject if token already consumed
      if (ctx.alreadyUsed) {
        return res.status(410).json({
          error: "token_used",
          message: "此链接已提交过。如需修改请联系 Sanlyn 或客户重新发送新链接。",
        });
      }

      // Reverse-validate recognizedFactory: client can't spoof arbitrary companyCode
      if (body.recognizedFactory && body.recognizedFactory.companyCode) {
        const claimedCode = body.recognizedFactory.companyCode;
        const claimedTaxId = body.recognizedFactory.taxId;
        if (!claimedTaxId || String(claimedTaxId).length !== 18) {
          return res.status(400).json({ error: "recognizedFactory.taxId invalid" });
        }
        const vr = await pool.query(
          "SELECT 1 FROM customers WHERE company_code=$1 AND tax_id=$2 LIMIT 1",
          [claimedCode, claimedTaxId]
        );
        if (vr.rows.length === 0) {
          return res.status(400).json({ error: "recognizedFactory verification failed" });
        }
      }

      const lines = Array.isArray(body.lines) ? body.lines : [];
      if (lines.length === 0) return res.status(400).json({ error: "at least one line required" });

      // Sanity caps: reject obviously bogus inputs
      for (const l of lines) {
        const q = parseFloat(l.qty) || 0;
        const p = parseFloat(l.unitPrice) || 0;
        const c = parseFloat(l.cbm) || 0;
        if (q < 0 || q > 1e7)       return res.status(400).json({ error: "qty out of range (0 – 10,000,000)" });
        if (p < 0 || p > 1e6)       return res.status(400).json({ error: "unitPrice out of range (0 – 1,000,000)" });
        if (c < 0 || c > 1e5)       return res.status(400).json({ error: "cbm out of range" });
      }

      // Compute aggregates
      let totalQty = 0, totalSubtotal = 0, totalCBM = 0;
      for (const l of lines) {
        const q = parseFloat(l.qty) || 0;
        const p = parseFloat(l.unitPrice) || 0;
        const c = parseFloat(l.cbm) || 0;
        totalQty += q;
        totalSubtotal += q * p;
        totalCBM += c;
      }
      const taxRate = parseFloat(body.taxRate) || 0.13;
      const grossAmount = +(totalSubtotal * (1 + taxRate)).toFixed(2);
      const containerHint = totalCBM >= 70 ? "full_container_fcl"
                          : totalCBM >= 30 ? "lcl_large"
                          : "lcl";

      // Compute response sequence and contract number
      const prevResponses = (ctx.order && ctx.order.raw && Array.isArray(ctx.order.raw.factoryResponses))
        ? ctx.order.raw.factoryResponses.length : 0;
      const seq = prevResponses + 1;
      const contractNo = ctx.order
        ? `FC-${ctx.order.order_no}-R${seq}`
        : `FC-${ctx.company_code}-${Date.now().toString(36).toUpperCase()}`;

      // Audit metadata
      const clientIp = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim();
      const userAgent = (req.headers["user-agent"] || "").slice(0, 200);

      const factoryResponse = {
        contractNo,
        submittedAt: new Date().toISOString(),
        audit: { ip: clientIp || null, userAgent: userAgent || null },
        lines: lines.map(l => ({
          productName:   l.productName || l.desc || null,
          qty:           parseFloat(l.qty) || 0,
          unitPrice:     parseFloat(l.unitPrice) || 0,
          cbm:           parseFloat(l.cbm) || 0,
          subtotal:      +((parseFloat(l.qty) || 0) * (parseFloat(l.unitPrice) || 0)).toFixed(2),
          canIssueVat:   !!l.canIssueVat,
          note:          l.note || null,
        })),
        summary: {
          totalQty,
          totalSubtotal: +totalSubtotal.toFixed(2),
          totalCBM: +totalCBM.toFixed(3),
          taxRate,
          grossAmount,
          containerHint,
          currency: body.currency || "CNY",
        },
        acceptedPrefill: body.acceptedPrefill !== false,
        prefillOverrides: body.prefillOverrides || null,
        factoryInfo: body.factoryInfo || null,   // 新工厂第一次填营业执照时走这
        delivery: body.delivery || null,          // { earliest, promised, leadNote }
        note: body.note || null,
      };

      // If factory used 快速登录 to identify themselves, link the stub to the real factory
      // (keeps the stub company_code for audit, but marks raw.linkedTo for Damon review)
      if (body.recognizedFactory && body.recognizedFactory.companyCode && ctx.factory) {
        await pool.query(
          `UPDATE customers SET
             raw = raw || jsonb_build_object('linkedTo', $1::text, 'linkedVia', 'quickLogin', 'linkedAt', NOW()::text),
             updated_at = NOW()
           WHERE company_code = $2`,
          [body.recognizedFactory.companyCode, ctx.factory.company_code]
        );
      }

      // If this is a NEW factory (stub CN-* w/o tax_id), update their profile
      if (body.factoryInfo && ctx.factory && !ctx.factory.tax_id) {
        const fi = body.factoryInfo;
        await pool.query(
          `UPDATE customers SET
             name_cn=COALESCE($1, name_cn),
             tax_id=COALESCE($2, tax_id),
             phone_e164=COALESCE($3, phone_e164),
             address=COALESCE($4, address),
             raw = raw || $5::jsonb,
             updated_at=NOW()
           WHERE company_code=$6`,
          [
            fi.nameCN || null,
            fi.taxId || null,
            fi.phone ? (fi.phone.startsWith("+") ? fi.phone : "+86" + fi.phone.replace(/\D/g, "")) : null,
            fi.address || null,
            JSON.stringify({ businessLicense: fi }),
            ctx.factory.company_code,
          ]
        );
      }

      // Append to order.raw.factoryResponses[], status → pending_damon_review
      if (ctx.order) {
        await pool.query(
          `UPDATE orders SET
             raw = jsonb_set(
               jsonb_set(
                 COALESCE(raw, '{}'::jsonb),
                 '{factoryResponses}',
                 COALESCE(raw->'factoryResponses', '[]'::jsonb) || $1::jsonb
               ),
               '{reviewStatus}',
               '"pending_damon_review"'
             ),
             production_status = 'factory_confirmed',
             updated_at = NOW()
           WHERE order_no=$2`,
          [JSON.stringify(factoryResponse), ctx.order.order_no]
        );
      }

      // Mark token used on customers.raw (don't delete — keep audit trail)
      await pool.query(
        `UPDATE customers SET raw = jsonb_set(
           raw,
           '{activeTokens}',
           (
             SELECT COALESCE(jsonb_agg(
               CASE WHEN t->>'token' = $1
                    THEN t || jsonb_build_object('usedAt', NOW()::text, 'lastResponseAt', NOW()::text)
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
        message: "Factory submission received. Awaiting Sanlyn review.",
        contractNo,
        summary: factoryResponse.summary,
        warnings: factoryResponse.summary.containerHint === "full_container_fcl"
          ? ["CBM ≥ 70 → 整柜 (FCL)，运费按整柜报价"]
          : [],
      });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("[factory-fill]", err);
    return res.status(500).json({ error: err.message });
  }
}
