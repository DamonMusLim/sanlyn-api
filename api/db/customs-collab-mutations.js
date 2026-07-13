// api/db/customs-collab-mutations.js — finance confirm + correction handlers
// split out of customs-collab.js (2026-07-14, ≤500-line rule).
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { money, ensureCustomsStatus, writeInvoiceEvent, reconcileStatus, actorId } from "./customs-collab-status.js";
import { requireFinance, resolveFactory, failClosed, assertFactoryCustoms, json } from "./customs-collab-shared.js";

async function handleConfirm(req, res) {
  const pool = getPool();
  let actorRole = "finance";
  let scope = null;

  if (cleanString(req.query?.c || req.body?.c || req.query?.mt || req.body?.mt)) {
    scope = await resolveFactory(req, pool);
    if (!scope) return failClosed(res);
    actorRole = "factory";
  } else if (!requireFinance(req, res)) {
    return;
  }

  const body = req.body || {};
  const customsNo = cleanString(body.customs_no || req.query.customs_no);
  const requestedFactoryCode = cleanString(body.factory_code || req.query.factory_code) || null;
  if (!customsNo) return json(res, 400, { error: "customs_no required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const st = scope ? await assertFactoryCustoms(client, scope.factory.code, customsNo) : await ensureCustomsStatus(client, customsNo, requestedFactoryCode);
    const confirmedAmount = money(body.confirmed_amount);
    const event = await writeInvoiceEvent(client, {
      customs_no: customsNo,
      factory_code: st.factory_code,
      event_type: "confirm_amount",
      old_status: st.status,
      new_status: "confirmed_wait_invoice",
      reason: body.reason,
      payload: actorRole === "factory" && confirmedAmount !== null ? { factory_proposed: confirmedAmount } : {},
      created_by: actorRole === "factory" ? scope.factory.code : actorId(req),
      actor_role: actorRole,
    });
    await client.query(
      `UPDATE customs_invoice_status
          SET status='confirmed_wait_invoice',
              expected_amount_confirmed_at=NOW(),
              expected_amount_confirmed_by=$2,
              confirmed_by_role=$3,
              last_event_id=$4,
              updated_at=NOW()
        WHERE customs_no=$1 AND factory_code=$5`,
      [customsNo, actorRole === "factory" ? scope.factory.code : actorId(req), actorRole, event.id, st.factory_code]
    );
    await client.query("COMMIT");
    return res.json({ success: true, customs_no: customsNo, status: "confirmed_wait_invoice", event_id: event.id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

async function handleCorrection(req, res) {
  if (!requireFinance(req, res)) return;
  const body = req.body || {};
  const customsNo = cleanString(body.customs_no);
  const requestedFactoryCode = cleanString(body.factory_code || req.query.factory_code) || null;
  const type = cleanString(body.correction_type);
  const reason = cleanString(body.reason);
  const invoiceId = body.invoice_id ? Number(body.invoice_id) : null;
  const valid = new Set(["void_invoice","red_ink_invoice","unbind_invoice","reopen","override_amount","review_match","review_mismatch","complete"]);
  if (!customsNo || !valid.has(type)) return json(res, 400, { error: "customs_no/correction_type invalid" });
  if (!reason && !["review_match","complete"].includes(type)) return json(res, 400, { error: "reason required" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const st = await ensureCustomsStatus(client, customsNo, requestedFactoryCode);
    let invoice = null;
    if (invoiceId) {
      const r = await client.query(`SELECT id, invoice_no, amount_incl_tax, review_status FROM finance_invoices_in WHERE id=$1 FOR UPDATE`, [invoiceId]);
      invoice = r.rows[0] || null;
      if (!invoice) throw new Error("invoice not found");
    }

    const payload = {};
    let newStatus = st.status;

    if (type === "override_amount") {
      const amt = money(body.manual_expected_amount);
      if (amt === null) return json(res, 400, { error: "manual_expected_amount required" });
      payload.old_manual_expected_amount = money(st.manual_expected_amount);
      payload.new_manual_expected_amount = amt;
      await client.query(
        `UPDATE customs_invoice_status
            SET manual_expected_amount=$2,
                expected_amount_source='manual',
                updated_at=NOW()
          WHERE customs_no=$1 AND factory_code=$3`,
        [customsNo, amt, st.factory_code]
      );
    } else if (type === "void_invoice" || type === "red_ink_invoice") {
      if (!invoiceId) return json(res, 400, { error: "invoice_id required" });
      const status = type === "void_invoice" ? "void" : "red_ink";
      const linkStatus = type === "void_invoice" ? "inactive" : "red_ink";
      await client.query(`UPDATE finance_invoices_in SET review_status=$2, updated_at=NOW() WHERE id=$1`, [invoiceId, status]);
      await client.query(`UPDATE invoice_customs_links SET link_status=$3, reason=$4 WHERE invoice_id=$1 AND customs_no=$2`, [invoiceId, customsNo, linkStatus, reason]);
      newStatus = status;
    } else if (type === "unbind_invoice") {
      if (!invoiceId) return json(res, 400, { error: "invoice_id required" });
      await client.query(`UPDATE invoice_customs_links SET link_status='inactive', reason=$3 WHERE invoice_id=$1 AND customs_no=$2`, [invoiceId, customsNo, reason]);
      newStatus = "inactive";
    } else if (type === "review_match" || type === "review_mismatch") {
      if (!invoiceId) return json(res, 400, { error: "invoice_id required" });
      newStatus = type === "review_match" ? "matched" : "amount_mismatch";
      await client.query(`UPDATE finance_invoices_in SET review_status=$2, updated_at=NOW() WHERE id=$1`, [invoiceId, newStatus]);
    } else if (type === "reopen") {
      await client.query(`UPDATE customs_invoice_status SET status='confirmed_wait_invoice', updated_at=NOW() WHERE customs_no=$1 AND factory_code=$2`, [customsNo, st.factory_code]);
      newStatus = "confirmed_wait_invoice";
    } else if (type === "complete") {
      await client.query(`UPDATE customs_invoice_status SET status='completed', updated_at=NOW() WHERE customs_no=$1 AND factory_code=$2`, [customsNo, st.factory_code]);
      newStatus = "completed";
    }

    const ev = await writeInvoiceEvent(client, {
      invoice_id: invoiceId,
      invoice_no: invoice?.invoice_no,
      customs_no: customsNo,
      factory_code: st.factory_code,
      event_type: type,
      old_status: invoice?.review_status || st.status,
      new_status: newStatus,
      amount_incl_tax: invoice?.amount_incl_tax,
      reason,
      payload,
      created_by: actorId(req),
      actor_role: req.user?.role,
    });

    let rec = { status: newStatus };
    if (type !== "complete") rec = await reconcileStatus(client, customsNo, { force: true }, st.factory_code);
    await client.query("COMMIT");
    return res.json({ success: true, customs_no: customsNo, status: rec.status, event_id: ev.id });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, e.status || (e.message === "invoice not found" ? 404 : 500), { error: e.message });
  } finally {
    client.release();
  }
}

export { handleConfirm, handleCorrection };
