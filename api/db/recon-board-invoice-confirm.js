export const INVOICE_CONFIRM_KIND = "port_charge_invoice_confirmation";

export const INVOICE_CONFIRM_SQL = `
invoice_confirm_groups AS (
  SELECT
         ico.shipment_id,
         bool_or(ico.status='pending_our_review') AS pending_price_review,
         CASE
           WHEN bool_or(ico.status='pending_our_review') THEN 'pending_our_review'
           WHEN bool_or(ico.status='external_confirmed') THEN 'external_confirmed'
           WHEN bool_or(ico.status='draft') THEN 'draft'
           ELSE 'none'
         END AS invoice_confirm_status,
         (array_agg(ico.actor_label ORDER BY ico.confirmed_at DESC NULLS LAST, ico.updated_at DESC NULLS LAST))[1] AS confirm_actor,
         MAX(ico.confirmed_at) AS confirm_at,
         COALESCE(jsonb_agg(jsonb_build_object(
           'ref', ico.ref,
           'kind', ico.kind,
           'status', ico.status,
           'actor_label', ico.actor_label,
           'confirmed_at', ico.confirmed_at,
           'factory_scope', ico.factory_scope
         ) ORDER BY (ico.status='pending_our_review') DESC, ico.confirmed_at DESC NULLS LAST, ico.updated_at DESC NULLS LAST), '[]'::jsonb) AS invoice_confirm_refs
    FROM invoice_collab_confirm_overrides ico
   WHERE ico.kind='${INVOICE_CONFIRM_KIND}'
   GROUP BY ico.shipment_id
)`;

export function actorLabel(req) {
  return String(req.user?.username || req.user?.email || req.user?.account || req.user?.uid || req.user?.id || req.user?.role || "finance").slice(0, 120);
}

export function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch (_) { return {}; }
}

export async function reviewPriceOverride(pool, req) {
  const body = parseBody(req.body);
  const ref = String(body.ref || "").trim();
  const kind = String(body.kind || INVOICE_CONFIRM_KIND).trim();
  const decision = String(body.decision || "").trim();
  const note = String(body.note || "").trim().slice(0, 500);
  if (!ref) return { status: 400, payload: { error: "bad_request", message: "ref required" } };
  if (kind !== INVOICE_CONFIRM_KIND) return { status: 400, payload: { error: "bad_request", message: "kind invalid" } };
  if (!["approve", "reject"].includes(decision)) return { status: 400, payload: { error: "bad_request", message: "decision must be approve or reject" } };

  const nextStatus = decision === "approve" ? "external_confirmed" : "draft";
  const actor = actorLabel(req);
  const r = await pool.query(
    `UPDATE invoice_collab_confirm_overrides
        SET status=$3,
            payload=COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
              'our_review', jsonb_build_object(
                'decision', $4::text,
                'note', $5::text,
                'actor_label', $6::text,
                'reviewed_at', now()
              )
            ),
            actor_label=$6,
            confirmed_at=now(),
            updated_at=now()
      WHERE ref=$1 AND kind=$2 AND status='pending_our_review'
      RETURNING ref, kind, shipment_id, status, actor_label, confirmed_at`,
    [ref, kind, nextStatus, decision, note, actor]
  );
  if (!r.rows.length) return { status: 409, payload: { error: "not_pending", message: "该改价确认已不在待审状态" } };
  return { status: 200, payload: { success: true, override: r.rows[0] } };
}
