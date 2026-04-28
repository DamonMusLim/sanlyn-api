// migrate-invite-review.js
// Extend factory_invites → generic partner_invites schema (6 types + review workflow).
// Idempotent. POST to execute, GET for dry-run.
//
// Adds:
//   type            ('colleague'|'customer'|'factory'|'ocean'|'trucking'|'service')
//   status          ('pending'|'approved'|'rejected'|'used')
//   reviewed_by, reviewed_at, review_note
//   tax_id          (for dedup)
//   message         (inviter's note to invitee)
//   channel_value   (email/wechat-id/phone unified column)
//   documents       JSONB { business_license: oss_url, ... }
//   ip, user_agent  (audit trail)

import { getPool, setCors } from "../db.js";

var PLAN = [
  ["factory_invites.type",          "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'factory'"],
  ["factory_invites.status",        "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'"],
  ["factory_invites.reviewed_by",   "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(64)"],
  ["factory_invites.reviewed_at",   "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ"],
  ["factory_invites.review_note",   "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS review_note TEXT"],
  ["factory_invites.tax_id",        "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS tax_id VARCHAR(32)"],
  ["factory_invites.message",       "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS message TEXT"],
  ["factory_invites.channel_value", "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS channel_value VARCHAR(128)"],
  ["factory_invites.documents",     "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '{}'::jsonb"],
  ["factory_invites.ip",            "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS ip VARCHAR(45)"],
  ["factory_invites.user_agent",    "ALTER TABLE factory_invites ADD COLUMN IF NOT EXISTS user_agent TEXT"],
  ["idx invites.status",            "CREATE INDEX IF NOT EXISTS idx_invites_status ON factory_invites(status)"],
  ["idx invites.type",              "CREATE INDEX IF NOT EXISTS idx_invites_type   ON factory_invites(type)"],
  ["idx invites.tax_id",            "CREATE INDEX IF NOT EXISTS idx_invites_tax_id ON factory_invites(tax_id) WHERE tax_id IS NOT NULL"],
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  var dryRun = req.method === "GET" || req.query?.dry_run === "true";

  try {
    if (dryRun) {
      var cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='factory_invites' ORDER BY ordinal_position"
      );
      return res.status(200).json({
        success: true,
        mode: "dry_run",
        plan: PLAN.map(p => ({ step: p[0], sql: p[1] })),
        currentColumns: cols.rows.map(c => c.column_name),
      });
    }

    var results = [];
    for (var i = 0; i < PLAN.length; i++) {
      try {
        var t0 = Date.now();
        await pool.query(PLAN[i][1]);
        results.push({ step: PLAN[i][0], status: "ok", ms: Date.now() - t0 });
      } catch (e) {
        results.push({ step: PLAN[i][0], status: "error", error: e.message });
      }
    }
    return res.status(200).json({ success: true, mode: "executed", results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
