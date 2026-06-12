// api/db/landed-cost.js
// GET /api/db/landed-cost?bl_no=XXX
//
// Returns customer-facing "My Landed Cost" data for one BL:
//   §1 Purchase Price  ← orders WHERE bl_no=$1 (sum IV totals)
//   §2 Ocean Freight   ← freight_debit_notes WHERE bl_no=$1 (sum CNY fees + USD freight)
//   §6 Per-SKU         ← jsonb_array_elements(orders.raw->'products')
//                        allocated by CTN ratio (industry standard)
//
// FX rate (W0-6: NO hard fallback — return 400 if unresolvable):
//   1) orders.exchange_rate + fx_markup (0.10 default)
//   2) freight_debit_notes.fx_rate_snapshot + fx_markup
//   3) exchange_rates table latest USD_CNY + 0.10 (via lib/finance/exchange-rate.js)
//   4) → 400 exchange_rate_required (NO silent 7.30 anymore — wrong by ~1.5%)
//
// Privacy: §2 data is Sanlyn-owned (forwarder bills). §3-5 are customer-entered
// (not stored server-side per blueprint §5.4 privacy boundary).

import { setCors, getPool } from "../db.js";
import { getExchangeRate } from "../lib/finance/exchange-rate.js";

const DEFAULT_FX_MARKUP = 0.10;

// Parse "2.2KG*8/CTN" → 8 units per carton
function unitsPerCtn(sizeStr) {
  if (!sizeStr) return 1;
  const m = String(sizeStr).match(/\*\s*(\d+)\s*\/\s*CTN/i);
  return m ? Number(m[1]) : 1;
}

async function resolveFx(pool, orderRows, fdnRows) {
  // 1) Try orders.exchange_rate
  const orderFx = orderRows.find(r => r.exchange_rate != null);
  if (orderFx && Number(orderFx.exchange_rate) > 0) {
    return { rate: Number(orderFx.exchange_rate) + DEFAULT_FX_MARKUP, source: "orders.exchange_rate +0.10", base: Number(orderFx.exchange_rate) };
  }
  // 2) Try freight_debit_notes.fx_rate_snapshot
  const fdnFx = fdnRows.find(r => r.fx_rate_snapshot != null);
  if (fdnFx && Number(fdnFx.fx_rate_snapshot) > 0) {
    const markup = Number(fdnFx.fx_markup) || DEFAULT_FX_MARKUP;
    return { rate: Number(fdnFx.fx_rate_snapshot) + markup, source: `FDN snapshot +${markup}`, base: Number(fdnFx.fx_rate_snapshot) };
  }
  // 3) exchange_rates table via central resolver
  const base = await getExchangeRate(pool, { currency: "USD" });
  if (base) {
    return { rate: base + DEFAULT_FX_MARKUP, source: `exchange_rates +${DEFAULT_FX_MARKUP}`, base };
  }
  // 4) W0-6: NO hardcoded fallback — caller must 400.
  return null;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const bl_no = String(req.query.bl_no || "").trim();
  if (!bl_no) return res.status(400).json({ error: "bl_no required" });

  const pool = getPool();
  try {
    // ── Orders for this BL ──
    const ordersRes = await pool.query(
      `SELECT id, order_no, contract_no, company_code, company_name_en,
              currency, exchange_rate, total_amount, total_qty, container_qty, container_type,
              trade_terms, vessel, voyage, etd, eta, pol, destination_port,
              raw
       FROM orders
       WHERE bl_no = $1
       ORDER BY created_at`,
      [bl_no]
    );
    if (!ordersRes.rows.length) {
      return res.status(404).json({ error: `No orders found for BL ${bl_no}` });
    }

    // ── Freight debit notes for this BL ──
    const fdnRes = await pool.query(
      `SELECT id, ref_no, status,
              usd_freight, cny_total, fx_rate_snapshot, fx_markup,
              ticket_count, box_count,
              fee_edi, fee_customs, fee_doc, fee_epacking, fee_booking, fee_barcode, fee_packing,
              fee_thc, fee_crane, fee_storage, fee_port_entry, fee_pickup, fee_parking, fee_trucking,
              issued_at
       FROM freight_debit_notes
       WHERE bl_no = $1
       ORDER BY created_at DESC`,
      [bl_no]
    );

    // ── FX resolution ──
    const fx = await resolveFx(pool, ordersRes.rows, fdnRes.rows);
    if (!fx) {
      // W0-6: STOP — no rate available from any source. Refuse rather than
      // silently default to 7.30 (which was wrong by ~1.5% in 2025-2026).
      return res.status(400).json({
        success: false,
        error: "exchange_rate_required",
        hint: "Set orders.exchange_rate on the order, or POST /api/db/exchange-rate {action:'refresh'} to populate exchange_rates table.",
      });
    }

    // ── §1 Purchase: aggregate IV totals ──
    let iv_total = 0;
    let iv_currency = ordersRes.rows[0].currency || "USD";
    let total_ctn = 0;
    let total_containers = 0;
    let incoterm = ordersRes.rows[0].trade_terms || "—";
    const iv_refs = [];
    const sku_lines = [];  // collected from all sibling orders

    for (const ord of ordersRes.rows) {
      iv_total += Number(ord.total_amount) || 0;
      total_ctn += Number(ord.total_qty) || 0;
      total_containers += Number(ord.container_qty) || 0;
      // NOTE: company_code intentionally OMITTED — anti-counterfeit ID, never to customer payload.
      iv_refs.push({
        order_no: ord.order_no,
        contract_no: ord.contract_no,
        amount: Number(ord.total_amount) || 0,
      });

      const products = Array.isArray(ord.raw?.products) ? ord.raw.products : [];
      for (const p of products) {
        const ctn = Number(p.qty) || 0;
        if (ctn <= 0) continue;
        sku_lines.push({
          order_no: ord.order_no,
          sku: p.sku || p.barcode || "—",
          name: p.name || "—",
          ctn,
          unit: p.unit || "CTN",
          size: p.size || "",
          units_per_ctn: unitsPerCtn(p.size),
          unit_price: Number(p.price || p.unit_price) || 0,
        });
      }
    }

    // ── §2 Freight bundle (sum across multiple FDNs for same BL) ──
    let usd_freight_direct = 0;
    let cny_subtotal = 0;
    const fee_breakdown = {
      thc: 0, crane: 0, storage: 0, port_entry: 0, pickup: 0, parking: 0, trucking: 0,
      edi: 0, customs: 0, doc: 0, epacking: 0, booking: 0, barcode: 0, packing: 0,
    };
    for (const f of fdnRes.rows) {
      usd_freight_direct += Number(f.usd_freight) || 0;
      const ticket = Number(f.ticket_count) || 1;
      const box = Number(f.box_count) || 1;
      // Per-BL × ticket_count (Zone D)
      fee_breakdown.edi      += (Number(f.fee_edi)      || 0) * ticket;
      fee_breakdown.customs  += (Number(f.fee_customs)  || 0) * ticket;
      fee_breakdown.doc      += (Number(f.fee_doc)      || 0) * ticket;
      fee_breakdown.epacking += (Number(f.fee_epacking) || 0) * ticket;
      fee_breakdown.booking  += (Number(f.fee_booking)  || 0) * ticket;
      fee_breakdown.barcode  += (Number(f.fee_barcode)  || 0) * ticket;
      fee_breakdown.packing  += (Number(f.fee_packing)  || 0) * ticket;
      // Per-container × box_count (Zone E)
      fee_breakdown.thc        += (Number(f.fee_thc)        || 0) * box;
      fee_breakdown.crane      += (Number(f.fee_crane)      || 0) * box;
      fee_breakdown.storage    += (Number(f.fee_storage)    || 0) * box;
      fee_breakdown.port_entry += (Number(f.fee_port_entry) || 0) * box;
      fee_breakdown.pickup     += (Number(f.fee_pickup)     || 0) * box;
      fee_breakdown.parking    += (Number(f.fee_parking)    || 0) * box;
      fee_breakdown.trucking   += (Number(f.fee_trucking)   || 0) * box;
    }
    cny_subtotal = Object.values(fee_breakdown).reduce((a, b) => a + b, 0);
    const cny_in_usd = cny_subtotal / fx.rate;
    const freight_total_usd = usd_freight_direct + cny_in_usd;

    // ── §6 Per-SKU allocation by CTN ratio ──
    const skus = sku_lines.map(s => {
      const freight_share = total_ctn > 0
        ? (freight_total_usd * s.ctn) / total_ctn
        : 0;
      const iv_line = s.unit_price * s.ctn * s.units_per_ctn;
      const landed_total = iv_line + freight_share;
      return {
        ...s,
        iv_total: iv_line,
        freight_share,
        landed_total,
        per_ctn: s.ctn > 0 ? landed_total / s.ctn : 0,
        per_unit: (s.ctn * s.units_per_ctn) > 0 ? landed_total / (s.ctn * s.units_per_ctn) : 0,
      };
    });

    const freight_status = fdnRes.rows.length === 0 ? "pending" : "available";

    return res.status(200).json({
      success: true,
      bl_no,
      bl: {
        vessel: ordersRes.rows[0].vessel,
        voyage: ordersRes.rows[0].voyage,
        etd: ordersRes.rows[0].etd,
        eta: ordersRes.rows[0].eta,
        pol: ordersRes.rows[0].pol,
        pod: ordersRes.rows[0].destination_port,
        container_count: total_containers,
        container_type: ordersRes.rows[0].container_type,
        total_ctn,
      },
      purchase: {
        iv_total,
        currency: iv_currency,
        incoterm,
        iv_refs,
      },
      freight: {
        status: freight_status,
        usd_freight_direct,
        cny_subtotal,
        cny_in_usd,
        subtotal_usd: freight_total_usd,
        fee_breakdown,
        fdn_count: fdnRes.rows.length,
        fdn_refs: fdnRes.rows.map(f => ({ ref_no: f.ref_no, status: f.status, issued_at: f.issued_at })),
      },
      fx: {
        rate_applied: fx.rate,
        base_rate: fx.base,
        markup: DEFAULT_FX_MARKUP,
        source: fx.source,
      },
      skus,
      totals: {
        ctn: total_ctn,
        iv: iv_total,
        freight: freight_total_usd,
        landed: iv_total + freight_total_usd,
        avg_per_ctn: total_ctn > 0 ? (iv_total + freight_total_usd) / total_ctn : 0,
      },
      meta: {
        allocation: "by_ctn",
        privacy_note: "Sanlyn auto-fills §1+§2. §3-5 are customer-entered, not stored.",
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[landed-cost]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
