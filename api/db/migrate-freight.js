import { getPool, setCors } from "../db.js";

// Freight billing schema — 3-layer model
// ──────────────────────────────────────────────────────────────
//   shipping_plans            ← 我司自营订单 (P&L, already exists)
//   shipping_agency_bookings  ← 纯船代 pass-through (福新→PETSOME)
//   freight_supplier_bills    ← 逐票逐科目账单明细 (741 rows on prod)
//
// Admin-only migration. Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING).
// Call: curl -X POST https://api.sanlyn.cn/api/db/migrate-freight \
//         -H "Authorization: Bearer <ADMIN_JWT>"

var STATEMENTS = [
  // ── 1. 船代 pass-through 表 ──
  `CREATE TABLE IF NOT EXISTS shipping_agency_bookings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_no      text,
    bl_no           text,
    vessel          text,
    voyage          text,
    etd             date,
    eta             date,
    atd             date,
    ata             date,
    pol             text,
    pod             text,
    container_no    text,
    container_type  text,
    shipper_3rd     text,
    consignee       text,
    forwarder_cn    text,
    carrier         text,
    our_role        text,
    agency_fee_rmb  numeric,
    incoterm        text,
    raw             jsonb DEFAULT '{}'::jsonb,
    created_at      timestamptz DEFAULT NOW(),
    updated_at      timestamptz DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_bl_booking
    ON shipping_agency_bookings (COALESCE(bl_no,''), COALESCE(booking_no,''))`,

  // ── 2. 供应商账单明细表 ──
  `CREATE TABLE IF NOT EXISTS freight_supplier_bills (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier        text NOT NULL,
    supplier_type   text,
    bill_month      text,
    bill_file       text,
    bl_no           text,
    container_no    text,
    cost_category   text NOT NULL,
    amount          numeric,
    currency        text,
    qty             numeric,
    unit_price      numeric,
    pair_id         uuid,
    rebill_status   text,
    incoterm        text,
    link_plan_id    text,
    link_agency_id  uuid,
    reconciled      boolean DEFAULT false,
    reconcile_note  text,
    source_row      text,
    raw             jsonb DEFAULT '{}'::jsonb,
    created_at      timestamptz DEFAULT NOW(),
    updated_at      timestamptz DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS ix_bills_bl       ON freight_supplier_bills (bl_no)`,
  `CREATE INDEX IF NOT EXISTS ix_bills_month    ON freight_supplier_bills (bill_month)`,
  `CREATE INDEX IF NOT EXISTS ix_bills_supplier ON freight_supplier_bills (supplier)`,

  // ── 3. 福新 (宣城) → PETSOME pass-through 种子 (booking_only, 不入 P&L) ──
  `INSERT INTO shipping_agency_bookings
    (bl_no,etd,carrier,vessel,voyage,pol,pod,container_no,shipper_3rd,consignee,forwarder_cn,our_role,incoterm,raw)
   VALUES
    ('177IBLBLN8D981A','2025-07-09','MSC','MSC CALIDRIS III','HB527A','NINGBO','PORT_KLANG','BEAU5837147',
     '福新(宣城)宠物食品','PETSOME','洋宝宝','booking_only','EXW',
     '{"note":"福新直发pass-through,不进P&L","tagged_at":"2026-04-21"}'::jsonb),
    ('177IGJGJN57584A','2025-12-31','MSC','MSC REBECCA III','HU601A','NINGBO','PORT_KLANG','MSDU8815838',
     '福新(宣城)宠物食品','PETSOME','洋宝宝','booking_only','EXW',
     '{"note":"福新直发pass-through,不进P&L","tagged_at":"2026-04-21"}'::jsonb),
    ('177IGJGJN57623A','2026-01-12','MSC','MSC KOREA III','HU602A','NINGBO','PORT_KLANG','MSNU8843737',
     '福新(宣城)宠物食品','PETSOME','洋宝宝','booking_only','EXW',
     '{"note":"福新直发pass-through,不进P&L","tagged_at":"2026-04-21"}'::jsonb)
   ON CONFLICT (COALESCE(bl_no,''),COALESCE(booking_no,'')) DO NOTHING`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST required" });
  }

  var pool = getPool();
  var results = [];
  try {
    for (var i = 0; i < STATEMENTS.length; i++) {
      await pool.query(STATEMENTS[i]);
      results.push({ step: i + 1, ok: true });
    }
    return res.status(200).json({
      ok: true,
      total: STATEMENTS.length,
      results,
      note: "Schema + 3 福新 pass-through seeds. 741-row data snapshot lives in sql/03_data.sql (not auto-applied — prod already has it).",
    });
  } catch (e) {
    console.error("[migrate-freight]", e);
    return res.status(500).json({ error: e.message, stepsDone: results.length });
  }
}
