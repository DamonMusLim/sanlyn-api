import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function round(n, d) {
  var x = Number(n);
  var p = Math.pow(10, d);
  if (!isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * p) / p;
}

function median(arr) {
  var nums = (arr || [])
    .map(function (v) {
      return Number(v);
    })
    .filter(function (v) {
      return isFinite(v);
    })
    .sort(function (a, b) {
      return a - b;
    });

  var len = nums.length;
  var mid;

  if (!len) return 0;
  mid = Math.floor(len / 2);

  if (len % 2) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function addFinding(findings, severity, sku, lineIndex, field, message, expected, actual) {
  var finding = {
    severity: severity,
    scope: "line",
    sku: sku,
    lineIndex: lineIndex,
    field: field,
    message: message
  };

  if (expected !== undefined) finding.expected = expected;
  if (actual !== undefined) finding.actual = actual;

  findings.push(finding);
}

// 把一条历史 unit_price 归一化成"每个价"，用主数据(salePrice/canonical)当锚识别口径。
// 返回 {piece, confidence} 或 null(无法判定)。解决历史数据每个价/每箱价混存的脏问题。
function normalizeHistPiece(up, hbg, salePrice, canonicalUnitPrice, masterBg) {
  if (!(up > 0) || !(salePrice > 0)) return null;
  var bg = hbg > 0 ? hbg : masterBg;
  if (Math.abs(up - salePrice) / salePrice < 0.05) return { piece: up, confidence: "high" };           // 每个价
  if (canonicalUnitPrice > 0 && Math.abs(up - canonicalUnitPrice) / canonicalUnitPrice < 0.05)
    return { piece: bg > 0 ? up / bg : up, confidence: "high" };                                        // 每箱价
  if (bg > 0 && Math.abs(up / bg - salePrice) / salePrice < 0.05) return { piece: up / bg, confidence: "medium" };
  return null;                                                                                          // 口径不明 → 丢弃
}

export function auditOrderLines(lines, ctx) {
  var safeLines = Array.isArray(lines) ? lines : [];
  var productsBySku = (ctx && ctx.productsBySku) || {};
  var historyQtyBySku = (ctx && ctx.historyQtyBySku) || {};
  var historyPriceBySku = (ctx && ctx.historyPriceBySku) || {};
  var findings = [];
  var canonicalLines = [];
  var stalePriceChecked = {};
  var i;

  for (i = 0; i < safeLines.length; i++) {
    var line = safeLines[i] || {};
    var sku = line.sku == null ? "" : String(line.sku).trim();
    var master = sku ? productsBySku[sku] : null;
    var qty = Number(line.qty);
    var unitPrice = Number(line.unitPrice);
    var subtotal = Number(line.subtotal);
    var salePrice = master ? Number(master.sale_price_cny) : 0;
    var bg = master ? parseInt(master.bg_bx, 10) || 0 : 0;
    var canonicalUnitPrice = salePrice > 0 && bg > 0 ? round(salePrice * bg, 4) : 0;
    var canonicalSubtotal = canonicalUnitPrice > 0 && qty > 0 ? round(canonicalUnitPrice * qty, 2) : 0;
    var arr;
    var m;

    if (!sku) {
      addFinding(findings, "BLOCK", sku, i, "sku", "缺SKU");
    }

    if (!master) {
      addFinding(findings, "BLOCK", sku, i, "sku", "SKU不在产品主数据，无法定价");
    }

    if (master && !(salePrice > 0)) {
      addFinding(findings, "BLOCK", sku, i, "unit_price", "主数据缺单价(sale_price_cny)");
    }

    if (master && bg <= 0) {
      addFinding(findings, "BLOCK", sku, i, "bg_bx", "主数据缺箱规bg_bx");
    }

    if (!(qty > 0) || Math.floor(qty) !== qty) {
      addFinding(findings, "BLOCK", sku, i, "qty", "数量非法(须正整数箱)");
    }

    if (
      unitPrice > 0 &&
      master &&
      salePrice > 0 &&
      bg > 1 &&
      Math.abs(unitPrice - salePrice) / salePrice < 0.05
    ) {
      addFinding(
        findings,
        "BLOCK",
        sku,
        i,
        "unit_price",
        "单价疑似填成【每个】价，应为【每箱】价",
        canonicalUnitPrice,
        unitPrice
      );
    }

    if (
      subtotal > 0 &&
      canonicalSubtotal > 0 &&
      Math.abs(subtotal - canonicalSubtotal) / canonicalSubtotal > 0.01
    ) {
      addFinding(
        findings,
        "WARN",
        sku,
        i,
        "subtotal",
        "小计与主数据重算不符",
        canonicalSubtotal,
        subtotal
      );
    }

    arr = historyQtyBySku[sku] || [];
    if (arr.length >= 3) {
      m = median(arr);
      if (m > 0 && (qty > 3 * m || qty < m / 3)) {
        addFinding(
          findings,
          "WARN",
          sku,
          i,
          "qty",
          "数量异常: 本次" + qty + " vs 历史中位" + m,
          m,
          qty
        );
      }
    }

    // 历史价 → 校验【主数据价是否过期】(归一化成每个价，取干净样本中位，与主数据每个价比；偏离>15%=WARN)。
    // 这是校验 master 本身，不是校验本单(本单价已由 create-v2 按 master 重算)。每个 sku 只查一次。
    if (master && salePrice > 0 && !stalePriceChecked[sku]) {
      stalePriceChecked[sku] = true;
      var hp = historyPriceBySku[sku] || [];
      var pieces = [];
      for (var k = 0; k < hp.length; k++) {
        var norm = normalizeHistPiece(Number(hp[k].unit_price), parseInt(hp[k].bg_bx, 10) || 0, salePrice, canonicalUnitPrice, bg);
        if (norm) pieces.push(norm.piece);
      }
      if (pieces.length >= 3) {
        var medPiece = median(pieces);
        if (medPiece > 0 && Math.abs(salePrice - medPiece) / medPiece > 0.15) {
          addFinding(findings, "WARN", sku, i, "unit_price",
            "主数据单价可能过期：主数据每个¥" + round(salePrice, 4) + " vs 历史每个¥" + round(medPiece, 4),
            round(medPiece, 4), round(salePrice, 4));
        }
      }
    }

    canonicalLines.push({
      sku: sku,
      qty: qty,
      bgBx: bg,
      canonicalUnitPrice: canonicalUnitPrice,
      canonicalSubtotal: canonicalSubtotal,
      priceSource: master ? "master" : "none"
    });
  }

  var blockCount = findings.filter(function (f) {
    return f.severity === "BLOCK";
  }).length;
  var warnCount = findings.filter(function (f) {
    return f.severity === "WARN";
  }).length;
  var infoCount = findings.filter(function (f) {
    return f.severity === "INFO";
  }).length;
  var ok = blockCount === 0;

  return {
    ok: ok,
    canSubmit: ok,
    summary: {
      blockCount: blockCount,
      warnCount: warnCount,
      infoCount: infoCount,
      lineCount: safeLines.length
    },
    findings: findings,
    canonicalLines: canonicalLines
  };
}

export async function runOrderAudit(pool, lines) {
  var safeLines = Array.isArray(lines) ? lines : [];
  var seen = {};
  var skus = [];
  var productsBySku = {};
  var historyQtyBySku = {};
  var i;

  for (i = 0; i < safeLines.length; i++) {
    var sku = safeLines[i] && safeLines[i].sku != null ? String(safeLines[i].sku).trim() : "";
    if (sku && !seen[sku]) {
      seen[sku] = true;
      skus.push(sku);
    }
  }

  if (!skus.length) {
    return auditOrderLines(safeLines, {
      productsBySku: productsBySku,
      historyQtyBySku: historyQtyBySku
    });
  }

  var productSql =
    "SELECT sku, sale_price_cny, factory_price, bg_bx, hs_code, net_weight, gross_weight, cbm, declaration_name, updated_at FROM products WHERE sku = ANY($1) AND active = true";
  var productResult = await pool.query(productSql, [skus]);
  var productRows = productResult.rows || [];

  for (i = 0; i < productRows.length; i++) {
    var row = productRows[i];
    var existing = productsBySku[row.sku];
    var rowTime = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    var existingTime = existing && existing.updated_at ? new Date(existing.updated_at).getTime() : 0;

    if (!existing || rowTime >= existingTime) {
      productsBySku[row.sku] = row;
    }
  }

  var historyPriceBySku = {};
  var historySql =
    "SELECT sku, qty_ctn, unit_price, bg_bx FROM (SELECT oli.sku, oli.qty_ctn, oli.unit_price, oli.bg_bx, row_number() OVER (PARTITION BY oli.sku ORDER BY o.created_at DESC NULLS LAST, oli.id DESC) rn FROM order_line_items oli JOIN orders o ON o.id=oli.order_id WHERE oli.sku = ANY($1) AND oli.qty_ctn > 0) t WHERE rn <= 20";
  var historyResult = await pool.query(historySql, [skus]);
  var historyRows = historyResult.rows || [];

  for (i = 0; i < historyRows.length; i++) {
    var h = historyRows[i];
    if (!historyQtyBySku[h.sku]) historyQtyBySku[h.sku] = [];
    historyQtyBySku[h.sku].push(Number(h.qty_ctn));
    if (Number(h.unit_price) > 0) {
      if (!historyPriceBySku[h.sku]) historyPriceBySku[h.sku] = [];
      historyPriceBySku[h.sku].push({ unit_price: Number(h.unit_price), bg_bx: parseInt(h.bg_bx, 10) || 0 });
    }
  }

  return auditOrderLines(safeLines, {
    productsBySku: productsBySku,
    historyQtyBySku: historyQtyBySku,
    historyPriceBySku: historyPriceBySku
  });
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];

    if (req.body !== undefined) {
      if (typeof req.body === "string") {
        try {
          resolve(req.body ? JSON.parse(req.body) : {});
        } catch (e) {
          reject(e);
        }
        return;
      }

      resolve(req.body || {});
      return;
    }

    req.on("data", function (chunk) {
      chunks.push(chunk);
    });

    req.on("end", function () {
      var raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });

    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (!requireAuth(req, res)) return;

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    var pool = getPool();
    var body = await readJsonBody(req);
    var lines = Array.isArray(body.lines) ? body.lines : null;

    if (!lines && body.order_id) {
      var lineSql =
        "SELECT sku, qty_ctn AS qty, unit_price AS \"unitPrice\", subtotal FROM order_line_items WHERE order_id = $1 ORDER BY id";
      var lineResult = await pool.query(lineSql, [body.order_id]);
      lines = lineResult.rows || [];
    }

    if (!lines) lines = [];

    var result = await runOrderAudit(pool, lines);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
