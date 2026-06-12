import { getPool, setCors } from "../db.js";
import { roleFromAuth, sendError } from "../lib/viewmodel-adapter.js";

// GET  /api/db/shipment-collab
//   Returns unified 4-stage view per shipment:
//   booking (shipping_plans) → loading → trucking → customs
//
// PATCH /api/db/shipment-collab
//   Body: { shipping_plan_id, so_no, action }
//   action: "confirm_so" → sets collab_sheet_status = "all_confirmed"

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.end();

  const pool = getPool();
  const role = await roleFromAuth(req);
  if (!role) return sendError(res, 401, "Unauthorized");

  // ── PATCH: confirm SO received ────────────────────────────
  if (req.method === "PATCH") {
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {}

    const { shipping_plan_id, so_no, action } = body;
    if (!shipping_plan_id) return sendError(res, 400, "shipping_plan_id required");

    if (action === "confirm_so") {
      await pool.query(
        `UPDATE shipping_plans
         SET so_no = $1, collab_sheet_status = 'all_confirmed', updated_at = now()
         WHERE id = $2`,
        [so_no || null, shipping_plan_id],
      );
    } else if (action === "update_so_no") {
      await pool.query(
        `UPDATE shipping_plans SET so_no = $1, updated_at = now() WHERE id = $2`,
        [so_no || null, shipping_plan_id],
      );
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: true }));
  }

  // ── GET: unified 4-stage list ─────────────────────────────
  if (req.method !== "GET") return sendError(res, 405, "Method not allowed");

  try {
    const { rows } = await pool.query(`
      SELECT
        sp.id              AS plan_id,
        sp.contract_no,
        sp.bl_no,
        sp.vessel,
        sp.voyage,
        sp.etd,
        sp.cutoff_date,
        sp.cargo_cutoff,
        sp.vgm_cutoff,
        sp.doc_cutoff,
        sp.collab_sheet_status,
        sp.booking_no,
        sp.so_no,
        sp.booking_sent_at,
        sp.forwarder_cn,
        sp.forwarder_booking_no,
        sp.freight_term,
        sp.pol,
        sp.pod,
        sp.carrier_code,
        sp.freight_quote_snapshot,
        lcs.id             AS loading_sheet_id,
        lcs.factory_code,
        lcs.customer_code,
        lcs.trade_terms,
        lcs.status         AS loading_status,
        lcs.loading        AS loading_data,
        lcs.photos         AS loading_photos,
        lcs.participant_note,
        lcs.submitted_at   AS loading_submitted_at,
        bcs.submission_count  AS bc_count,
        bcs.last_submitted_at AS bc_submitted_at,
        bcs.factory_remarks   AS bc_factory_remarks,
        bcs.customer_remarks  AS bc_customer_remarks
      FROM shipping_plans sp
      LEFT JOIN loading_collab_sheets lcs ON lcs.contract_no = sp.contract_no
      LEFT JOIN (
        SELECT
          shipping_plan_id,
          COUNT(*)             AS submission_count,
          MAX(submitted_at)    AS last_submitted_at,
          MAX(factory_remarks) AS factory_remarks,
          MAX(customer_remarks) AS customer_remarks
        FROM booking_collab_sheets
        GROUP BY shipping_plan_id
      ) bcs ON bcs.shipping_plan_id = sp.id
      WHERE sp.contract_no IS NOT NULL
        AND sp.contract_no != ''
      ORDER BY sp.created_at DESC
      LIMIT 200
    `);

    const NA = "N/A_FOB_FACTORY_ARRANGED";
    const isFobLike = (t) => !t || ["FOB","EXW"].includes((t||"").toUpperCase());

    const data = rows.map((r) => {
      const css = r.collab_sheet_status || "draft";
      const bookingStatus =
        css === "all_confirmed" ? "confirmed" :
        css === "factory_confirmed" || css === "customer_confirmed" ? "in_progress" :
        css === "sanlyn_done" ? "sent_to_factory" :
        "pending";

      const soReceived = !!(r.so_no);

      const loadingStatus =
        !soReceived ? "awaiting_so" :
        r.loading_status === "completed" || r.loading_status === "approved" ? "completed" :
        r.loading_status === "submitted" ? "submitted" :
        r.loading_status === "in_progress" ? "in_progress" :
        r.loading_sheet_id ? "pending" : "not_started";

      const tradeTerms = r.trade_terms || r.freight_term || "";
      const truckingStatus = isFobLike(tradeTerms) ? NA : "pending";
      const customsStatus  = isFobLike(tradeTerms) ? NA : "pending";

      const ld = r.loading_data || {};

      // Freight quote snapshot summary
      const fqs = r.freight_quote_snapshot || {};
      const quote = fqs.usd_rate ? `USD ${fqs.usd_rate}/ctn · ${fqs.forwarder_co || ""}` : null;

      return {
        id:              r.plan_id,
        collab_code:     "SP-" + String(r.plan_id).padStart(4, "0"),
        plan_id:         r.plan_id,
        loading_sheet_id: r.loading_sheet_id,
        contract_no:     r.contract_no,
        bl_no:           r.bl_no,
        vessel:          r.vessel,
        voyage:          r.voyage,
        etd:             r.etd,
        pol:             r.pol,
        pod:             r.pod,
        incoterm:        tradeTerms || "—",
        factory_code:    r.factory_code,
        customer_code:   r.customer_code,
        forwarder_cn:    r.forwarder_cn,

        // Booking stage
        booking_status:  bookingStatus,
        booking_data: {
          booking_no:          r.booking_no    || null,
          so_no:               r.so_no         || null,
          vessel:              r.vessel        || null,
          voyage:              r.voyage        || null,
          etd:                 r.etd           || null,
          cargo_cutoff:        r.cargo_cutoff  || r.cutoff_date || null,
          vgm_cutoff:          r.vgm_cutoff    || null,
          doc_cutoff:          r.doc_cutoff    || null,
          forwarder:           r.forwarder_cn  || null,
          forwarder_booking_no: r.forwarder_booking_no || null,
          selected_quote:      quote,
          booking_sent_at:     r.booking_sent_at || null,
        },

        // SO status
        so_received:     soReceived,
        so_no:           r.so_no || null,

        // Loading stage
        loading_status:  loadingStatus,
        loading_data: {
          container_no: ld.container_no || null,
          seal_no:      ld.seal_no      || null,
          loaded_qty:   ld.loaded_qty   || null,
          loaded_ctn:   ld.loaded_ctn   || null,
          actual_gw:    ld.actual_gw    || null,
          photo_count:  Object.keys(r.loading_photos || {}).length || 0,
        },

        // Trucking + customs
        trucking_status: truckingStatus,
        trucking_data:   {},
        customs_status:  customsStatus,
        customs_data:    {},

        participant_note: r.participant_note || null,

        // Booking collab (booking_collab_sheets)
        booking_collab: r.bc_count > 0 ? {
          count:           Number(r.bc_count),
          submitted_at:    r.bc_submitted_at || null,
          factory_remarks: r.bc_factory_remarks || null,
          customer_remarks: r.bc_customer_remarks || null,
        } : null,
      };
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data }));
  } catch (err) {
    console.error("[shipment-collab] error:", err.message);
    sendError(res, 500, err.message);
  }
}
