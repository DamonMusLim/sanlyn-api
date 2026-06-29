import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { buildInvoiceBData } from "./freight-invoice-b-data.js";
import { renderInvoiceB } from "./templates/freight-invoice-b.js";

function roleAllowed(role) {
  return role === "admin" || role === "finance";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed", allowed: ["GET"] });
  }

  if (!requireAuth(req, res)) return;
  if (!roleAllowed(req.user?.role)) {
    return res.status(403).json({ error: "Forbidden: admin or finance role required" });
  }

  const bl_no = String(req.query.bl_no || "").trim();
  if (!bl_no) return res.status(400).json({ error: "bl_no required" });

  try {
    const pool = getPool();
    const data = await buildInvoiceBData(pool, {
      bl_no,
      seller_company_code: req.query.seller_company_code,
    });

    if (String(req.query.format || "").toLowerCase() === "json") {
      return res.status(200).json({ success: true, data });
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderInvoiceB(data));
  } catch (err) {
    console.error("[freight-invoice-b] GET error:", err);
    return res.status(500).json({ error: "Internal server error", detail: err.message });
  }
}
