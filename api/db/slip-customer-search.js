// Customer-scoped shipment search for bank slip upload links.
// Public token via ?k=, but customer is always a required server-side filter.
import { getPool, setCors } from "../db.js";
import { searchCustomerShipments } from "./slip-ocr.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method not allowed" });

  const KEY = process.env.SLIP_UPLOAD_KEY || "";
  const k = (req.query && req.query.k) || "";
  if (!KEY || k !== KEY) return res.status(403).json({ ok: false, error: "链接无效或已停用" });

  const action = req.query?.action || "";
  if (action !== "search") return res.status(400).json({ ok: false, error: "unsupported action" });

  const customer = String(req.query?.customer || "").trim();
  if (!customer) return res.status(400).json({ ok: false, error: "customer参数必填" });

  try {
    const rows = await searchCustomerShipments(getPool(), customer, req.query?.q || "", 30);
    return res.json({ ok: true, rows });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("[slip-customer-search]", e);
    return res.status(status).json({ ok: false, error: status >= 500 ? "server error" : e.message });
  }
}
