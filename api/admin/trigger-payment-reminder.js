// api/admin/trigger-payment-reminder.js
// POST /api/admin/trigger-payment-reminder
//   body: { dry_run: true }  → test without sending WeCom
// Auth: admin only (or system/cron)
import { setCors } from "../db.js";
import { runPaymentReminder, ensureLogTable } from "../../jobs/payment-reminder.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || (req.user.role !== "admin" && req.user.role !== "system"))
    return res.status(403).json({ error: "admin only" });
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST required" });

  const dryRun = req.body?.dry_run === true || req.body?.dry_run === "true";

  try {
    await ensureLogTable();
    const result = await runPaymentReminder({ dryRun });
    return res.status(200).json({ ok: true, dry_run: dryRun, result });
  } catch (e) {
    console.error("[trigger-payment-reminder]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
