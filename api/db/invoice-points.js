// api/db/invoice-points.js — 发票点数历史库 + 反作弊查询
//
// 功能总览：
//   POST /api/db/invoice-points             — 记录一条工厂报价（内部，factory-fill.js 内部调）
//   GET  /api/db/invoice-points?factoryCode=CN-00064&quarter=2026Q2
//                                           — 查工厂历史加点，含中位数/均值
//   GET  /api/db/invoice-points/ranking?quarter=2026Q2
//                                           — 工厂点数排行（良心/漂浮）
//
// 计算：
//   bareNet (工厂裸价) + pointPct (工厂加点) = invoiceAmt
//   refundAmt = invoiceAmt × refundRate
//   netPoints = refundRate*100 - pointPct - baseMargin(6)
//   status:
//     netPoints >= 3  → green
//     2 <= netPoints < 3 → yellow
//     netPoints < 2   → red (下单阻断)
//     refundRate = 0  → red (直接警示)
//
// 反作弊：每次 POST 后顺便查本厂季度中位数，若当前 pointPct 比中位数高 >1.5 → 打 raw.outlier=true

import { getPool, setCors } from "../db.js";
import { lookupRefundRate } from "./export-refund-lookup.js";

function quarterOf(date = new Date()) {
  const y = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `${y}Q${q}`;
}

export function evaluatePoints({ bareNet, pointPct, refundRate, baseMargin = 6 }) {
  const bn = Number(bareNet) || 0;
  const pp = Number(pointPct) || 0;
  const rr = Number(refundRate) || 0;

  const invoiceAmt = +(bn * (1 + pp / 100)).toFixed(2);
  const refundAmt  = +(invoiceAmt * rr).toFixed(2);
  const netPoints  = +(rr * 100 - pp - baseMargin).toFixed(2);

  let status = "green";
  if (rr === 0)                   status = "red_zero_refund";
  else if (netPoints < 2)         status = "red_low_margin";
  else if (netPoints < 3)         status = "yellow";

  return { invoiceAmt, refundAmt, netPoints, status };
}

async function handleRecord(req, res, pool) {
  if (!req.user || !["admin", "sales", "logistics", "system"].includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const b = req.body || {};
  const required = ["factoryCode", "pointPct"];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      return res.status(400).json({ error: `missing field: ${k}` });
    }
  }

  const hsCode     = (b.hsCode || "").toString();
  const refundInfo = hsCode ? lookupRefundRate(hsCode) : { refundRate: null, color: "gray" };
  const refundRate = refundInfo.refundRate ?? 0;
  const evalRes    = evaluatePoints({
    bareNet: b.bareNet, pointPct: b.pointPct, refundRate, baseMargin: b.baseMargin ?? 6
  });

  // 先查该厂季度中位数
  const quarter = b.quarter || quarterOf();
  const { rows: hist } = await pool.query(
    `SELECT point_pct FROM invoice_point_history
      WHERE factory_code = $1 AND quarter = $2`,
    [b.factoryCode, quarter]
  );
  const median = medianOf(hist.map(r => Number(r.point_pct)));
  const outlier = median !== null && Number(b.pointPct) - median >= 1.5;

  const raw = {
    refundLookup: refundInfo,
    outlier,
    factoryQuarterMedian: median,
    submittedBy: req.user.sub || req.user.account || null
  };

  const { rows } = await pool.query(
    `INSERT INTO invoice_point_history
       (factory_code, factory_name, order_no, customer_code, hs_code, invoice_name,
        bare_net, point_pct, invoice_amt, refund_rate, net_points, base_margin,
        status, quarter, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, created_at`,
    [b.factoryCode, b.factoryName || null, b.orderNo || null, b.customerCode || null,
     hsCode || null, b.invoiceName || null,
     b.bareNet || null, b.pointPct, evalRes.invoiceAmt, refundRate,
     evalRes.netPoints, b.baseMargin ?? 6, evalRes.status, quarter, JSON.stringify(raw)]
  );

  return res.status(200).json({
    success: true, id: rows[0].id, createdAt: rows[0].created_at,
    evaluation: { ...evalRes, refundRate, refundColor: refundInfo.color, refundWarning: refundInfo.warning },
    outlier, factoryQuarterMedian: median
  });
}

async function handleFactoryStats(req, res, pool) {
  if (!req.user) return res.status(401).json({ error: "auth required" });
  const factoryCode = (req.query?.factoryCode || "").toString();
  const quarter = (req.query?.quarter || quarterOf()).toString();
  if (!factoryCode) return res.status(400).json({ error: "factoryCode required" });

  const { rows } = await pool.query(
    `SELECT id, order_no, hs_code, invoice_name, bare_net, point_pct,
            invoice_amt, refund_rate, net_points, status, created_at
       FROM invoice_point_history
      WHERE factory_code = $1 AND quarter = $2
      ORDER BY created_at DESC`,
    [factoryCode, quarter]
  );

  const points = rows.map(r => Number(r.point_pct)).filter(Number.isFinite);
  const median = medianOf(points);
  const avg    = points.length ? +(points.reduce((a,b)=>a+b,0) / points.length).toFixed(2) : null;
  const min    = points.length ? Math.min(...points) : null;
  const max    = points.length ? Math.max(...points) : null;

  res.status(200).json({
    success: true, factoryCode, quarter,
    count: rows.length, median, avg, min, max,
    entries: rows
  });
}

async function handleRanking(req, res, pool) {
  if (!req.user || !["admin", "sales"].includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden: admin/sales only" });
  }
  const quarter = (req.query?.quarter || quarterOf()).toString();
  const { rows } = await pool.query(
    `SELECT factory_code,
            MAX(factory_name) AS factory_name,
            COUNT(*) AS deals,
            ROUND(AVG(point_pct)::numeric, 2) AS avg_point,
            ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY point_pct)::numeric, 2) AS median_point,
            MIN(point_pct) AS min_point,
            MAX(point_pct) AS max_point,
            COUNT(*) FILTER (WHERE status LIKE 'red%') AS red_count,
            COUNT(*) FILTER (WHERE (raw->>'outlier')::boolean = true) AS outlier_count
       FROM invoice_point_history
      WHERE quarter = $1
      GROUP BY factory_code
      ORDER BY median_point ASC NULLS LAST`,
    [quarter]
  );
  res.status(200).json({ success: true, quarter, factories: rows });
}

function medianOf(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(2);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  try {
    // Path routing: the mount is /api/db/invoice-points, sub-path is req.path or req.url
    const subPath = (req.path || req.url || "").split("?")[0];
    if (req.method === "GET" && subPath.endsWith("/ranking")) {
      return handleRanking(req, res, pool);
    }
    if (req.method === "GET")  return handleFactoryStats(req, res, pool);
    if (req.method === "POST") return handleRecord(req, res, pool);
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    console.error("[invoice-points]", e);
    res.status(500).json({ error: e.message });
  }
}
