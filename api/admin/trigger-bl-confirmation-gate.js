// api/admin/trigger-bl-confirmation-gate.js
// POST /api/admin/trigger-bl-confirmation-gate
// body: { dry_run?: boolean }
// Auth: admin only (or system/cron)

import { setCors } from "../db.js";
import { runBlConfirmationGate } from "../../jobs/bl-confirmation-gate.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "system")) {
    return res.status(403).json({ success: false, error: "admin only" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "POST only" });
  }
  try {
    const dryRun = req.body?.dry_run !== false && req.body?.dry_run !== "false";
    const result = await runBlConfirmationGate({ dryRun });
    return res.status(200).json({
      success: true,
      dry_run: dryRun,
      customer_send_switch: "BL_CONFIRMATION_SEND_CUSTOMER=true",
      customer_send_default: "off",
      result,
    });
  } catch (e) {
    console.error("[trigger-bl-confirmation-gate]", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
