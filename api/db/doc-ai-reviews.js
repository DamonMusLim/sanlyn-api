// /api/db/doc-ai-reviews.js — DAS AI Smart Review results
// GET  ?docId=...        → latest review for that doc (or null)
// POST { docId, docType, contractNo } → run review + persist
//
// The actual AI/check logic lives in the rules section below — keep it pure
// (no external API calls in v1). Future versions may call Claude/GPT and store
// the response. For now we cross-check fields we already have in `orders.raw`.
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  extractUser(req);

  // ─── GET — latest review for docId ───
  if (req.method === "GET") {
    const docId = req.query.docId;
    if (!docId) return res.status(400).json({ error: "docId required" });
    try {
      const r = await pool.query(
        `SELECT id, doc_id, doc_type, contract_no, status, findings, passed, total,
                reviewed_at, reviewed_by, engine
         FROM doc_ai_reviews
         WHERE doc_id = $1
         ORDER BY reviewed_at DESC
         LIMIT 1`,
        [String(docId)]
      );
      const row = r.rows[0];
      if (!row) return res.status(200).json({ data: null });
      return res.status(200).json({
        data: {
          status: row.status,
          findings: row.findings || [],
          passed: row.passed,
          total: row.total,
          reviewedAt: row.reviewed_at,
          reviewedBy: row.reviewed_by,
          engine: row.engine,
        },
      });
    } catch (err) {
      console.error("[doc-ai-reviews GET]", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ─── POST — run review + persist ───
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { docId, docType, contractNo } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId required" });

    // Pull source order data (the canonical truth for cross-check)
    let order = null;
    if (contractNo) {
      const o = await pool.query(
        "SELECT contract_no, total_amount, currency, raw FROM orders WHERE contract_no = $1 LIMIT 1",
        [contractNo]
      );
      order = o.rows[0] || null;
    }

    // Run rules → list of findings
    const findings = _runRules({ docType, contractNo, order });
    const status = _statusFromFindings(findings);
    const passed = findings.filter((f) => f.level === "ok").length;
    const total = findings.length;

    const ins = await pool.query(
      `INSERT INTO doc_ai_reviews (doc_id, doc_type, contract_no, status, findings, passed, total, reviewed_by, engine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sanlyn-v1')
       RETURNING reviewed_at`,
      [
        String(docId),
        docType || null,
        contractNo || null,
        status,
        JSON.stringify(findings),
        passed,
        total,
        (req.user && req.user.username) || "system",
      ]
    );

    return res.status(200).json({
      data: {
        status,
        findings,
        passed,
        total,
        reviewedAt: ins.rows[0].reviewed_at,
        engine: "sanlyn-v1",
      },
    });
  } catch (err) {
    console.error("[doc-ai-reviews POST]", err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
// Rules engine — v1 stub. Real check logic to be expanded.
// Each rule returns { level: 'high'|'mid'|'low'|'ok', text }
// ═══════════════════════════════════════════════════════════
function _runRules({ docType, contractNo, order }) {
  const out = [];
  const raw = (order && order.raw) || {};

  // Rule 1 — order exists in DB
  if (!order) {
    out.push({ level: "high", text: `Order [[${contractNo || "?"}]] not found in database — cannot cross-check` });
    return out;
  }

  // Rule 2 — Buyer / Seller present
  if (!raw.buyer && !order.company_code) {
    out.push({ level: "mid", text: "Buyer field is empty in order data" });
  } else {
    out.push({ level: "ok", text: "Buyer / Seller present" });
  }

  // Rule 3 — Total amount
  if (!order.total_amount || Number(order.total_amount) <= 0) {
    out.push({ level: "high", text: "Total amount is zero or missing — invoice would be invalid" });
  } else {
    out.push({ level: "ok", text: `Total [[${order.currency || "CNY"} ${order.total_amount}]] looks valid` });
  }

  // Rule 4 — Currency
  if (!order.currency) {
    out.push({ level: "low", text: "Currency not set — defaulted to CNY" });
  } else {
    out.push({ level: "ok", text: "Currency present" });
  }

  // Rule 5 — Payment terms (trade docs only)
  if (["sc","pi","iv","pl","contract","invoice","packingList"].indexOf(docType) >= 0) {
    if (!raw.paymentTerms) {
      out.push({ level: "mid", text: "Payment terms missing — cannot verify TT % vs B/L wording" });
    } else {
      out.push({ level: "ok", text: `Payment terms [[${raw.paymentTerms}]]` });
    }
  }

  // Rule 6 — NW consistency stub (real impl needs to read PL line items)
  // For v1 we just emit a note; v2 will compare across docs.
  if (["sc","pi","iv","pl"].indexOf(docType) >= 0) {
    out.push({ level: "low", text: "NW cross-check across SC / PI / IV / PL — pending v2 implementation" });
  }

  return out;
}

function _statusFromFindings(findings) {
  if (findings.some((f) => f.level === "high")) return "error";
  if (findings.some((f) => f.level === "mid"))  return "warn";
  if (findings.length > 0 && findings.every((f) => f.level === "ok" || f.level === "low")) return "ok";
  return "ok";
}
