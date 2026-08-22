// ══════════════════════════════════════════════════════════
// /api/db/templates-preview-context — template preview demo context
// GET ?doc_type=xx → returns a documents preview URL without short token
// ══════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";

const DOC_TYPES = new Set(["pi", "iv", "pl", "sc", "cn", "po", "so", "dn", "sq", "bl", "co", "vc", "fe", "cs", "other"]);

function normalizeDocType(docType) {
  if (!docType) return null;
  const value = String(docType).trim().toLowerCase();
  return DOC_TYPES.has(value) ? value : false;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  const docType = normalizeDocType(req.query.doc_type);
  if (!docType) return res.status(400).json({ success: false, error: "invalid doc_type" });

  const pool = getPool();
  try {
    if (docType === "cn") {
      const { rows } = await pool.query(
        `SELECT cn_no
         FROM credit_notes
         ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT 1`
      );
      if (!rows.length) return res.json({ success: false, error: "no_demo_order" });
      const id = rows[0].cn_no;
      return res.json({
        success: true,
        doc_type: docType,
        order_id: id,
        preview_url: "/api/db/documents?type=" + encodeURIComponent(docType) + "&id=" + encodeURIComponent(id),
      });
    }

    const { rows } = await pool.query(
      `SELECT order_no
       FROM orders
       WHERE status NOT IN ('cancelled','draft')
         AND products IS NOT NULL
         AND jsonb_array_length(products) > 0
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`
    );
    if (!rows.length) return res.json({ success: false, error: "no_demo_order" });
    const id = rows[0].order_no;
    return res.json({
      success: true,
      doc_type: docType,
      order_id: id,
      preview_url: "/api/db/documents?type=" + encodeURIComponent(docType) + "&id=" + encodeURIComponent(id),
    });
  } catch (err) {
    console.error("[templates-preview-context]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
