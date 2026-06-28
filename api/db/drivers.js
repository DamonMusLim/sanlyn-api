import { getPool, setCors } from "../db.js";
import { isInternalRole, roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

// Drivers CRUD.
//
// GET    /api/db/drivers?trucking_company_id=X[&active=true]
// GET    /api/db/drivers?id=N
// POST   /api/db/drivers   { phone, name, truck_plate, trucking_company_id, ... }
// PATCH  /api/db/drivers?id=N
//
// Security:
//   • Read: internal OR trucking role (must scope by trucking_company_id).
//   • Write: only internal can blacklist / change credit_score.
//   • Trucking role can only edit drivers in its own company; restricted fields:
//     name / truck_plate / id_card_last4 / accepts_side_cargo / side_cargo_rate.
//
// Field handling:
//   • side_cargo_rate is JSONB.
//   • Server NEVER stores password, never returns sensitive PII beyond what's stored.

const TRUCKING_ALLOWED_PATCH = new Set([
  "name", "truck_plate", "id_card_last4", "active",
  "accepts_side_cargo", "side_cargo_rate",
]);

const ADMIN_ALLOWED_PATCH = new Set([
  ...TRUCKING_ALLOWED_PATCH,
  "trucking_company_id", "phone",
  "blacklist", "blacklist_reason", "credit_score",
  "rating_avg", "rating_count",
]);

function rowToPublic(r) {
  if (!r) return null;
  return {
    id: r.id,
    phone: r.phone,
    name: r.name,
    truck_plate: r.truck_plate,
    trucking_company_id: r.trucking_company_id,
    id_card_last4: r.id_card_last4,
    active: r.active,
    rating_avg: r.rating_avg,
    rating_count: r.rating_count,
    credit_score: r.credit_score,
    blacklist: r.blacklist,
    blacklist_reason: r.blacklist_reason,
    accepts_side_cargo: r.accepts_side_cargo,
    side_cargo_rate: r.side_cargo_rate,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const role = roleFromAuth(req);
  const pool = getPool();
  const isAdmin = isInternalRole(role);
  // Watchtower fix (codex P1-4 / P2 2026-05-08): derive trucking_company from
  // JWT, never trust query/body. companyCode comes from authMiddleware
  // enrichStaleUser (api/auth.js) which patches it from the accounts table.
  const callerCompany = (req.user && (req.user.companyCode || req.user.company_code)) || null;

  try {
    if (req.method === "GET") {
      const id = req.query?.id;
      if (id) {
        const r = await pool.query("SELECT * FROM drivers WHERE id = $1", [parseInt(id)]);
        if (!r.rows.length) return sendError(res, 404, "not_found");
        const row = r.rows[0];
        // Watchtower fix (codex P2): non-admin must own this driver's trucking_company
        // AND must not see blacklisted drivers.
        if (!isAdmin) {
          if (!callerCompany || row.trucking_company_id !== callerCompany) {
            return sendError(res, 403, "forbidden");
          }
          if (row.blacklist) return sendError(res, 404, "not_found");
        }
        return res.status(200).json({ data: rowToPublic(row) });
      }

      const active = req.query?.active;
      const conds = [];
      const vals = [];

      // Watchtower fix (codex P1-4): scope is JWT-derived for non-admin; admins
      // may still filter by query string.
      let scopeCompany;
      if (isAdmin) {
        scopeCompany = req.query?.trucking_company_id || null;
      } else {
        if (!callerCompany) return sendError(res, 403, "forbidden");
        scopeCompany = callerCompany;
      }
      if (scopeCompany) { vals.push(scopeCompany); conds.push("trucking_company_id = $" + vals.length); }

      if (active === "true")   { conds.push("active = TRUE"); }
      if (active === "false")  { conds.push("active = FALSE"); }
      // External callers can never see blacklisted drivers
      if (!isAdmin) conds.push("blacklist = FALSE");

      const where = conds.length ? "WHERE " + (conds.join(" AND ")) : "";
      const r = await pool.query("SELECT * FROM drivers " + where + " ORDER BY name LIMIT 500", vals);
      return res.status(200).json({ data: r.rows.map(rowToPublic) });
    }

    if (req.method === "POST") {
      // Both internal and trucking can create drivers (trucking creates within its own company)
      const b = req.body || {};
      if (!b.phone) return sendError(res, 400, "phone_required");

      // Watchtower fix (codex P1-4): non-admin must POST under their own
      // trucking_company_id (JWT-derived). Admins may pass any.
      let insertCompany;
      if (isAdmin) {
        insertCompany = b.trucking_company_id || null;
      } else {
        if (!callerCompany) return sendError(res, 403, "forbidden");
        if (b.trucking_company_id && b.trucking_company_id !== callerCompany) {
          return sendError(res, 403, "trucking_company_mismatch");
        }
        insertCompany = callerCompany;
      }

      try {
        const ins = await pool.query(
          `INSERT INTO drivers
             (phone, name, truck_plate, trucking_company_id, id_card_last4,
              accepts_side_cargo, side_cargo_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           RETURNING *`,
          [
            b.phone, b.name || null, b.truck_plate || null,
            insertCompany, b.id_card_last4 || null,
            !!b.accepts_side_cargo,
            JSON.stringify(b.side_cargo_rate || null),
          ]
        );
        return res.status(201).json({ data: rowToPublic(ins.rows[0]) });
      } catch (e) {
        if (e.code === "23505") return sendError(res, 409, "phone_already_exists");
        throw e;
      }
    }

    if (req.method === "PATCH") {
      const id = req.query?.id;
      if (!id) return sendError(res, 400, "id_required");
      const b = req.body || {};

      // Fetch existing for RBAC
      const cur = await pool.query("SELECT trucking_company_id FROM drivers WHERE id = $1", [parseInt(id)]);
      if (!cur.rows.length) return sendError(res, 404, "not_found");

      // Watchtower fix (codex P1-4 PATCH variant): same as POST/GET — derive
      // company from JWT, not from query.
      if (!isAdmin) {
        if (!callerCompany || cur.rows[0].trucking_company_id !== callerCompany) {
          return sendError(res, 403, "forbidden");
        }
      }

      const allowed = isAdmin ? ADMIN_ALLOWED_PATCH : TRUCKING_ALLOWED_PATCH;
      const sets = [];
      const vals = [];
      let n = 0;
      for (const key of Object.keys(b)) {
        if (!allowed.has(key)) continue;
        n++;
        let v = b[key];
        if (key === "side_cargo_rate") v = JSON.stringify(v);
        sets.push(key + " = $" + n);
        vals.push(v);
      }
      if (sets.length === 0) return sendError(res, 400, "no_fields_to_update");
      n++;
      vals.push(parseInt(id));
      const sql = "UPDATE drivers SET " + (sets.join(", ")) + " WHERE id = $" + n + " RETURNING *";
      const r = await pool.query(sql, vals);
      return res.status(200).json({ data: rowToPublic(r.rows[0]) });
    }

    return sendError(res, 405, "method_not_allowed");
  } catch (err) {
    console.error("[drivers] error:", err);
    return sendError(res, 500, "internal_error", err.message);
  }
}
