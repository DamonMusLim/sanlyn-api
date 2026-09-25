// GET /api/db/freight-receipts - freight invoice and receipt evidence by ticket.
import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";
import { matchFreight } from "./lib/freight-match.js";
import { loadFreightMatchInput } from "./lib/freight-match-sources.js";

const VERSION = "v2026.09.20-1";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = matchFreight(await loadFreightMatchInput(getPool(), { receivableSource: "bills" }));
    return res.status(200).json({ success: true, version: VERSION, generated_at: new Date().toISOString(), rows });
  } catch (err) {
    console.error("[freight-receipts]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export const __selftest = { loadFreightMatchInput };
