import { getPool, setCors } from "../db.js";

// Loading Collab Sheets API
//
// GET    /api/db/loading-sheets?id=N                          → detail (factory lens strips internal_note)
// GET    /api/db/loading-sheets?factory_code=X&status=...     → list (no internal_note)
// GET    /api/db/loading-sheets?status=submitted              → admin review queue
// POST   /api/db/loading-sheets   { order_id, factory_code, assignee_user, due_at } → admin assigns
// PATCH  /api/db/loading-sheets?id=N                          → factory updates fields
// PATCH  /api/db/loading-sheets?id=N&action=submit            → factory submits
// PATCH  /api/db/loading-sheets?id=N&action=approve           → admin approves
// PATCH  /api/db/loading-sheets?id=N&action=reject            → admin rejects (needs_revision)
//
// Lens rule: when role !== 'admin' and !== 'internal', strip internal_note from response.
//            Forbidden-to-factory fields (trucking_cost / margin / customer_price etc.)
//            are NOT in this table — schema-level isolation, not UI guard.

function isInternalRole(role) {
  return role === "admin" || role === "internal" || role === "boss" || role === "finance";
}

// Extract role from token bearer (best-effort; falls back to 'factory')
function roleFromAuth(req) {
  // 1. explicit ?role= override (admin debug only — never trust in prod paths that mutate)
  if (req.query && req.query.role) return String(req.query.role);
  // 2. JWT (lightweight: assume payload.role; otherwise treat as factory)
  try {
    var auth = req.headers.authorization || "";
    var token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return "anonymous";
    var parts = token.split(".");
    if (parts.length !== 3) return "factory"; // not a JWT — assume factory portal
    var payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload.role || "factory";
  } catch (e) {
    return "factory";
  }
}

// Strip fields that role must not see. internal_note is the only such field
// IN this table; all other forbidden fields are isolated at schema level.
function applyLens(row, role) {
  if (!row) return row;
  if (isInternalRole(role)) return row;
  var clone = Object.assign({}, row);
  delete clone.internal_note;
  return clone;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var role = roleFromAuth(req);
  var pool = getPool();

  try {
    // ---- GET ----
    if (req.method === "GET") {
      var { id, factory_code, status, limit = 100 } = req.query;

      if (id) {
        var r = await pool.query("SELECT * FROM loading_collab_sheets WHERE id = $1", [parseInt(id)]);
        if (!r.rows.length) return res.status(404).json({ error: "not_found" });
        var row = r.rows[0];
        // factory token cannot read another factory's sheet
        if (!isInternalRole(role) && req.query.factory_code && row.factory_code !== req.query.factory_code) {
          return res.status(403).json({ error: "forbidden" });
        }
        return res.status(200).json({ data: applyLens(row, role) });
      }

      var conds = [], vals = [];
      if (factory_code) { vals.push(factory_code); conds.push("factory_code = $" + vals.length); }
      if (status)       { vals.push(status);       conds.push("status = $" + vals.length); }

      // Non-internal callers MUST scope by factory_code
      if (!isInternalRole(role) && !factory_code) {
        return res.status(400).json({ error: "factory_code required for non-internal lens" });
      }

      var where = conds.length ? " WHERE " + conds.join(" AND ") : "";
      vals.push(parseInt(limit));
      var sql = `
        SELECT * FROM loading_collab_sheets
        ${where}
        ORDER BY created_at DESC
        LIMIT $${vals.length}
      `;
      var rl = await pool.query(sql, vals);
      var rows = rl.rows.map(function (rr) { return applyLens(rr, role); });
      return res.status(200).json({ data: rows });
    }

    // ---- POST (admin assigns sheet) ----
    if (req.method === "POST") {
      if (!isInternalRole(role)) return res.status(403).json({ error: "admin_only" });
      var b = req.body || {};
      if (!b.order_id || !b.factory_code) return res.status(400).json({ error: "order_id and factory_code required" });

      // pull order context for snapshot
      var ord = await pool.query("SELECT order_no, contract_no, products FROM orders WHERE id = $1", [parseInt(b.order_id)]);
      if (!ord.rows.length) return res.status(404).json({ error: "order not found" });
      var o = ord.rows[0];

      // build initial products array from orders.products[]
      var planned = [];
      try {
        var prods = Array.isArray(o.products) ? o.products : (o.products ? JSON.parse(o.products) : []);
        planned = prods.map(function (p) {
          return {
            sku: p.sku || p.product_sku || "",
            product_name: p.name || p.product_name || "",
            planned_cartons: p.carton_count || p.qty_cartons || 0,
            actual_cartons: null,
            planned_gw:    p.gw_total_kg || p.gross_weight || null,
            actual_gw:     null,
            planned_cbm:   p.cbm_total || p.cbm || null,
            actual_cbm:    null,
            packaging_status: "pending",
            qc_status: "pending",
          };
        });
      } catch (e) { planned = []; }

      var ins = await pool.query(`
        INSERT INTO loading_collab_sheets
          (order_id, order_no, contract_no, factory_code, assignee_user, assignee_name, due_at, status, products)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'assigned',$8::jsonb)
        RETURNING *
      `, [
        parseInt(b.order_id), o.order_no || null, o.contract_no || null,
        b.factory_code, b.assignee_user || null, b.assignee_name || null,
        b.due_at || null, JSON.stringify(planned),
      ]);
      return res.status(201).json({ data: applyLens(ins.rows[0], role) });
    }

    // ---- PATCH ----
    if (req.method === "PATCH") {
      var pid = req.query.id;
      if (!pid) return res.status(400).json({ error: "id required" });
      var pb = req.body || {};
      var action = req.query.action || "";

      // fetch existing for guard
      var cur = await pool.query("SELECT * FROM loading_collab_sheets WHERE id = $1", [parseInt(pid)]);
      if (!cur.rows.length) return res.status(404).json({ error: "not_found" });
      var existing = cur.rows[0];

      // factory authz: must scope to own factory_code
      if (!isInternalRole(role)) {
        var qfc = req.query.factory_code;
        if (!qfc || existing.factory_code !== qfc) return res.status(403).json({ error: "forbidden" });
        if (action === "approve" || action === "reject") return res.status(403).json({ error: "admin_only_action" });
      }

      // Action shortcuts
      if (action === "submit") {
        var rs = await pool.query(`
          UPDATE loading_collab_sheets
             SET status='submitted', submitted_at = NOW()
           WHERE id = $1 AND status IN ('assigned','in_progress','needs_revision')
           RETURNING *
        `, [parseInt(pid)]);
        if (!rs.rows.length) return res.status(409).json({ error: "invalid_status_transition" });
        return res.status(200).json({ data: applyLens(rs.rows[0], role) });
      }
      if (action === "approve") {
        var ra = await pool.query(`
          UPDATE loading_collab_sheets
             SET status='approved', approved_at=NOW(), reviewed_by=$2, reviewed_at=NOW()
           WHERE id = $1 AND status IN ('submitted','under_review')
           RETURNING *
        `, [parseInt(pid), pb.reviewed_by || "admin"]);
        if (!ra.rows.length) return res.status(409).json({ error: "invalid_status_transition" });
        return res.status(200).json({ data: applyLens(ra.rows[0], role) });
      }
      if (action === "reject") {
        if (!pb.revision_reason) return res.status(400).json({ error: "revision_reason required" });
        var rr = await pool.query(`
          UPDATE loading_collab_sheets
             SET status='needs_revision', reviewed_by=$2, reviewed_at=NOW(), revision_reason=$3
           WHERE id = $1 AND status IN ('submitted','under_review')
           RETURNING *
        `, [parseInt(pid), pb.reviewed_by || "admin", pb.revision_reason]);
        if (!rr.rows.length) return res.status(409).json({ error: "invalid_status_transition" });
        return res.status(200).json({ data: applyLens(rr.rows[0], role) });
      }

      // Field updates — whitelist by role
      var allowedFactory = ["products", "loading", "photos", "participant_note", "factory_visible_note"];
      var allowedAdmin   = allowedFactory.concat([
        "internal_note", "due_at", "assignee_user", "assignee_name", "status",
      ]);
      var allowed = isInternalRole(role) ? allowedAdmin : allowedFactory;

      var sets = [], vals2 = [], n = 0;
      for (var f of allowed) {
        if (pb[f] !== undefined) {
          n++;
          var v = pb[f];
          if (f === "products" || f === "loading" || f === "photos") v = JSON.stringify(v);
          sets.push(f + " = $" + n);
          vals2.push(v);
        }
      }

      // factory editing auto-promotes 'assigned' → 'in_progress'
      if (!isInternalRole(role) && existing.status === "assigned" && sets.length > 0) {
        sets.push("status = 'in_progress'");
      }

      if (sets.length === 0) return res.status(400).json({ error: "no_fields_to_update" });
      n++;
      vals2.push(parseInt(pid));
      var sqlU = `UPDATE loading_collab_sheets SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`;
      var ru = await pool.query(sqlU, vals2);
      return res.status(200).json({ data: applyLens(ru.rows[0], role) });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[loading-sheets] error:", err);
    return res.status(500).json({ error: err.message });
  }
}
