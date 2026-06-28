// api/db/migrate-freight-debit-notes.js
// POST /api/db/migrate-freight-debit-notes
// Idempotent — safe to run multiple times.
// Creates freight_debit_notes table for 洋宝宝 Freight Debit Note (出单零手填).
//
// Design doc: docs/workstreams/2026-05-customer-order-intake/FREIGHT-DEBIT-NOTE-TABLE-DESIGN-001.md

import { getPool, setCors } from '../db.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS freight_debit_notes (

        -- ── Primary key ───────────────────────────────────────────
        id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ref_no   TEXT UNIQUE NOT NULL,
        -- format: "FDN-{YYYYMMDD}-{4-digit seq}" e.g. "FDN-20260507-0001"

        -- ── Status ────────────────────────────────────────────────
        status   TEXT NOT NULL DEFAULT 'draft',
        -- draft | issued | paid | void

        -- ── Relations ─────────────────────────────────────────────
        shipping_plan_id   TEXT,
        -- soft link to shipping_plans.shipment_no (TEXT, not FK — allows orphan drafts)
        order_intake_id    UUID,
        -- back-link to order_intakes.id if created from intake (nullable)

        -- ── Header · Zone A ───────────────────────────────────────
        bl_no          TEXT,           -- {{BL_NO}}      B/L number
        etd            DATE,           -- {{ETD}}        Estimated Departure
        container_type TEXT,           -- {{CONTAINER}}  e.g. "40HQ"
        pod            TEXT,           -- {{POD}}        Port of Discharge
        incoterm       TEXT,           -- {{INCOTERM}}   e.g. "FOB" / "CIF"
        work_no        TEXT,           -- {{WORK_NO}}    Internal reference / work order no.

        -- ── Ticket & Box count · Zone B ───────────────────────────
        ticket_count   SMALLINT NOT NULL DEFAULT 1,  -- {{TICKET_COUNT}} # of B/Ls
        box_count      SMALLINT NOT NULL DEFAULT 1,  -- {{BOX_COUNT}}    # of containers

        -- ── Consignee · Zone C ────────────────────────────────────
        customer_en    TEXT,           -- {{CUSTOMER_EN}}   short English name
        customer_full  TEXT,           -- {{CUSTOMER_FULL}} full name incl. CN
        customer_note  TEXT,           -- {{CUSTOMER_NOTE}} address / contact (nullable)

        -- ── CNY port charges: per B/L · Zone D ───────────────────
        -- Stored as unit price; display = value × ticket_count
        fee_edi        NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{EDI}}      EDI fee
        fee_customs    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{CUSTOMS}}  Customs clearance
        fee_doc        NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{DOC}}      Documentation
        fee_epacking   NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{EPACKING}} E-packing list
        fee_booking    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{BOOKING}}  Booking fee
        fee_barcode    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{BARCODE}}  Barcode fee
        fee_packing    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{PACKING}}  Packing list fee

        -- ── CNY port charges: per container · Zone E ──────────────
        -- Stored as unit price; display = value × box_count
        fee_thc        NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{THC}}        Terminal handling
        fee_crane      NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{CRANE}}      Crane fee
        fee_storage    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{STORAGE}}    Storage fee
        fee_port_entry NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{PORT_ENTRY}} Port entry
        fee_pickup     NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{PICKUP}}     Container pickup
        fee_parking    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{PARKING}}    Parking fee
        fee_trucking   NUMERIC(10,2) NOT NULL DEFAULT 0,   -- {{TRUCKING}}   Trucking fee

        -- ── Totals · Zone F ───────────────────────────────────────
        cny_total      NUMERIC(12,2),  -- {{CNY_TOTAL}}   Σ per-BL × ticket + Σ per-container × box
        usd_freight    NUMERIC(12,2),  -- {{USD_FREIGHT}} Ocean freight in USD

        -- ── FX snapshot · Zone G ──────────────────────────────────
        fx_rate_snapshot NUMERIC(8,4),
        -- Live rate at issuance (fetched from open.er-api.com, stored to prevent drift)
        fx_markup        NUMERIC(4,2) NOT NULL DEFAULT 0.10,
        -- Markup over mid-rate (template default +0.10)

        -- ── Issuer (Ocean Baby default, changeable) ───────────────
        issuer     TEXT NOT NULL DEFAULT '上海洋宝宝国际物流有限公司',
        issuer_en  TEXT NOT NULL DEFAULT 'Shanghai Ocean Baby International Logistics Co., Ltd.',

        -- ── Metadata ──────────────────────────────────────────────
        created_by   TEXT,
        issued_by    TEXT,
        issued_at    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),

        -- ── Snapshot backup ───────────────────────────────────────
        raw          JSONB DEFAULT '{}'
        -- Full field snapshot at issuance for audit / dispute prevention
      );

      CREATE INDEX IF NOT EXISTS idx_fdn_status        ON freight_debit_notes(status);
      CREATE INDEX IF NOT EXISTS idx_fdn_shipping_plan ON freight_debit_notes(shipping_plan_id);
      CREATE INDEX IF NOT EXISTS idx_fdn_created_at    ON freight_debit_notes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fdn_bl_no         ON freight_debit_notes(bl_no);
      CREATE INDEX IF NOT EXISTS idx_fdn_customer_en   ON freight_debit_notes(customer_en);
    `);

    res.json({ success: true, message: 'freight_debit_notes table ready' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
