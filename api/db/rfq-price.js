import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { priceRfq } from "./lib/rfq-pricing.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!requireAuth(req, res)) return;
  const rfqId = (req.body || {}).rfq_id;
  if (!rfqId) return res.status(400).json({ ok: false, error: "rfq_id required" });
  const out = await priceRfq(getPool(), rfqId);
  return res.status(out.error ? 404 : 200).json(out);
}
