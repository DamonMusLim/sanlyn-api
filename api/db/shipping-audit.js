// GET /api/db/shipping-audit?bl_no=xxx
// Single-BL doc audit: checks that the shipping plan has all fields required
// for customs/doc export (vessel, containers, orders linked, weights, etc.)
import { getPool, setCors } from "../db.js";

function pick() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];
    if (v !== null && v !== undefined && v !== "" && v !== "-") return v;
  }
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  var blNo = String(req.query.bl_no || "").trim();
  if (!blNo) return res.status(400).json({ error: "bl_no required" });

  const pool = getPool();
  var checks = [];

  try {
    // ── 1. Load shipping plan ──
    var spR = await pool.query(
      "SELECT * FROM shipping_plans WHERE bl_no=$1 ORDER BY created_at DESC LIMIT 1",
      [blNo]
    );

    if (!spR.rows.length) {
      return res.json({
        status: "fail",
        checks: [{ code: "NO_PLAN", severity: "high", message: "未找到该BL的运输计划记录" }],
        summary: "BL " + blNo + " 不存在于 shipping_plans",
      });
    }

    var sp = spR.rows[0];
    var raw = sp.raw || {};
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (e) { raw = {}; } }

    // ── 2. Field presence checks ──
    var vessel = pick(sp.vessel, raw.vessel);
    var voyage = pick(sp.voyage, raw.voyage);
    var pol    = pick(sp.pol, raw.pol);
    var pod    = pick(sp.pod, raw.pod);
    var etd    = pick(sp.etd, sp.shipment_date, raw.etd);
    var ctype  = pick(sp.container_type, raw.containerType);
    var cqty   = pick(sp.container_qty, raw.containerQty);
    var gw     = pick(sp.gross_weight, raw.grossWeight);
    var cbm    = pick(sp.total_cbm, raw.totalCBM);
    var carrier = pick(sp.shipping_line, raw.shippingLine);

    if (!vessel)  checks.push({ code: "NO_VESSEL",    severity: "high", message: "缺船名（vessel），无法生成B/L和报关" });
    if (!voyage)  checks.push({ code: "NO_VOYAGE",    severity: "high", message: "缺航次（voyage）" });
    if (!pol)     checks.push({ code: "NO_POL",       severity: "high", message: "缺装货港（POL）" });
    if (!pod)     checks.push({ code: "NO_POD",       severity: "high", message: "缺目的港（POD）" });
    if (!etd)     checks.push({ code: "NO_ETD",       severity: "high", message: "缺预计开航日（ETD）" });
    if (!ctype)   checks.push({ code: "NO_CTR_TYPE",  severity: "warn", message: "缺箱型（container_type），文档默认40HQ" });
    if (!cqty)    checks.push({ code: "NO_CTR_QTY",   severity: "warn", message: "缺箱量（container_qty）" });
    if (!gw)      checks.push({ code: "NO_GW",        severity: "warn", message: "缺毛重（gross_weight）" });
    if (!cbm)     checks.push({ code: "NO_CBM",       severity: "warn", message: "缺体积（CBM）" });
    if (!carrier) checks.push({ code: "NO_CARRIER",   severity: "warn", message: "缺船公司（shipping_line）" });

    // ── 3. Linked orders check ──
    var orderNos = sp.order_nos || raw.orderNos || raw.order_nos || [];
    if (!Array.isArray(orderNos)) orderNos = [];

    if (orderNos.length === 0) {
      checks.push({ code: "NO_ORDERS", severity: "high", message: "未关联任何订单（order_nos为空），报关资料无法生成" });
    } else {
      // Check if those orders actually exist
      var ordR = await pool.query(
        "SELECT order_no, contract_no, trade_terms, currency, total_amount FROM orders WHERE order_no = ANY($1::text[]) OR contract_no = ANY($1::text[])",
        [orderNos]
      );
      var foundNos = new Set(ordR.rows.flatMap(function(r) { return [r.order_no, r.contract_no].filter(Boolean); }));
      var missing = orderNos.filter(function(n) { return !foundNos.has(n); });
      if (missing.length > 0) {
        checks.push({ code: "ORDERS_NOT_FOUND", severity: "high", message: "以下订单号在orders表中找不到: " + missing.join(", ") });
      }

      // Trade terms consistency
      var terms = [...new Set(ordR.rows.map(function(r) { return r.trade_terms; }).filter(Boolean))];
      if (terms.length > 1) {
        checks.push({ code: "MIXED_INCOTERMS", severity: "warn", message: "关联订单贸易条款不一致: " + terms.join(" / ") });
      }

      // Currency consistency
      var currencies = [...new Set(ordR.rows.map(function(r) { return r.currency; }).filter(Boolean))];
      if (currencies.length > 1) {
        checks.push({ code: "MIXED_CURRENCY", severity: "high", message: "关联订单币种不一致: " + currencies.join(" / ") + "（合并报关需统一币种）" });
      }

      // Zero-amount orders
      var zeroAmt = ordR.rows.filter(function(r) { return !r.total_amount || Number(r.total_amount) === 0; });
      if (zeroAmt.length > 0) {
        checks.push({ code: "ZERO_AMOUNT_ORDER", severity: "warn", message: "以下订单金额为0，申报价值可能有误: " + zeroAmt.map(function(r){ return r.order_no || r.contract_no; }).join(", ") });
      }
    }

    // ── 4. BL number format check ──
    if (!/^[A-Z0-9]{6,30}$/.test(blNo)) {
      checks.push({ code: "BL_FORMAT", severity: "warn", message: "BL号格式异常（期望仅大写字母+数字）: " + blNo });
    }

    // ── 5. Container details cross-check ──
    var containerNos = pick(sp.container_no, raw.containerNo, raw.containers);
    if (!containerNos) {
      checks.push({ code: "NO_CONTAINER_NO", severity: "warn", message: "缺箱号（container_no），多柜报关无法核对" });
    }

    // ── 6. Result ──
    var hasFail = checks.some(function(c) { return c.severity === "high"; });
    var hasWarn = checks.some(function(c) { return c.severity === "warn"; });
    var status  = hasFail ? "fail" : hasWarn ? "warn" : "pass";

    if (checks.length === 0) {
      checks.push({ code: "ALL_OK", severity: "ok", message: "单证关键字段齐全，订单关联正常" });
    }

    var failCount = checks.filter(function(c){ return c.severity === "high"; }).length;
    var warnCount = checks.filter(function(c){ return c.severity === "warn"; }).length;
    var summary = status === "pass"
      ? "BL " + blNo + " 单证核验通过，关联 " + orderNos.length + " 票订单"
      : "BL " + blNo + ": " + failCount + " 项错误 / " + warnCount + " 项警告，关联 " + orderNos.length + " 票订单";

    return res.json({ status, checks, summary });

  } catch (e) {
    console.error("[shipping-audit] failed:", e);
    return res.status(500).json({ error: "shipping audit failed", detail: e.message });
  }
}
