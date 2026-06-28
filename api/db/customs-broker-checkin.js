// ═══════════════════════════════════════════════════════════════
// api/db/customs-broker-checkin.js  — 报关行 Magic Link 协同
//
// GET  /api/db/customs-broker-checkin?token=X
//   → validates magic-link token, returns task envelope + customs draft data
//   → anonymises factory/customer identifiers (no full names, no prices)
//
// POST /api/db/customs-broker-checkin
//   body: { token, action: "save"|"submit", items?, notes?, customs_doc_url? }
//   save   → PATCH customs_draft_sheets.declaration + participant_note
//   submit → PATCH status='submitted' + store customs_doc_url in declaration JSONB
//
// Security:
//   ✗ No JWT required (magic-link pattern)
//   ✗ token validated via SHA-256 hash
//   ✗ collab_sheet_table must be 'customs_draft_sheets' (else 403)
//   ✗ Never returns price / profit / customer full name / factory full name
//   ✗ token NOT marked used_at — broker can check status multiple times
// ═══════════════════════════════════════════════════════════════
import { getPool, setCors } from "../db.js";
import { hashToken, sendError } from "../lib/viewmodel-adapter.js";

const ALLOWED_TABLE = "customs_draft_sheets";

// ── Field masking rules ─────────────────────────────────────────────────────
// factory_code: show only last 3-4 chars, prefix F-
// e.g. "HG-218" → "F-218", "YANGBAOBAO" → "F-BAO"
function maskFactory(factory_code) {
  if (!factory_code) return null;
  const s = String(factory_code);
  // Take digits/suffix after last hyphen, else last 3 chars
  const m = s.match(/-(\w+)$/);
  return "F-" + (m ? m[1] : s.slice(-3).toUpperCase());
}

// customer name: first char + '-' + digit (from contract/order), suffix initials
// e.g. "PETSOME" + order_id 12 + "HM" → "C-12-PS"
function maskCustomer(customer_name, order_id) {
  if (!customer_name) return null;
  const initials = String(customer_name).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  const num = order_id ? parseInt(order_id) % 99 : 0;
  return `C-${num}-${initials || "XX"}`;
}

// Strip any price/profit fields from products before returning to broker
const PRICE_FIELDS = new Set([
  "unitPrice", "unitPriceCNY", "unitPriceUSD",
  "subtotal", "total", "totalAmount",
  "salePrice", "saleTotal", "profit", "profitRate",
  "cost", "factoryPrice", "priceUSD", "priceCNY",
  "markup", "margin", "commission",
]);

function stripPrices(item) {
  const clean = { ...item };
  for (const k of PRICE_FIELDS) delete clean[k];
  return clean;
}

// Build declaration rows from order products + products table enrichment
function buildDeclarationRows(products, enrichMap) {
  return (Array.isArray(products) ? products : []).map(p => {
    const enr = enrichMap[p.sku || p.barcode] || {};
    return stripPrices({
      sku:                  p.sku || "",
      name_cn:              enr.declaration_name || p.declaration_name || p.name || "",
      hs_code:              enr.hs_code || p.hs_code || p.hsCode || "",
      elements:             enr.declaration_elements || p.elements || "",
      qty:                  Number(p.qty || 0),
      net_weight_per_ctn:   Number(enr.net_weight || p.netWeight || p.net_weight || 0),
      gross_weight_per_ctn: Number(enr.gross_weight || p.grossWeight || p.gross_weight || 0),
      total_nw_kg:          Number(p.qty || 0) * Number(enr.net_weight || p.netWeight || p.net_weight || 0),
      total_gw_kg:          Number(p.qty || 0) * Number(enr.gross_weight || p.grossWeight || p.gross_weight || 0),
      cbm_per_ctn:          Number(enr.cbm || p.cbm || 0),
    });
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── Shared: extract + validate token ────────────────────────────────────────
  const rawToken = req.method === "GET"
    ? (req.query?.token || "")
    : ((req.body || {}).token || "");

  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 16) {
    return sendError(res, 400, "token_required");
  }

  const tokenHash = hashToken(rawToken);

  // Look up assignment (token NOT checked for used_at here — broker uses link repeatedly)
  const { rows: asmRows } = await pool.query(
    `SELECT da.id AS assignment_id,
            da.collab_sheet_table,
            da.collab_sheet_id,
            da.order_id,
            da.task_type,
            da.status     AS assignment_status,
            da.expires_at,
            da.revoked_at
       FROM driver_assignments da
      WHERE da.magic_token_hash = $1
        AND da.expires_at > NOW()
        AND da.revoked_at IS NULL
      LIMIT 1`,
    [tokenHash]
  );
  if (!asmRows.length) return sendError(res, 401, "invalid_or_expired_link");

  const asm = asmRows[0];

  // Verify this token is for a customs draft sheet
  if (asm.collab_sheet_table !== ALLOWED_TABLE) {
    return sendError(res, 403, "token_not_for_customs_broker");
  }
  if (!asm.collab_sheet_id) {
    return sendError(res, 400, "no_sheet_attached");
  }

  // ── GET: return task + customs draft data ────────────────────────────────────
  if (req.method === "GET") {
    try {
      // Load customs draft sheet
      const { rows: sheetRows } = await pool.query(
        `SELECT id, order_id, order_no, contract_no, owner_company_code, status,
                declaration, factory_address, pol, participant_note,
                customs_visible_note, due_at, submitted_at
           FROM ${ALLOWED_TABLE}
          WHERE id = $1`,
        [parseInt(asm.collab_sheet_id)]
      );
      if (!sheetRows.length) return sendError(res, 404, "sheet_not_found");
      const sheet = sheetRows[0];

      // Load order for extra context (ETD, company_code, products, factory_code, customer)
      const orderId = asm.order_id || sheet.order_id;
      let order = null;
      let maskedFactory = null;
      let maskedCustomer = null;
      let declarationRows = null;
      let exportCompany = null;

      if (orderId) {
        const { rows: ordRows } = await pool.query(
          `SELECT id, order_no, contract_no, company_code, etd, currency,
                  raw, products
             FROM orders WHERE id = $1`,
          [parseInt(orderId)]
        );
        if (ordRows.length) {
          order = ordRows[0];
          const raw = order.raw || {};

          // Anonymise
          maskedFactory  = maskFactory(raw.factory || raw.factory_code || order.raw?.factoryCompanyCode);
          maskedCustomer = maskCustomer(order.customer || raw.customer, order.id);
          exportCompany  = order.company_code || raw.companyCode || null;

          // Enrich products for declaration
          const products = Array.isArray(order.products) ? order.products
                         : Array.isArray(raw.products) ? raw.products : [];
          const skus = products.map(p => p.sku || p.barcode).filter(Boolean);
          let enrichMap = {};
          if (skus.length) {
            const ph = skus.map((_, i) => "$" + (i + 1));
            const { rows: pRows } = await pool.query(
              `SELECT sku, hs_code, declaration_name, declaration_elements,
                      net_weight, gross_weight, cbm
                 FROM products
                WHERE sku IN (${ph.join(",")})`,
              skus
            );
            pRows.forEach(r => { enrichMap[r.sku] = r; });
          }

          // Use sheet.declaration if broker has already saved edits; else build from order
          const existing = sheet.declaration && typeof sheet.declaration === "object"
                           && Array.isArray(sheet.declaration.items)
                           ? sheet.declaration.items
                           : null;
          declarationRows = existing || buildDeclarationRows(products, enrichMap);
        }
      }

      return res.status(200).json({
        ok: true,
        task: {
          assignment_id:   asm.assignment_id,
          task_type:       asm.task_type,
          expires_at:      asm.expires_at,
          sheet_id:        sheet.id,
          sheet_status:    sheet.status,
          contract_no:     sheet.contract_no || order?.contract_no || order?.order_no,
          order_no:        sheet.order_no    || order?.order_no,
          etd:             order?.etd || null,
          pol:             sheet.pol || null,
          export_company:  exportCompany,      // 出口主体 — shown as-is
          factory_masked:  maskedFactory,      // F-218
          customer_masked: maskedCustomer,     // C-12-PS
          due_at:          sheet.due_at,
          customs_visible_note: sheet.customs_visible_note || null,
          customs_doc_url: sheet.declaration?.customs_doc_url || null,
          submitted_at:    sheet.submitted_at,
        },
        items: declarationRows || [],
        broker_notes: sheet.participant_note || "",
      });

    } catch (err) {
      console.error("[customs-broker-checkin GET] error:", err);
      return sendError(res, 500, "internal_error", err.message);
    }
  }

  // ── POST: save or submit ────────────────────────────────────────────────────
  if (req.method === "POST") {
    const body = req.body || {};
    const action = body.action;
    if (!action || !["save", "submit"].includes(action)) {
      return sendError(res, 400, "invalid_action", "Allowed: save | submit");
    }

    try {
      // Load current sheet
      const { rows: sheetRows } = await pool.query(
        `SELECT id, status, declaration FROM ${ALLOWED_TABLE} WHERE id = $1`,
        [parseInt(asm.collab_sheet_id)]
      );
      if (!sheetRows.length) return sendError(res, 404, "sheet_not_found");
      const sheet = sheetRows[0];

      if (action === "save") {
        // Validate items if provided
        const items = Array.isArray(body.items) ? body.items : null;
        const notes = body.notes != null ? String(body.notes) : null;

        // Merge into declaration JSONB
        const prevDecl = (sheet.declaration && typeof sheet.declaration === "object")
                         ? sheet.declaration : {};
        const newDecl = {
          ...prevDecl,
          ...(items ? { items } : {}),
          updated_at: new Date().toISOString(),
        };

        const updates = [];
        const vals = [];
        vals.push(JSON.stringify(newDecl)); updates.push("declaration = $" + vals.length + "::jsonb");
        if (notes !== null) {
          vals.push(notes); updates.push("participant_note = $" + vals.length);
        }
        // In-progress if it was just assigned
        updates.push(
          "status = CASE WHEN status = 'assigned' THEN 'in_progress' ELSE status END"
        );
        updates.push("updated_at = NOW()");
        vals.push(parseInt(asm.collab_sheet_id));
        await pool.query(
          `UPDATE ${ALLOWED_TABLE} SET ${updates.join(", ")} WHERE id = $${vals.length}`,
          vals
        );
        return res.status(200).json({ ok: true, action: "save" });
      }

      if (action === "submit") {
        // Validate: must have a customs_doc_url
        const docUrl = body.customs_doc_url;
        if (!docUrl || typeof docUrl !== "string" || !docUrl.startsWith("http")) {
          return sendError(res, 400, "customs_doc_url_required",
            "Provide a valid URL from /api/oss-upload before submitting");
        }

        // Check we haven't already submitted
        if (sheet.status === "submitted" || sheet.status === "approved" || sheet.status === "completed") {
          return sendError(res, 409, "already_submitted");
        }

        // Items may also be provided on final submit
        const items = Array.isArray(body.items) ? body.items : null;
        const prevDecl = (sheet.declaration && typeof sheet.declaration === "object")
                         ? sheet.declaration : {};
        const newDecl = {
          ...prevDecl,
          ...(items ? { items } : {}),
          customs_doc_url: docUrl,
          submitted_at: new Date().toISOString(),
        };
        const notes = body.notes != null ? String(body.notes) : null;

        const vals = [JSON.stringify(newDecl), parseInt(asm.collab_sheet_id)];
        const noteClause = notes !== null
          ? (vals.push(notes), ", participant_note = $" + vals.length)
          : "";

        await pool.query(
          `UPDATE ${ALLOWED_TABLE}
              SET declaration = $1::jsonb,
                  status = 'submitted',
                  submitted_at = NOW()${noteClause}
            WHERE id = $2
              AND status NOT IN ('approved','completed')`,
          vals
        );

        return res.status(200).json({ ok: true, action: "submit", customs_doc_url: docUrl });
      }

    } catch (err) {
      console.error("[customs-broker-checkin POST] error:", err);
      return sendError(res, 500, "internal_error", err.message);
    }
  }

  return sendError(res, 405, "method_not_allowed");
}
