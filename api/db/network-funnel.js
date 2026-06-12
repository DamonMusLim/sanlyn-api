// network-funnel.js
// GET /api/db/network-funnel
//
// Returns 6-stage growth funnel counts for the Business Network Center.
// Stages: INVITED → OPENED → REGISTERED → PROFILED → FIRST_TXN → ACTIVE
//
// Optional query params:
//   ?invited_by=<company_code>   — filter to invites sent by one inviter
//   ?type=<partner_type>         — filter by partner type

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  var pool = getPool();
  var { invited_by, type } = req.query;

  try {
    // ── Stage 1-3 from factory_invites (via network_invites_view if available) ──
    var whereInvite = ["1=1"];
    var params = [];
    var p = 1;
    if (invited_by) { whereInvite.push("invited_by = $" + p++); params.push(invited_by); }
    if (type)       { whereInvite.push("type = $" + p++);       params.push(type); }
    var where = whereInvite.join(" AND ");

    var invQ = await pool.query(
      `SELECT
         COUNT(*)::int                                         AS invited,
         COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int   AS opened,
         COUNT(*) FILTER (WHERE used_at   IS NOT NULL)::int   AS registered
       FROM factory_invites
       WHERE ` + where,
      params
    );

    // ── Stage 4-6 from customers ──────────────────────────────
    // Customers created via invite (we join on contact_email → invite email)
    var custWhere = ["1=1"];
    var custParams = [];
    var cp = 1;
    if (invited_by) {
      // referred via sales_owner
      custWhere.push("sales_owner = $" + cp++);
      custParams.push(invited_by);
    }
    if (type) {
      custWhere.push("partner_type = $" + cp++);
      custParams.push(type);
    }

    var custQ = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE partner_status IS NOT NULL)::int             AS registered_cust,
         COUNT(*) FILTER (WHERE profile_completed_at IS NOT NULL)::int       AS profiled,
         COUNT(*) FILTER (WHERE first_order_at IS NOT NULL)::int             AS first_txn,
         COUNT(*) FILTER (WHERE partner_status = 'active')::int              AS active
       FROM customers
       WHERE ` + custWhere.join(" AND "),
      custParams
    );

    var inv  = invQ.rows[0];
    var cust = custQ.rows[0];

    // ── Recent invites list (last 20) ─────────────────────────
    var recentQ = await pool.query(
      `SELECT
         id, token, type,
         factory_name AS company_name,
         contact_name, contact_email,
         invited_by, status,
         opened_at, used_at AS registered_at,
         created_at, expires_at
       FROM factory_invites
       WHERE ` + where + `
       ORDER BY created_at DESC
       LIMIT 20`,
      params
    );

    // ── Conversion rates ──────────────────────────────────────
    var total = inv.invited || 0;
    function rate(n) { return total > 0 ? Math.round((n / total) * 100) : 0; }

    return res.status(200).json({
      success: true,
      funnel: {
        invited:    { count: inv.invited,    label: "Invited",    stage: 1 },
        opened:     { count: inv.opened,     label: "Link Opened", stage: 2, rate: rate(inv.opened) },
        registered: { count: inv.registered, label: "Registered", stage: 3, rate: rate(inv.registered) },
        profiled:   { count: cust.profiled,  label: "Profiled",   stage: 4, rate: rate(cust.profiled) },
        first_txn:  { count: cust.first_txn, label: "First Order", stage: 5, rate: rate(cust.first_txn) },
        active:     { count: cust.active,    label: "Active",     stage: 6, rate: rate(cust.active) },
      },
      recent_invites: recentQ.rows,
      filters: { invited_by: invited_by || null, type: type || null },
    });
  } catch (err) {
    console.error("[network-funnel]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
