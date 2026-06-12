// /api/db/change-requests.js
// Customer-side master-data change approval infrastructure.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TARGET_TYPES = new Set(["brand_route", "order_prefix_category", "product", "partner"]);
const LOCKED_FIELDS = new Set(["code", "po_prefix", "nextNumber", "numberPolicy"]);
const CUSTOMER_CODE_COLUMNS = ["company_code", "code", "customer_code", "portal_code"];
const CUSTOMER_ROLE_COLUMNS = ["role_type", "portal_role"];
const DIRECT_UPSTREAM_RELATIONSHIP_TYPES = new Set(["supplied_by", "direct_upstream"]);

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function uniquePartnerCodes(partners) {
  const seen = new Set();
  const unique = [];
  for (const partner of partners) {
    const key = normalizeCode(partner.upstreamCompanyCode);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(partner);
  }
  return unique;
}

function actorOf(req) {
  return req.user?.username || req.user?.account || req.user?.email || req.user?.sub || String(req.user?.id || "");
}

function scopedCompanyCodes(req) {
  const raw = req.user?.companyCodes || (req.user?.companyCode ? [req.user.companyCode] : []);
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v || "").trim()).filter(Boolean);
}

function hasScope(req, companyCode) {
  return scopedCompanyCodes(req).includes(String(companyCode || "").trim());
}

function parsePath(req) {
  const parts = String(req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.indexOf("change-requests");
  const rest = idx >= 0 ? parts.slice(idx + 1) : [];
  return {
    id: rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null,
    action: rest[1] || null,
  };
}

function containsLockedField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsLockedField);
  return Object.keys(value).some((key) => LOCKED_FIELDS.has(key) || containsLockedField(value[key]));
}

function payloadAfter(payload) {
  return payload && typeof payload === "object" && payload.after && typeof payload.after === "object"
    ? payload.after
    : {};
}

function validateCreateBody(body) {
  const targetType = String(body?.target_type || "").trim();
  const targetRef = String(body?.target_ref || "").trim();
  const payload = body?.payload;
  if (!TARGET_TYPES.has(targetType)) return "invalid target_type";
  if (!targetRef) return "target_ref required";
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "payload object required";
  if (containsLockedField(payload)) return "locked order-prefix fields cannot be changed";
  return null;
}

async function resolveUpstream(pool, requesterCompanyCode) {
  const result = await pool.query(
    `SELECT DISTINCT company_code_b AS upstream_company_code, relationship_type
       FROM partner_relationships
      WHERE company_code_a = $1
        AND status = 'active'
        AND company_code_b IS NOT NULL
        AND company_code_b <> ''
        AND company_code_b <> company_code_a`,
    [requesterCompanyCode],
  );
  const partners = result.rows.map((row) => ({
    upstreamCompanyCode: String(row.upstream_company_code || "").trim(),
    relationshipType: String(row.relationship_type || "").trim().toLowerCase(),
  }));
  if (partners.length === 0) throw new Error("upstream not found for requester");

  const explicitUpstream = uniquePartnerCodes(
    partners.filter((partner) => DIRECT_UPSTREAM_RELATIONSHIP_TYPES.has(partner.relationshipType)),
  );
  if (explicitUpstream.length === 1) return explicitUpstream[0].upstreamCompanyCode;
  if (explicitUpstream.length > 1) throw new Error("multiple explicit upstream relationships found for requester");

  const roles = await resolveCustomerRoles(
    pool,
    [requesterCompanyCode, ...partners.map((partner) => partner.upstreamCompanyCode)],
  );
  const requesterRole = roles.get(normalizeCode(requesterCompanyCode));
  if (requesterRole?.isSeller) {
    throw new Error("upstream direction required for seller requester");
  }

  const sellerCandidates = uniquePartnerCodes(
    partners.filter((partner) => roles.get(normalizeCode(partner.upstreamCompanyCode))?.isSeller),
  );
  if (sellerCandidates.length === 1) return sellerCandidates[0].upstreamCompanyCode;
  if (sellerCandidates.length === 0) throw new Error("seller upstream candidate not found for requester");
  throw new Error("multiple seller upstream candidates found for requester");
}

async function resolveCustomerRoles(pool, companyCodes) {
  const normalizedCodes = [...new Set(companyCodes.map(normalizeCode).filter(Boolean))];
  const roles = new Map();
  if (!normalizedCodes.length) return roles;

  const columnResult = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = ANY(current_schemas(false))
        AND table_name = 'customers'
        AND column_name = ANY($1::text[])`,
    [[...CUSTOMER_CODE_COLUMNS, ...CUSTOMER_ROLE_COLUMNS]],
  );
  const columns = new Set(columnResult.rows.map((row) => row.column_name));
  const codeColumns = CUSTOMER_CODE_COLUMNS.filter((column) => columns.has(column));
  const roleColumns = CUSTOMER_ROLE_COLUMNS.filter((column) => columns.has(column));
  if (!codeColumns.length || !roleColumns.length) return roles;

  const codeMatches = codeColumns.map((column) => `LOWER(c.${quoteIdent(column)}::text) = requested.code`).join(" OR ");
  const sellerChecks = roleColumns.map((column) => `LOWER(COALESCE(c.${quoteIdent(column)}::text, '')) = 'seller'`).join(" OR ");
  const values = normalizedCodes.map((_, index) => `($${index + 1})`).join(", ");
  const roleResult = await pool.query(
    `WITH requested(code) AS (VALUES ${values})
     SELECT requested.code, BOOL_OR(${sellerChecks}) AS is_seller
       FROM requested
       JOIN customers c ON ${codeMatches}
      GROUP BY requested.code`,
    normalizedCodes,
  );
  for (const row of roleResult.rows) {
    roles.set(row.code, { isSeller: row.is_seller === true });
  }
  return roles;
}

async function addEvent(client, requestId, event, actor, note) {
  await client.query(
    `INSERT INTO change_request_events (request_id, event, actor, note)
     VALUES ($1, $2, $3, $4)`,
    [requestId, event, actor || null, note || null],
  );
}

async function loadRequestForUpdate(client, id) {
  const result = await client.query(`SELECT * FROM change_requests WHERE id = $1 FOR UPDATE`, [id]);
  return result.rows[0] || null;
}

async function applyBrandRoute(client, request) {
  const after = payloadAfter(request.payload);
  const customerCode = after.customer_code || after.customerCode;
  const brand = after.brand;
  const factoryCode = after.factory_code || after.factoryCode;
  if (!customerCode || !brand || !factoryCode) throw new Error("brand_route after.customer_code, brand, factory_code required");
  await client.query(
    `INSERT INTO customer_brand_routes
       (customer_code, brand, factory_code, signed_nda, status, granted_at, granted_by, notes)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), NOW(), $6, $7)
     ON CONFLICT (customer_code, brand, factory_code)
       DO UPDATE SET signed_nda = EXCLUDED.signed_nda,
                     status = EXCLUDED.status,
                     notes = COALESCE(EXCLUDED.notes, customer_brand_routes.notes)`,
    [
      customerCode,
      brand,
      factoryCode,
      after.signed_nda === true,
      after.status || "active",
      request.reviewed_by || request.created_by || null,
      after.notes || request.notes || null,
    ],
  );
}

async function applyOrderPrefixCategory(client, request) {
  const after = payloadAfter(request.payload);
  if (typeof after.category !== "string") throw new Error("order_prefix_category after.category required");
  const result = await client.query(
    `UPDATE customers c
        SET order_prefixes = (
          SELECT jsonb_agg(
                   CASE
                     WHEN prefix.elem->>'code' = $2
                       THEN jsonb_set(prefix.elem, '{category}', to_jsonb($1::text), true)
                     ELSE prefix.elem
                   END
                   ORDER BY prefix.ordinality
                 )
            FROM jsonb_array_elements(COALESCE(c.order_prefixes, '[]'::jsonb)) WITH ORDINALITY AS prefix(elem, ordinality)
        )
      WHERE c.company_code = $3
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(COALESCE(c.order_prefixes, '[]'::jsonb)) AS prefix(elem)
           WHERE prefix.elem->>'code' = $2
        )`,
    [after.category, request.target_ref, request.requester_company_code],
  );
  if (result.rowCount !== 1) throw new Error("order_prefix target not found or not unique");
}

async function applyProduct(client, request) {
  const after = payloadAfter(request.payload);
  if (typeof after.category !== "string") throw new Error("product after.category required");
  const result = await client.query(
    `UPDATE products
        SET category = $1, updated_at = NOW()
      WHERE id::text = $2 OR sku = $2`,
    [after.category, request.target_ref],
  );
  if (result.rowCount !== 1) throw new Error("product target not found or not unique");
}

async function applyPartner(client, request) {
  const after = payloadAfter(request.payload);
  const codeA = after.company_code_a || after.companyCodeA || request.requester_company_code;
  const codeB = after.company_code_b || after.companyCodeB;
  const relType = after.relationship_type || "customer_factory";
  if (!codeA || !codeB) throw new Error("partner after.company_code_b required");
  await client.query(`LOCK TABLE partner_relationships IN SHARE ROW EXCLUSIVE MODE`);
  const existing = await client.query(
    `SELECT id
       FROM partner_relationships
      WHERE company_code_a = $1
        AND company_code_b = $2
        AND relationship_type = $3
      ORDER BY id
      FOR UPDATE`,
    [codeA, codeB, relType],
  );
  if (existing.rowCount > 1) throw new Error("partner relationship target not unique");
  if (existing.rowCount === 1) {
    await client.query(
      `UPDATE partner_relationships
          SET status = COALESCE($2, 'active'),
              notes = COALESCE($3, notes),
              updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id, after.status || "active", after.notes || request.notes || null],
    );
    return;
  }
  await client.query(
    `INSERT INTO partner_relationships
       (company_code_a, company_code_b, relationship_type, status, notes)
     VALUES ($1, $2, $3, COALESCE($4, 'active'), $5)`,
    [codeA, codeB, relType, after.status || "active", after.notes || request.notes || null],
  );
}

async function applyChange(client, request) {
  if (containsLockedField(request.payload)) throw new Error("locked order-prefix fields cannot be changed");
  if (request.target_type === "brand_route") return applyBrandRoute(client, request);
  if (request.target_type === "order_prefix_category") return applyOrderPrefixCategory(client, request);
  if (request.target_type === "product") return applyProduct(client, request);
  if (request.target_type === "partner") return applyPartner(client, request);
  throw new Error("unsupported target_type");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const actor = actorOf(req);
  const { id, action } = parsePath(req);

  try {
    if (req.method === "GET") {
      const requester = String(req.query.requester || "").trim();
      const upstream = String(req.query.upstream || "").trim();
      const status = String(req.query.status || "").trim();
      const where = [];
      const params = [];

      if (requester) {
        if (!hasScope(req, requester)) return res.status(403).json({ error: "Out of scope (requester)" });
        params.push(requester);
        where.push(`requester_company_code = $${params.length}`);
      }
      if (upstream) {
        if (!hasScope(req, upstream)) return res.status(403).json({ error: "Out of scope (upstream)" });
        params.push(upstream);
        where.push(`upstream_company_code = $${params.length}`);
      }
      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      if (!requester && !upstream) {
        const codes = scopedCompanyCodes(req);
        if (!codes.length) return res.status(403).json({ error: "Account scope missing" });
        params.push(codes);
        where.push(`(requester_company_code = ANY($${params.length}::text[]) OR upstream_company_code = ANY($${params.length}::text[]))`);
      }

      const result = await pool.query(
        `SELECT *
           FROM change_requests
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT 500`,
        params,
      );
      return res.json({ success: true, data: result.rows, count: result.rows.length });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    if (!id && !action) {
      const validationError = validateCreateBody(req.body || {});
      if (validationError) return res.status(400).json({ error: validationError });

      const requester = String(req.body.requester_company_code || req.body.requesterCompanyCode || "").trim();
      if (!requester) return res.status(400).json({ error: "requester_company_code required" });
      if (!hasScope(req, requester)) return res.status(403).json({ error: "Out of scope (requester)" });

      const upstream = await resolveUpstream(pool, requester);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `INSERT INTO change_requests
             (requester_company_code, upstream_company_code, target_type, target_ref, payload, status, created_by, notes)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'draft', $6, $7)
           RETURNING *`,
          [
            requester,
            upstream,
            req.body.target_type,
            String(req.body.target_ref).trim(),
            JSON.stringify(req.body.payload),
            actor || null,
            req.body.notes || null,
          ],
        );
        await addEvent(client, result.rows[0].id, "create", actor, null);
        await client.query("COMMIT");
        return res.status(201).json({ success: true, data: result.rows[0] });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    if (!id || !action) return res.status(400).json({ error: "request id and action required" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const request = await loadRequestForUpdate(client, id);
      if (!request) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "change request not found" });
      }

      if (action === "submit") {
        if (!hasScope(req, request.requester_company_code)) throw new Error("forbidden requester action");
        if (request.status !== "draft") throw new Error("submit requires draft status");
        const updated = await client.query(
          `UPDATE change_requests
              SET status = 'pending_upstream', submitted_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [id],
        );
        await addEvent(client, id, "submit", actor, req.body?.note || null);
        await client.query("COMMIT");
        return res.json({ success: true, data: updated.rows[0] });
      }

      if (action === "approve") {
        if (!hasScope(req, request.upstream_company_code)) throw new Error("forbidden upstream action");
        if (request.status !== "pending_upstream") throw new Error("approve requires pending_upstream status");
        const updated = await client.query(
          `UPDATE change_requests
              SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [id, actor || null],
        );
        await addEvent(client, id, "approve", actor, req.body?.note || null);
        await client.query("COMMIT");
        return res.json({ success: true, data: updated.rows[0] });
      }

      if (action === "reject") {
        if (!hasScope(req, request.upstream_company_code)) throw new Error("forbidden upstream action");
        if (request.status !== "pending_upstream") throw new Error("reject requires pending_upstream status");
        const reason = String(req.body?.reason || req.body?.reject_reason || "").trim();
        if (!reason) throw new Error("reject reason required");
        const updated = await client.query(
          `UPDATE change_requests
              SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), reject_reason = $3
            WHERE id = $1
            RETURNING *`,
          [id, actor || null, reason],
        );
        await addEvent(client, id, "reject", actor, reason);
        await client.query("COMMIT");
        return res.json({ success: true, data: updated.rows[0] });
      }

      if (action === "apply") {
        if (!hasScope(req, request.upstream_company_code)) throw new Error("forbidden upstream action");
        if (request.status === "applied") {
          await client.query("COMMIT");
          return res.json({ success: true, data: request, idempotent: true });
        }
        if (request.status !== "approved") throw new Error("apply requires approved status");
        await applyChange(client, request);
        const updated = await client.query(
          `UPDATE change_requests
              SET status = 'applied', applied_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [id],
        );
        await addEvent(client, id, "apply", actor, req.body?.note || null);
        await client.query("COMMIT");
        return res.json({ success: true, data: updated.rows[0] });
      }

      if (action === "cancel") {
        if (!hasScope(req, request.requester_company_code)) throw new Error("forbidden requester action");
        if (!["draft", "pending_upstream"].includes(request.status)) throw new Error("cancel requires draft or pending_upstream status");
        const updated = await client.query(
          `UPDATE change_requests
              SET status = 'cancelled'
            WHERE id = $1
            RETURNING *`,
          [id],
        );
        await addEvent(client, id, "cancel", actor, req.body?.note || null);
        await client.query("COMMIT");
        return res.json({ success: true, data: updated.rows[0] });
      }

      await client.query("ROLLBACK");
      return res.status(404).json({ error: "unknown action" });
    } catch (err) {
      await client.query("ROLLBACK");
      const msg = err.message || "change request action failed";
      const statusCode = msg.startsWith("forbidden") ? 403 : 400;
      return res.status(statusCode).json({ error: msg });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[change-requests]", err);
    const msg = err.message || "change request failed";
    const statusCode = msg.includes("upstream") ? 400 : 500;
    return res.status(statusCode).json({ error: msg });
  }
}
