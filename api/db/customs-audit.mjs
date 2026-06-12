import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const SOURCE = "customs-audit-v1";
const OSS_HOST = "sanlyn-files.oss-cn-hongkong.aliyuncs.com";
const PUBLIC_HOST = "files.sanlynos.com";

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString("utf8")) : {};
    if (typeof req.body === "object" && req.body !== null) return req.body;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function nowIso() {
  return new Date().toISOString();
}

function makeAudit(status, issues, extra = {}) {
  const hasBlock = issues.some(i => i.level === "block");
  const verdict = status === "failed_open" ? "diff" : (issues.length ? "diff" : "pass");
  return {
    status,
    verdict,
    blocked: hasBlock,
    diffCount: issues.length,
    issues,
    source: SOURCE,
    checkedAt: nowIso(),
    ...extra,
  };
}

function issue(level, field, note) {
  return { level, field, note };
}

async function writeAudit(pool, body, aiAudit) {
  const { docId, docType, url } = body || {};
  if (!docId || !docType || !url) return;

  await pool.query(
    `UPDATE document_uploads
       SET review_meta = COALESCE(review_meta, '{}'::jsonb)
         || jsonb_build_object('aiAudit', $1::jsonb)
     WHERE doc_id = $2 AND doc_type = $3 AND url = $4`,
    [JSON.stringify(aiAudit), docId, docType, url]
  );
}

async function respondAudit(res, pool, body, aiAudit) {
  try {
    await writeAudit(pool, body, aiAudit);
  } catch (err) {
    aiAudit.issues.push(issue("warn", "review_meta", `AI审核结果写回失败: ${err.message}`));
    aiAudit.diffCount = aiAudit.issues.length;
    aiAudit.verdict = "diff";
  }
  return res.status(200).json({ ok: true, aiAudit });
}

async function failedOpen(res, pool, body, field, note) {
  const aiAudit = makeAudit("failed_open", [issue("block", field, note)]);
  return respondAudit(res, pool, body, aiAudit);
}

async function fetchPdfText(url) {
  const fetchUrl = String(url || "").replace(PUBLIC_HOST, OSS_HOST);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  try {
    const r = await fetch(fetchUrl, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`PDF下载失败 HTTP ${r.status}`);
    const ab = await r.arrayBuffer();
    const parsed = await pdfParse(Buffer.from(ab));
    return String(parsed?.text || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBlNo(pool, body) {
  const direct = clean(body?.blNo);
  if (direct) return direct;

  const key = clean(body?.contractNo) || clean(body?.docId);
  if (!key) return null;

  const { rows } = await pool.query(
    `SELECT bl_no
       FROM orders
      WHERE bl_no = $1 OR contract_no = $1 OR order_no = $1
      LIMIT 1`,
    [key]
  );
  return clean(rows[0]?.bl_no);
}

async function fetchConsolidated(blNo, authHeader) {
  const url = `http://127.0.0.1:9000/api/db/customs-consolidated?bl_no=${encodeURIComponent(blNo)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: authHeader ? { Authorization: authHeader } : {},
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`customs-consolidated HTTP ${r.status}`);
    const data = await r.json();
    if (!data?.success || !Array.isArray(data.lines)) throw new Error(data?.error || "customs-consolidated返回无效");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function queryConsolidatedFallback(pool, blNo) {
  const { rows } = await pool.query(
    `SELECT
        COALESCE(NULLIF(oli.declaration_name, ''), NULLIF(p.declaration_name, ''), oli.product_name, oli.sku) AS declaration_name,
        COALESCE(NULLIF(oli.hs_code, ''), NULLIF(p.hs_code, '')) AS hs_code,
        SUM(COALESCE(oli.qty_ctn, 0))::numeric AS ctn,
        SUM(
          CASE
            WHEN COALESCE(oli.declare_amount_per_box, 0) > 0
              THEN COALESCE(oli.declare_amount_per_box, 0) * COALESCE(oli.qty_ctn, 0)
            WHEN COALESCE(oli.subtotal, 0) > 0
              THEN COALESCE(oli.subtotal, 0)
            ELSE 0
          END
        )::numeric AS declared_amount,
        SUM(
          CASE
            WHEN COALESCE(oli.subtotal, 0) > 0
              THEN COALESCE(oli.subtotal, 0)
            ELSE COALESCE(oli.unit_price, 0) * COALESCE(oli.qty_ctn, 0)
          END
        )::numeric AS customer_amount,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.factory_city), NULL) AS cities
       FROM orders o
       JOIN order_line_items oli ON oli.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT declaration_name, hs_code, factory_city
           FROM products
          WHERE sku = oli.sku
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 1
       ) p ON TRUE
      WHERE o.bl_no = $1
      GROUP BY 1, 2
      ORDER BY SUM(COALESCE(oli.qty_ctn, 0)) DESC`,
    [blNo]
  );

  const lines = rows.map(r => ({
    declaration_name: r.declaration_name || null,
    hs_code: normalizeHs(r.hs_code),
    ctn: num(r.ctn),
    declared_amount: round2(num(r.declared_amount)),
    customer_amount: round2(num(r.customer_amount)),
    factories: Array.isArray(r.cities) ? r.cities.filter(Boolean).map(c => `(${c})`) : [],
    cities: Array.isArray(r.cities) ? r.cities.filter(Boolean) : [],
  }));

  const totals = lines.reduce((acc, r) => {
    acc.ctn += num(r.ctn);
    acc.declared_amount += num(r.declared_amount);
    acc.customer_amount += num(r.customer_amount);
    return acc;
  }, { ctn: 0, declared_amount: 0, customer_amount: 0 });

  totals.ctn = round2(totals.ctn);
  totals.declared_amount = round2(totals.declared_amount);
  totals.customer_amount = round2(totals.customer_amount);

  return { success: true, bl_no: blNo, lines, totals };
}

async function getSystemTruth(pool, blNo, authHeader) {
  try {
    return await fetchConsolidated(blNo, authHeader);
  } catch (_err) {
    return queryConsolidatedFallback(pool, blNo);
  }
}

function clean(v) {
  const s = String(v || "").trim();
  return s || null;
}

function num(v) {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

function normalizeHs(v) {
  const s = String(v || "").replace(/[^\d]/g, "");
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function validHs(hs) {
  if (!/^\d{10}$/.test(hs)) return false;
  const chapter = parseInt(hs.slice(0, 2), 10);
  return chapter >= 1 && chapter <= 97;
}

function normalizeCity(v) {
  return String(v || "")
    .replace(/省|市|自治区|特别行政区|地区|盟/g, "")
    .trim();
}

function extractCity(line) {
  const coded = line.match(/[（(]\s*\d{4,6}\s*[)）]\s*([\u4e00-\u9fa5]{2,12})/);
  if (coded) return normalizeCity(coded[1]);

  const city = line.match(/([\u4e00-\u9fa5]{2,12})市/);
  if (city) return normalizeCity(city[1]);

  return null;
}

function extractCtn(line, hsIndex) {
  const start = Math.max(0, hsIndex - 80);
  const end = Math.min(line.length, hsIndex + 160);
  const near = line.slice(start, end);
  const m = near.match(/([\d,]+(?:\.\d+)?)\s*箱/);
  return m ? num(m[1]) : null;
}

function extractAmount(line, hsIndex) {
  const start = Math.max(0, hsIndex - 120);
  const end = Math.min(line.length, hsIndex + 220);
  const near = line.slice(start, end);

  const labeled = near.match(/(?:总价|金额|人民币|CNY|RMB)[^\d]{0,12}([\d,]+(?:\.\d+)?)/i);
  if (labeled) return num(labeled[1]);

  const beforeCurrency = near.match(/([\d,]+(?:\.\d+)?)\s*(?:人民币|元|CNY|RMB)/i);
  if (beforeCurrency) return num(beforeCurrency[1]);

  const nums = [...near.matchAll(/(?<!\d)(\d{2,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)(?!\d)/g)]
    .map(m => num(m[1]))
    .filter(n => n > 0);
  return nums.length ? nums[nums.length - 1] : null;
}

function extractName(line, hsIndex) {
  const left = line.slice(0, hsIndex).replace(/[^\u4e00-\u9fa5A-Za-z0-9（）()\s]/g, " ").trim();
  const zhRuns = left.match(/[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9（）()\s]{1,30}$/);
  if (!zhRuns) return null;
  return zhRuns[0].replace(/\s+/g, "").slice(-24) || null;
}

function parseCustomsLines(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    const hsMatches = [...line.matchAll(/(?<![\d（(])(\d{10})(?![\d/／])/g)];
    for (const m of hsMatches) {
      const hs = m[1];
      if (!validHs(hs)) continue;

      const key = `${hs}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        hs_code: hs,
        hs_prefix4: hs.slice(0, 4),
        ctn: extractCtn(line, m.index || 0),
        amount: extractAmount(line, m.index || 0),
        city: extractCity(line),
        declaration_name: extractName(line, m.index || 0),
        raw: line,
      });
    }
  }

  return out;
}

function systemCities(line) {
  const set = new Set();

  if (Array.isArray(line?.cities)) {
    for (const c of line.cities) if (c) set.add(normalizeCity(c));
  }

  if (line?.factory_city) set.add(normalizeCity(line.factory_city));

  if (Array.isArray(line?.factories)) {
    for (const f of line.factories) {
      const m = String(f).match(/[（(]([^()（）]+)[)）]/);
      if (m) set.add(normalizeCity(m[1]));
    }
  }

  return [...set].filter(Boolean);
}

function hsSet(lines) {
  return new Set(lines.map(l => normalizeHs(l.hs_code)).filter(Boolean));
}

function hasHsIntersection(aLines, bLines) {
  const a = hsSet(aLines);
  const b = hsSet(bLines);
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function matchSystemLine(docLine, sysLines) {
  return sysLines.find(s => normalizeHs(s.hs_code)?.slice(0, 4) === docLine.hs_prefix4) || null;
}

function amountLabel(v) {
  return round2(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function compareLines(docLines, sysLines, sysTotals) {
  const issues = [];

  if (!docLines.length) {
    issues.push(issue("block", "pdf_text", "未能从核对件识别到有效HS编码,请人工核"));
    return issues;
  }

  if (!sysLines.length) {
    issues.push(issue("block", "system_lines", "系统未取到该票报关明细,无法自动核验"));
    return issues;
  }

  if (!hasHsIntersection(docLines, sysLines)) {
    issues.push(issue("block", "goods", "报关单货物与本票订单不符"));
    return issues;
  }

  for (const docLine of docLines) {
    const sysLine = matchSystemLine(docLine, sysLines);
    if (!sysLine) {
      issues.push(issue("warn", "hs_code", `核对件HS ${docLine.hs_code} 未匹配到系统HS前4位,需人工确认`));
      continue;
    }

    const declared = num(sysLine.declared_amount); // 用系统申报值(可靠),不用PDF抽取(会误把HS当金额)
    const customer = num(sysLine.customer_amount);
    if (customer > 0 && declared > customer + 0.01) {
      issues.push(issue(
        "block",
        "amount",
        `申报金额${amountLabel(declared)}>客户销售价${amountLabel(customer)},退税风险`
      ));
    }

    const docCity = normalizeCity(docLine.city);
    const cities = systemCities(sysLine);
    if (docCity && cities.length && !cities.includes(docCity)) {
      issues.push(issue(
        "warn",
        "domestic_source_city",
        `境内货源地 核对件${docCity} vs 系统${cities.join("/")},需统一`
      ));
    } else if (docCity && !cities.length) {
      issues.push(issue("warn", "domestic_source_city", `境内货源地 核对件${docCity} vs 系统未配置,需统一`));
    }
  }

  const totalDeclared = num(sysTotals?.declared_amount); // 用系统合计申报值
  const totalCustomer = num(sysTotals?.customer_amount);
  if (totalCustomer > 0 && totalDeclared > totalCustomer + 0.01) {
    issues.push(issue(
      "block",
      "amount_total",
      `申报金额${amountLabel(totalDeclared)}>客户销售价${amountLabel(totalCustomer)},退税风险`
    ));
  }

  return issues;
}

async function getOrderIdsForBl(pool, blNo) {
  const { rows } = await pool.query(
    `SELECT order_no, contract_no FROM orders WHERE bl_no = $1 OR order_no = $1 OR contract_no = $1`,
    [blNo]
  );
  return rows.flatMap(r => [r.order_no, r.contract_no]).filter(Boolean);
}

function needsQuarantineByHs(lines) {
  return lines.some(l => {
    const hs = normalizeHs(l.hs_code) || "";
    return hs.startsWith("2309") || hs.startsWith("0511") || hs.startsWith("1404");
  });
}

async function hasQuarantineByProductFlag(pool, blNo) {
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM orders o
         JOIN order_line_items oli ON oli.order_id = o.id
         LEFT JOIN products p ON p.sku = oli.sku
        WHERE o.bl_no = $1
          AND p.quarantine_required = TRUE
        LIMIT 1`,
      [blNo]
    );
    return rows.length > 0;
  } catch (_err) {
    return false;
  }
}

async function hasQuarantineDoc(pool, blNo, orderIds) {
  const keys = [blNo, ...orderIds.map(String)].filter(Boolean);
  if (!keys.length) return false;

  const { rows } = await pool.query(
    `SELECT 1
       FROM document_uploads
      WHERE doc_type IN ('quarantine_report', 'vet_health')
        AND (
          doc_id = ANY($1)
          OR COALESCE(review_meta->>'blNo', review_meta->>'bl_no', review_meta->>'orderId', review_meta->>'order_id') = ANY($1)
        )
      LIMIT 1`,
    [keys]
  );
  return rows.length > 0;
}

async function quarantineIssues(pool, blNo, sysLines) {
  const requiredByHs = needsQuarantineByHs(sysLines);
  const requiredByFlag = await hasQuarantineByProductFlag(pool, blNo);
  if (!requiredByHs && !requiredByFlag) return [];

  const orderIds = await getOrderIdsForBl(pool, blNo);
  const exists = await hasQuarantineDoc(pool, blNo, orderIds);
  if (exists) return [];

  return [issue("block", "quarantine_report", "缺对应检疫报告,不可提交")];
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pool = getPool();
  let body = {};

  try {
    body = await readBody(req);
  } catch (err) {
    return failedOpen(res, pool, body, "body", `请求体读取失败: ${err.message}`);
  }

  try {
    if (!body?.url) return failedOpen(res, pool, body, "url", "缺少核对件PDF URL,无法自动审核");
    if (!body?.docId || !body?.docType) return failedOpen(res, pool, body, "document", "缺少docId/docType,无法写回审核结果");

    let text = "";
    try {
      text = await fetchPdfText(body.url);
    } catch (err) {
      return failedOpen(res, pool, body, "pdf", `核对件PDF读取失败: ${err.message}`);
    }

    if (!text) {
      return failedOpen(res, pool, body, "pdf_text", "扫描件无法自动审核,请人工核");
    }

    const blNo = await resolveBlNo(pool, body);
    if (!blNo) {
      return failedOpen(res, pool, body, "bl_no", "无法解析BL号,请人工核");
    }

    let systemData;
    try {
      systemData = await getSystemTruth(pool, blNo, req.headers.authorization || "");
    } catch (err) {
      return failedOpen(res, pool, body, "system_truth", `系统真值读取失败: ${err.message}`);
    }

    const docLines = parseCustomsLines(text);
    const sysLines = Array.isArray(systemData?.lines) ? systemData.lines : [];
    const issues = [
      ...compareLines(docLines, sysLines, systemData?.totals || {}),
      ...(await quarantineIssues(pool, blNo, sysLines)),
    ];

    const hasBlock = issues.some(i => i.level === "block");
    const status = issues.length ? "diff" : "passed";
    const aiAudit = makeAudit(status, issues, {
      verdict: issues.length ? "diff" : "pass",
      blocked: hasBlock,
    });

    return respondAudit(res, pool, body, aiAudit);
  } catch (err) {
    return failedOpen(res, pool, body, "audit", `自动审核异常: ${err.message}`);
  }
}
