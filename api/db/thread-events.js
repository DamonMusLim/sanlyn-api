import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/thread-events — unified per-company event timeline (v2)
//
// Drives the Customer / Supplier / Logistics / Services thread views.
// Events are visible to BOTH parties by default (visibility='both').
//
// GET    ?company=<id>&counterparty=<id>&since=<iso>&limit=<n>
//   List a thread between two companies. Caller must be one of them
//   (1-hop visibility per blueprint v2).
//
// GET    ?company=<id>&type=task&status=open&limit=<n>
//   Cross-counterparty: e.g. "all open tasks for this company"
//
// POST   { company_id, counterparty_id, type, title, ... }
//   Append an event to a thread.
//
// PATCH  { id, ... }    — update an existing event (e.g. mark task done)
// ═══════════════════════════════════════════════════════════════

var VALID_TYPES = [
  'task', 'task_done', 'order', 'payment', 'document', 'shipment',
  'sample', 'catalog', 'email', 'wechat', 'whatsapp', 'phone',
  'ai_suggestion', 'note', 'price_change', 'invite_sent', 'joined'
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var callerCompanyId = req.company_id || req.headers["x-company-id"];

    if (req.method === "GET") {
      var { company, counterparty, type, since, until, limit = 100, ai_only } = req.query;
      if (!company) return res.status(400).json({ success: false, error: "company required" });

      // Visibility check: caller must be the company OR its counterparty
      if (callerCompanyId && parseInt(callerCompanyId) !== parseInt(company) &&
          (!counterparty || parseInt(callerCompanyId) !== parseInt(counterparty))) {
        return res.status(403).json({ success: false, error: "no visibility" });
      }

      var conds = [], params = [];
      params.push(parseInt(company));
      conds.push("(company_id = $" + params.length + " OR counterparty_id = $" + params.length + ")");

      if (counterparty) {
        params.push(parseInt(counterparty));
        conds.push("(company_id = $" + params.length + " OR counterparty_id = $" + params.length + ")");
      }
      if (type)     { params.push(type); conds.push("type = $" + params.length); }
      if (since)    { params.push(since); conds.push("occurred_at >= $" + params.length); }
      if (until)    { params.push(until); conds.push("occurred_at <= $" + params.length); }
      if (ai_only)  { conds.push("type = 'ai_suggestion'"); }

      // Hide self_only events from the counterparty
      if (callerCompanyId && parseInt(callerCompanyId) !== parseInt(company)) {
        conds.push("visibility <> 'self_only'");
      }
      // Always hide system events from API consumers (admin tooling reads directly)
      conds.push("visibility <> 'system'");

      var query = "SELECT * FROM thread_events WHERE " + conds.join(" AND ");
      query += " ORDER BY occurred_at DESC";
      params.push(parseInt(limit));
      query += " LIMIT $" + params.length;

      var result = await pool.query(query, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rowCount });
    }

    if (req.method === "POST") {
      var body = req.body || {};
      var {
        company_id, counterparty_id, type, title, detail,
        related_order_no, actor_user_id, actor_label, channel,
        metadata, ai_priority, ai_actions, visibility, occurred_at
      } = body;

      if (!company_id) return res.status(400).json({ success: false, error: "company_id required" });
      if (!type || !VALID_TYPES.includes(type)) {
        return res.status(400).json({ success: false, error: "type must be one of " + VALID_TYPES.join(",") });
      }
      if (!title) return res.status(400).json({ success: false, error: "title required" });

      var sql = `INSERT INTO thread_events
        (company_id, counterparty_id, type, title, detail, related_order_no,
         actor_user_id, actor_label, channel, metadata, ai_priority, ai_actions,
         visibility, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14, NOW()))
        RETURNING *`;
      var result = await pool.query(sql, [
        company_id, counterparty_id || null, type, title, detail || '',
        related_order_no || '', actor_user_id || null, actor_label || '',
        channel || '', JSON.stringify(metadata || {}),
        ai_priority || 0, JSON.stringify(ai_actions || []),
        visibility || 'both', occurred_at || null
      ]);

      // Update relationship's last_interaction_at if applicable
      if (counterparty_id) {
        try {
          await pool.query(
            `UPDATE relationships SET last_interaction_at = NOW(), updated_at = NOW()
             WHERE (from_company_id = $1 AND to_company_id = $2)
                OR (from_company_id = $2 AND to_company_id = $1)`,
            [company_id, counterparty_id]
          );
        } catch (e) { /* non-fatal */ }
      }

      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    if (req.method === "PATCH") {
      var body = req.body || {};
      var { id, type, title, detail, ai_actions, metadata } = body;
      if (!id) return res.status(400).json({ success: false, error: "id required" });

      var sets = [], params = [];
      function add(col, val) {
        if (val !== undefined) { params.push(val); sets.push(col + " = $" + params.length); }
      }
      add("type", type);
      add("title", title);
      add("detail", detail);
      if (ai_actions !== undefined) { params.push(JSON.stringify(ai_actions)); sets.push("ai_actions = $" + params.length); }
      if (metadata !== undefined)   { params.push(JSON.stringify(metadata));   sets.push("metadata = $" + params.length); }
      if (!sets.length) return res.status(400).json({ success: false, error: "nothing to update" });

      params.push(parseInt(id));
      var sql = "UPDATE thread_events SET " + sets.join(", ") + " WHERE id = $" + params.length + " RETURNING *";
      var result = await pool.query(sql, params);
      if (!result.rowCount) return res.status(404).json({ success: false, error: "not found" });
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    return res.status(405).json({ success: false, error: "method not allowed" });
  } catch (err) {
    console.error("[thread-events] error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
