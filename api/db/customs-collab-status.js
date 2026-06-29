// api/db/customs-collab-status.js
import { cleanString } from "./factory-portal-utils.js";

export function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function actorId(req) {
  return req?.user?.uid || req?.user?.id || req?.user?.account || req?.user?.email || null;
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o || {}, k);
}

async function withTx(poolOrClient, fn) {
  if (typeof poolOrClient.release === "function") return fn(poolOrClient);
  const client = await poolOrClient.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function computeSystemExpected(client, customsNo) {
  const r = await client.query(
    `SELECT CASE
              WHEN COUNT(i.item) = 0 THEN NULL
              ELSE ROUND(SUM(NULLIF(i.item->>'amount','')::numeric), 2)
            END AS amount
       FROM finance_export_rebates fer
       LEFT JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
       ) AS i(item) ON true
      WHERE fer.customs_no = $1`,
    [customsNo]
  );
  return money(r.rows[0]?.amount);
}

export async function ensureCustomsStatus(client, customsNo, factoryCode = null) {
  const r = await client.query(
    `WITH fer_one AS (
       SELECT fer.customs_no,
              MAX(fer.contract_no) AS contract_no,
              MIN(fer.export_date) AS export_date
         FROM finance_export_rebates fer
        WHERE fer.customs_no = $1
        GROUP BY fer.customs_no
     ),
     ord AS (
       SELECT MAX(per.factory_code) AS factory_code,
              MAX(per.contract_no) AS contract_no,
              COALESCE(NULLIF(SUM(per.declare_value),0), NULLIF(SUM(per.purchase_value),0)) AS purchase_amount,
              COUNT(*) AS n
         FROM (
           SELECT o.id, o.order_no, o.contract_no,
                  COALESCE(o.factory_code, c_id.code,
                    (SELECT p.factory_code FROM order_line_items x JOIN products p ON p.id=x.product_id
                      WHERE x.order_id=o.id AND p.factory_code IS NOT NULL LIMIT 1)) AS factory_code,
                  CASE WHEN o.order_no ILIKE '%-DG-%'
                       THEN (SELECT SUM(oli.declare_amount_per_box*oli.qty_ctn) FROM order_line_items oli WHERE oli.order_id=o.id)
                       ELSE NULL END AS declare_value,
                  COALESCE((SELECT SUM(oli.factory_subtotal) FROM order_line_items oli WHERE oli.order_id=o.id), o.total_amount_factory) AS purchase_value
             FROM orders o
             LEFT JOIN companies c_id ON c_id.id=o.factory_company_id
            WHERE COALESCE(o.status,'') <> 'cancelled'
              AND (o.contract_no = (SELECT contract_no FROM fer_one) OR o.order_no = $1 OR o.bl_no = $1)
              AND ($2::text IS NULL OR COALESCE(o.factory_code, c_id.code,
                    (SELECT p.factory_code FROM order_line_items x JOIN products p ON p.id=x.product_id
                      WHERE x.order_id=o.id AND p.factory_code IS NOT NULL LIMIT 1)) = $2)
         ) per
     ),
     fac AS (
       SELECT $1::text AS customs_no,
              COALESCE((SELECT contract_no FROM fer_one), (SELECT contract_no FROM ord)) AS contract_no,
              (SELECT purchase_amount FROM ord) AS system_expected_amount,
              (SELECT factory_code FROM ord) AS factory_code
        WHERE (SELECT n FROM ord) > 0 OR EXISTS (SELECT 1 FROM fer_one)
     )
     INSERT INTO customs_invoice_status
       (customs_no, factory_code, contract_no, system_expected_amount,
        status, expected_amount_source, created_at, updated_at)
     SELECT customs_no, factory_code, contract_no, system_expected_amount,
            CASE WHEN system_expected_amount IS NULL THEN 'need_amount' ELSE 'pending_confirm' END,
            'system',
            NOW(), NOW()
       FROM fac
     ON CONFLICT (customs_no) DO UPDATE SET
       factory_code = COALESCE(customs_invoice_status.factory_code, EXCLUDED.factory_code),
       contract_no = COALESCE(customs_invoice_status.contract_no, EXCLUDED.contract_no),
       system_expected_amount = EXCLUDED.system_expected_amount,
       status = CASE
         WHEN customs_invoice_status.status='need_amount' AND EXCLUDED.system_expected_amount IS NOT NULL THEN 'pending_confirm'
         ELSE customs_invoice_status.status
       END,
       expected_amount_source = CASE
         WHEN customs_invoice_status.manual_expected_amount IS NOT NULL THEN 'manual'
         WHEN EXCLUDED.system_expected_amount IS NOT NULL THEN 'system'
         ELSE customs_invoice_status.expected_amount_source
       END,
       updated_at = NOW()
     RETURNING *`,
    [customsNo, factoryCode]
  );
  if (!r.rows[0]) throw new Error("customs_no not found");
  return r.rows[0];
}

export async function uploadedForCustoms(client, customsNo) {
  const r = await client.query(
    `SELECT COALESCE(SUM(fii.amount_incl_tax), 0) AS uploaded_amount,
            COUNT(DISTINCT fii.id)::int AS valid_invoice_count,
            COUNT(DISTINCT fii.id) FILTER (
              WHERE COALESCE(fii.review_status,'') IN
                ('pending','ocr_failed','seller_mismatch','over_issued','under_issued')
            )::int AS pending_review_count
       FROM invoice_customs_links l
       JOIN finance_invoices_in fii ON fii.id=l.invoice_id
      WHERE l.customs_no=$1
        AND l.link_status='active'
        AND COALESCE(fii.review_status,'') NOT IN ('void','red_ink')`,
    [customsNo]
  );
  return {
    uploaded_amount: money(r.rows[0]?.uploaded_amount) || 0,
    valid_invoice_count: Number(r.rows[0]?.valid_invoice_count) || 0,
    pending_review_count: Number(r.rows[0]?.pending_review_count) || 0,
  };
}

export function nextStatus(row, upload, opts = {}) {
  const manual = money(row.manual_expected_amount);
  const system = money(row.system_expected_amount);
  const effective = manual !== null ? manual : system;
  const uploaded = money(upload.uploaded_amount) || 0;
  const count = Number(upload.valid_invoice_count) || 0;
  const tolerance = money(row.amount_tolerance) ?? 1;

  if (row.status === "completed" && !opts.force) return "completed";
  if (effective === null) return "need_amount";
  if (!count || uploaded <= 0) {
    return row.expected_amount_confirmed_at ? "confirmed_wait_invoice" : "pending_confirm";
  }

  const diff = effective - uploaded;
  if (Math.abs(diff) <= tolerance) return "matched";
  if (uploaded < effective - tolerance) return "partial_uploaded";
  return "over_issued";
}

export async function reconcileStatus(poolOrClient, customsNo, opts = {}) {
  return withTx(poolOrClient, async (client) => {
    await ensureCustomsStatus(client, customsNo);
    const cur = await client.query(
      `SELECT * FROM customs_invoice_status WHERE customs_no=$1 FOR UPDATE`,
      [customsNo]
    );
    const row = cur.rows[0];
    if (!row) throw new Error("customs_no not found");

    const upload = await uploadedForCustoms(client, customsNo);
    const status = nextStatus(row, upload, opts);
    const effective = money(row.manual_expected_amount) ?? money(row.system_expected_amount);
    const diff = effective === null ? null : money(effective - upload.uploaded_amount);

    const upd = await client.query(
      `UPDATE customs_invoice_status
          SET status=$2,
              expected_amount_source=CASE
                WHEN manual_expected_amount IS NOT NULL THEN 'manual'
                WHEN system_expected_amount IS NOT NULL THEN 'system'
                ELSE expected_amount_source
              END,
              updated_at=NOW()
        WHERE customs_no=$1
        RETURNING *`,
      [customsNo, status]
    );

    return {
      customs_no: customsNo,
      status,
      effective_expected_amount: effective,
      uploaded_amount: upload.uploaded_amount,
      valid_invoice_count: upload.valid_invoice_count,
      diff_amount: diff,
      row: upd.rows[0],
    };
  });
}

export async function writeInvoiceEvent(client, data) {
  const payload = data.payload || {};
  const r = await client.query(
    `INSERT INTO invoice_events
       (invoice_id, invoice_no, customs_no, factory_code, event_type,
        old_status, new_status, amount_incl_tax, reason, payload,
        created_by, actor_role)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     RETURNING id, created_at`,
    [
      data.invoice_id || null,
      cleanString(data.invoice_no) || null,
      cleanString(data.customs_no) || null,
      cleanString(data.factory_code) || null,
      cleanString(data.event_type),
      cleanString(data.old_status) || null,
      cleanString(data.new_status) || null,
      hasOwn(data, "amount_incl_tax") ? data.amount_incl_tax : null,
      cleanString(data.reason) || null,
      JSON.stringify(payload),
      data.created_by || null,
      cleanString(data.actor_role) || null,
    ]
  );
  const id = r.rows[0]?.id || null;
  if (id && data.customs_no) {
    await client.query(
      `UPDATE customs_invoice_status
          SET last_event_id=$2, updated_at=NOW()
        WHERE customs_no=$1`,
      [data.customs_no, id]
    );
  }
  return r.rows[0];
}
