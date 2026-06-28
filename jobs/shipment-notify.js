// jobs/shipment-notify.js
// Dual-track shipment notification (customer + factory) triggered on bl_no entry.
//
// sendShipmentNotifications(pool, row)
//   - row: full shipping_plans row (with all fee columns)
//   - Dedup: skips if raw.notifications_sent.customer/factory already set
//   - Stores text in raw.customer_notification_text / raw.factory_notification_text
//   - Writes timestamp to raw.notifications_sent.{customer,factory}
//   - Returns { customer, factory } result objects

const WECOM_URL = process.env.WECOM_WEBHOOK_URL;

// ── WeCom markdown send ───────────────────────────────────────
async function sendWecom(markdown) {
  if (!WECOM_URL) return { skipped: true, reason: "no WECOM_WEBHOOK_URL" };
  try {
    const r = await fetch(WECOM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
    });
    const d = await r.json();
    if (d.errcode === 0) return { ok: true };
    return { ok: false, errcode: d.errcode, errmsg: d.errmsg };
  } catch (e) {
    console.error("[shipment-notify] WeCom failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── Number formatting helpers ─────────────────────────────────
function fmtRmb(v) {
  const n = Number(v || 0);
  if (!n) return "—";
  return "¥" + n.toLocaleString("en", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtUsd(v) {
  const n = Number(v || 0);
  if (!n) return "—";
  return "$" + n.toLocaleString("en", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtDate(v) {
  if (!v) return "—";
  return String(v).slice(0, 10);
}

// ── Local charges total (CNY) ─────────────────────────────────
function calcLocalCharges(row) {
  return [
    row.bkg_fee, row.doc_fee, row.tlx_fee, row.thc_fee,
    row.eir_fee, row.seal_fee, row.vgm_fee, row.customs_declare_fee,
    row.port_surcharge_total,
  ].reduce((sum, v) => sum + Number(v || 0), 0);
}

// ── Contract nos ─────────────────────────────────────────────
function getContractNos(row) {
  if (Array.isArray(row.order_contract_nos)) return row.order_contract_nos.join(", ");
  if (typeof row.order_contract_nos === "string" && row.order_contract_nos.trim())
    return row.order_contract_nos.trim();
  if (row.contract_no) return row.contract_no;
  return "—";
}

// ── Build notification texts ──────────────────────────────────
function buildCustomerText(row) {
  const localCharges = calcLocalCharges(row);
  return [
    `## 🚢 Shipment Confirmed`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **BL No** | ${row.bl_no || "—"} |`,
    `| **Vessel / Voyage** | ${row.vessel || "—"} ${row.voyage || ""} |`,
    `| **POL → POD** | ${row.pol || "—"} → ${row.pod || "—"} |`,
    `| **ETD** | ${fmtDate(row.etd)} |`,
    `| **ETA** | ${fmtDate(row.eta)} |`,
    `| **Container** | ${row.container_no || "—"} (${row.container_type || "—"}) |`,
    ``,
    `**Charges**`,
    `> Local Charges: ${fmtRmb(localCharges)}`,
    `> Ocean Freight: ${fmtUsd(row.freight_sale_usd)}`,
    ``,
    `Shipment No: ${row.shipment_no || row._id || "—"}`,
  ].join("\n");
}

function buildFactoryText(row) {
  const contractNos = getContractNos(row);
  return [
    `## 货物已安排出运 ✅`,
    ``,
    `| 字段 | 内容 |`,
    `|---|---|`,
    `| **订单合同** | ${contractNos} |`,
    `| **柜号** | ${row.container_no || "—"} (${row.container_type || "—"}) |`,
    `| **船名航次** | ${row.vessel || "—"} ${row.voyage || ""} |`,
    `| **起运港** | ${row.pol || "—"} |`,
    `| **目的港** | ${row.pod || "—"} |`,
    `| **开航ETD** | ${fmtDate(row.etd)} |`,
    `| **预计到港ETA** | ${fmtDate(row.eta)} |`,
    `| **单证截止** | ${fmtDate(row.cutoff_date)} |`,
    ``,
    `如有问题请及时联系船务。`,
  ].join("\n");
}

// ── Main export ───────────────────────────────────────────────
export async function sendShipmentNotifications(pool, row, { force = false } = {}) {
  const raw = row.raw || {};
  const sent = raw.notifications_sent || {};
  const now  = new Date().toISOString();

  const doCustomer = force || !sent.customer;
  const doFactory  = force || !sent.factory;

  if (!doCustomer && !doFactory) {
    return {
      customer: { skipped: true, reason: "already sent" },
      factory:  { skipped: true, reason: "already sent" },
    };
  }

  const customerText = buildCustomerText(row);
  const factoryText  = buildFactoryText(row);

  const results = { customer: null, factory: null };

  // ── Customer notification ─────────────────────────────────
  if (doCustomer) {
    results.customer = await sendWecom(customerText);
    console.log(`[shipment-notify] customer BL=${row.bl_no} →`, results.customer);
  } else {
    results.customer = { skipped: true, reason: "already sent" };
  }

  // ── Factory notification ──────────────────────────────────
  if (doFactory) {
    results.factory = await sendWecom(factoryText);
    console.log(`[shipment-notify] factory BL=${row.bl_no} →`, results.factory);
  } else {
    results.factory = { skipped: true, reason: "already sent" };
  }

  // ── Persist texts + timestamps into raw ──────────────────
  const newSent = { ...sent };
  if (doCustomer && !results.customer.error) newSent.customer = now;
  if (doFactory  && !results.factory.error)  newSent.factory  = now;

  try {
    await pool.query(
      `UPDATE shipping_plans
       SET raw = raw
             || jsonb_build_object(
               'notifications_sent', $1::jsonb,
               'customer_notification_text', $2,
               'factory_notification_text',  $3
             ),
           updated_at = now()
       WHERE id = $4`,
      [JSON.stringify(newSent), customerText, factoryText, row.id]
    );
  } catch (e) {
    console.error("[shipment-notify] raw update failed:", e.message);
  }

  return results;
}

// ── Cancellation notice → factory (WeCom) ─────────────────────
// 取消通知工厂 (Damon 2026-06-26: 取消海运计划必须通知工厂)。复用同一企微渠道。
export async function sendCancellationNotice(pool, row, actor) {
  const contractNos = getContractNos(row);
  const md = [
    `## 海运计划已取消 ⚠️`,
    ``,
    `| 字段 | 内容 |`,
    `|---|---|`,
    `| **订单合同** | ${contractNos} |`,
    `| **计划号** | ${row.shipment_no || "—"} |`,
    `| **柜号** | ${row.container_no || "—"} (${row.container_type || "—"}) |`,
    `| **船名航次** | ${row.vessel || "—"} ${row.voyage || ""} |`,
    `| **起运港 → 目的港** | ${row.pol || "—"} → ${row.pod || "—"} |`,
    `| **操作人** | ${actor || "admin"} |`,
    ``,
    `该票已取消，请工厂停止相关安排，如有疑问请联系船务。`,
  ].join("\n");
  const res = await sendWecom(md);
  return res;
}
