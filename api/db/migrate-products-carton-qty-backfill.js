import { getPool, setCors } from "../db.js";

// migrate-products-carton-qty-backfill (2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────
// Source: 产品条形码-已确认.xlsx (factory-confirmed barcode + spec sheet)
// Fills: carton_qty, box_l/w/h, net_weight, gross_weight, cbm
//        spec_source='factory_spec', spec_verified=TRUE
//
// Match key: sku + barcode  (never updates a row it can't uniquely identify)
// Safety:    ALL fields use COALESCE → never overwrites existing data
// Scope:     干粮 + 零食 sheets (267 rows); 湿粮 has no logistics data
// No DELETE / DROP / TRUNCATE anywhere in this file

const STMTS = [
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-01",
      "6927749823049"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-02",
      "6927749823056"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFD-01",
      "6927749823063"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-01",
      "6927749823070"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-02",
      "6927749823162"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-03",
      "6927749823179"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-03",
      "6927749823186"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-04",
      "6927749823193"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-02",
      "6927749825098"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-03",
      "6927749825104"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-03",
      "6927749825128"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-02",
      "6927749825111"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-04",
      "6927749825210"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-01",
      "6927749823087"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-02",
      "6927749823094"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFD-01",
      "6927749823100"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-01",
      "6927749823117"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-02",
      "6927749823292"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-03",
      "6927749823308"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-03",
      "6927749823315"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-04",
      "6927749823322"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-02",
      "6927749825135"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-03",
      "6927749825142"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-02",
      "6927749825159"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-03",
      "6927749825166"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-04",
      "6927749825128"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-01",
      "6927749823124"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-02",
      "6927749823131"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFD-01",
      "6927749823148"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-01",
      "6927749823155"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-02",
      "6927749823254"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-03",
      "6927749823261"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-03",
      "6927749823278"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      45.0,
      13.0,
      55.0,
      12.0,
      12.21,
      0.032175,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-04",
      "6927749823285"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-02",
      "6927749825173"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-03",
      "6927749825180"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-02",
      "6927749825197"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-03",
      "6927749825203"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-04",
      "6927749825289"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-05",
      "8720938000546"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-06",
      "8720938000553"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-07",
      "8720938000560"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-08",
      "8720938000577"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-02",
      "8720938000584"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-02",
      "8720938000591"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-01",
      "8720938000607"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-03",
      "8720938000614"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-01",
      "6927749825012"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-01",
      "6927749825029"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFM-01",
      "6927749825036"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      44.4,
      36.4,
      25.3,
      12.0,
      13.0,
      0.04088885,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-01",
      "6927749825043"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-01",
      "6927749825050"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFC-01",
      "6927749825067"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFM-01",
      "6927749825074"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      8.0,
      8.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-01",
      "6927749825081"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-05",
      "8720938000621"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-06",
      "8720938000638"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-07",
      "8720938000645"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-08",
      "8720938000652"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-02",
      "8720938000669"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-02",
      "8720938000676"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-01",
      "8720938000683"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.4,
      18.6,
      57.7,
      10.0,
      11.0,
      0.04765097,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-03",
      "8720938000690"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-05",
      "8720938000706"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-06",
      "8720938000713"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-07",
      "8720938000720"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-08",
      "8720938000737"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-02",
      "8720938000744"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-02",
      "8720938000751"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-01",
      "8720938000768"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      4,
      40.0,
      34.0,
      29.5,
      12.0,
      13.0,
      0.04012,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-03",
      "8720938000775"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-05",
      "8720938000782"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-06",
      "8720938000799"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-07",
      "8720938000805"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CFF-08",
      "8720938000812"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFM-02",
      "8720938000829"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFL-02",
      "8720938000836"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFF-01",
      "8720938000843"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      1,
      37.0,
      13.0,
      50.0,
      7.0,
      7.18,
      0.02405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DFC-03",
      "8720938000850"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      36.8,
      10.0,
      12.0,
      0.06174893,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-04H",
      "6927749810889"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      45.0,
      37.0,
      19.0,
      2.4,
      5.0,
      0.031635,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-08H",
      "6927749860167"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      39.0,
      27.0,
      34.0,
      3.0,
      5.0,
      0.035802,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-08H",
      "6927749860174"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      45.0,
      37.0,
      19.0,
      4.6,
      7.0,
      0.031635,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-32H",
      "6927749860181"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      39.4,
      26.9,
      35.8,
      6.0,
      8.0,
      0.03794299,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-32H",
      "6927749860198"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.4,
      40.4,
      16.3,
      3.0,
      5.0,
      0.02660421,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-49H",
      "6927749860204"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      32.8,
      10.0,
      12.0,
      0.05503709,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "6927749810308"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      40.4,
      40.4,
      30.8,
      9.08,
      12.0,
      0.05027053,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "6927749810322"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      48.9,
      33.9,
      46.3,
      10.9,
      12.0,
      0.07675197,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "6927749810131"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-03H",
      "6927749810643"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      5.45,
      7.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-03H",
      "6927749812449"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04H",
      "6927749810612"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      28.8,
      10.0,
      12.0,
      0.04832525,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04S",
      "6927749810339"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CB-02H",
      "6927749810650"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CB-06S",
      "6927749810926"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-01S",
      "6927749810636"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-02S",
      "6927749810629"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      32.8,
      10.0,
      12.0,
      0.05503709,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-02H",
      "6927749812418"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      36.3,
      10.0,
      12.0,
      0.06090995,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-04H",
      "6927749810896"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      39.8,
      10.0,
      12.0,
      0.06678281,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-08H",
      "6927749810278"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      64.6,
      40.4,
      35.4,
      5.4,
      7.0,
      0.09238834,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-08H",
      "6927749810599"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      8,
      64.2,
      55.6,
      17.4,
      4.08,
      7.0,
      0.06210965,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-10H",
      "6927749810582"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      36.8,
      10.0,
      12.0,
      0.06174893,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-10H",
      "6927749810919"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      40.4,
      27.9,
      36.8,
      4.8,
      6.0,
      0.04147949,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-10H",
      "6927749812333"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      4.8,
      6.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-10H",
      "6927749812432"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      64.6,
      38.8,
      26.0,
      7.92,
      10.0,
      0.06516848,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-13H",
      "6927749810551"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      32.8,
      10.0,
      12.0,
      0.05503709,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-01H",
      "6927749810346"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-08H",
      "6927749810353"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      40.4,
      40.4,
      27.8,
      9.08,
      12.0,
      0.04537405,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-08H",
      "6927749844228"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      32.8,
      10.0,
      12.0,
      0.05503709,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-16H",
      "6927749812302"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-19H",
      "6927749812425"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "6927749820048"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      40.4,
      40.4,
      30.8,
      9.08,
      12.0,
      0.05027053,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "6927749820017"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      4.8,
      7.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "6927749820031"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      48.9,
      33.9,
      46.3,
      10.9,
      12.0,
      0.07675197,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "6927749820031"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      28.8,
      10.0,
      12.0,
      0.04832525,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-02S",
      "6927749820123"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      37.8,
      10.0,
      12.0,
      0.06342689,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-06H",
      "6927749820383"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-12S",
      "6927749820369"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DB-13",
      "6927749869016"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      39.4,
      26.4,
      34.8,
      6.0,
      8.0,
      0.03619757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DB-13",
      "6927749869030"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DB-16",
      "6927749869009"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      38.8,
      10.0,
      12.0,
      0.06510485,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DD-02H",
      "6927749820352"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      39.4,
      26.9,
      34.8,
      4.8,
      6.0,
      0.03688313,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DD-02H",
      "6927749820406"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DE-08H",
      "6927749820376"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      7.2,
      10.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DE-08H",
      "6927749820451"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      34.8,
      10.0,
      12.0,
      0.05839301,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FA-31",
      "6927749868019"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FA-32",
      "6927749868002"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      39.0,
      26.5,
      34.0,
      5.4,
      8.0,
      0.035139,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FA-32",
      "6927749868033"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      36.8,
      10.0,
      12.0,
      0.06174893,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "K-01",
      "6927749860044"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      34.8,
      10.0,
      12.0,
      0.05839301,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "K-12",
      "6927749860136"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "LA-03S",
      "6927749840046"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      36.8,
      10.0,
      12.0,
      0.06174893,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "LA-05H",
      "6927749840206"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.0,
      40.0,
      26.0,
      9.0,
      12.0,
      0.0416,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "M-02H",
      "6927749813002"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.4,
      30.4,
      18.8,
      4.5,
      7.0,
      0.02308941,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "M-03H",
      "6927749813170"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      6.0,
      8.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-04S",
      "6927749830153"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-15S",
      "6927749830221"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-31",
      "6927749830214"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      64.6,
      40.4,
      35.4,
      5.1,
      7.0,
      0.09238834,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MD-01H",
      "6927749830207"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      46.8,
      10.0,
      12.0,
      0.07852853,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-01H",
      "6927749810193"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      3.6,
      6.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-01H",
      "6927749813187"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      46.8,
      10.0,
      12.0,
      0.07852853,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-02H",
      "6927749820086"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      39.4,
      26.9,
      36.2,
      4.56,
      6.0,
      0.03836693,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-02H",
      "6927749820413"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      3.6,
      6.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-02H",
      "6927749820567"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      46.8,
      10.0,
      12.0,
      0.07852853,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-04H",
      "6927749840039"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-14",
      "6927749869047"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      10.0,
      12.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "VA-01H",
      "6927749812777"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      6,
      49.4,
      33.9,
      24.3,
      5.45,
      7.0,
      0.04069424,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "VA-01H",
      "6927749813194"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      36,
      40.4,
      30.4,
      20.8,
      1.44,
      3.0,
      0.02554573,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-02",
      "6927749812340"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.4,
      30.4,
      20.8,
      1.2,
      3.0,
      0.02554573,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-03",
      "6927749812364"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.4,
      30.4,
      20.8,
      1.2,
      3.0,
      0.02554573,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-04",
      "6927749812371"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.4,
      30.4,
      20.8,
      1.2,
      3.0,
      0.02554573,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-07",
      "6927749812357"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      30,
      40.4,
      30.4,
      20.8,
      1.2,
      3.0,
      0.02554573,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FDA-04",
      "6927749820420"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      36,
      40.4,
      30.4,
      20.8,
      1.44,
      3.0,
      0.02554573,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FMA-01",
      "6927749830160"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      21.8,
      9.6,
      12.0,
      0.03657953,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04S-01",
      "6927749811299"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-09H",
      "6927749811343"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      22.8,
      9.6,
      10.0,
      0.03825749,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-04S",
      "6927749811336"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-05S",
      "6927749811305"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-10S",
      "6927749811350"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-02S-01",
      "6927749811466"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      18.3,
      1.2,
      3.0,
      0.02247533,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-10-1",
      "6927749811565"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.3,
      0.6,
      2.0,
      0.02370349,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FFA-03",
      "6927749811480"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.3,
      1.2,
      3.0,
      0.02370349,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FSA-01",
      "6927749811473"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      47.4,
      35.4,
      28.8,
      7.0,
      10.0,
      0.04832525,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-66H",
      "6927749813309"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      47.4,
      35.4,
      32.3,
      5.5,
      8.0,
      0.05419811,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CF-15H",
      "6927749813316"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      43.8,
      10.0,
      12.0,
      0.07349465,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "K-33",
      "6927749813248"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      43.8,
      10.0,
      12.0,
      0.07349465,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "K-34",
      "6927749839996"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      43.8,
      10.0,
      12.0,
      0.07349465,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "K-35",
      "6927749813255"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      43.8,
      10.0,
      12.0,
      0.07349465,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "K-36",
      "6927749860211"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      10.0,
      12.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-28",
      "6927749813231"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      10.0,
      12.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-29",
      "6927749820574"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      10.0,
      12.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-30",
      "6927749840206"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      10.0,
      12.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-31",
      "6927749868064"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      10.0,
      12.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-32",
      "6927749830283"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.8,
      1.2,
      3.0,
      0.02431757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-01-01",
      "6927749811589"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.8,
      1.2,
      3.0,
      0.02431757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FDA-01-01",
      "6927749811596"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      60.1,
      41.3,
      19.1,
      0.39,
      2.0,
      0.04740868,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-15",
      "6927749811602"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      60.1,
      41.3,
      19.1,
      0.39,
      2.0,
      0.04740868,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-16",
      "6927749811626"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      39.8,
      32.2,
      39.6,
      1.2,
      3.0,
      0.05074978,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-14",
      "6927749813286"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      39.8,
      32.2,
      39.6,
      1.2,
      3.0,
      0.05074978,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-13",
      "6927749813262"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.8,
      1.8,
      3.0,
      0.02431757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-17",
      "6927749811671"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.8,
      1.8,
      3.0,
      0.02431757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-18",
      "6927749811688"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.8,
      1.8,
      3.0,
      0.02431757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FCA-19",
      "6927749811701"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      60,
      40.4,
      30.4,
      19.8,
      1.8,
      3.0,
      0.02431757,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FDA-07",
      "6927749811695"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      37.8,
      10.0,
      12.0,
      0.06342689,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-20H",
      "6927749813200"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      28.8,
      10.0,
      12.0,
      0.04832525,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CB-36S",
      "6927749813217"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      37.8,
      6.0,
      8.0,
      0.06342689,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CB-60H",
      "6927749812487"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      20.8,
      6.0,
      8.0,
      0.03490157,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-63H",
      "6927749811640"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      20.8,
      6.0,
      8.0,
      0.03490157,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-64H",
      "6927749811664"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      20.8,
      6.0,
      8.0,
      0.03490157,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-65H",
      "6927749811657"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      44.0,
      36.0,
      18.0,
      4.6,
      7.0,
      0.028512,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-02H",
      "6927749860143"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      40.0,
      27.5,
      35.0,
      5.76,
      8.0,
      0.0385,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-02H",
      "6927749860150"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      50.4,
      29.6,
      40.6,
      5.4,
      7.0,
      0.0605687,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-34",
      "6927749811718"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      50.4,
      29.6,
      40.6,
      5.4,
      7.0,
      0.0605687,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-35",
      "6927749811725"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      50.4,
      29.6,
      40.6,
      5.4,
      7.0,
      0.0605687,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-36",
      "6927749811732"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      50.4,
      29.6,
      40.6,
      5.4,
      7.0,
      0.0605687,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-37",
      "6927749811749"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "8718692582002"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      30.4,
      30.4,
      25.3,
      3.6,
      6.0,
      0.02338125,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "8718692582255"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04S",
      "8718692582033"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      30.5,
      30.5,
      20.0,
      3.6,
      6.0,
      0.018605,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04S",
      "8720256113690"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      7.65,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-10S-01",
      "8718692582347"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.48,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-14S",
      "872056113003"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CB-02H",
      "8718692582316"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-01S",
      "8718692582040"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.48,
      9.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-01S-M",
      "8718692582569"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.48,
      9.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-09S",
      "8718692582576"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-25S",
      "8718692582019"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      29.4,
      29.4,
      19.8,
      4.0,
      6.0,
      0.01711433,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-25S",
      "8718692582293"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-04H",
      "8718692582323"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      30.4,
      30.4,
      21.8,
      3.6,
      6.0,
      0.02014669,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-04H",
      "8720938000003"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.12,
      8.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-10H",
      "8718692582354"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-08H",
      "8718692582026"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      30.4,
      30.4,
      22.8,
      3.6,
      6.0,
      0.02107085,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-08H",
      "8718692582262"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.48,
      9.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-19H",
      "8718692582361"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.48,
      9.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CH-04S",
      "8720256113607"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      66.7,
      45.0,
      20.6,
      5.4,
      7.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CH-02S",
      "8720256113614"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "8718692582309"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      10,
      29.4,
      29.4,
      21.8,
      3.6,
      6.0,
      0.01884305,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "8718692582286"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DB-10",
      "8718692582071"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DB-16",
      "8720256113010"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FA-08S",
      "8720256113621"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      66.7,
      45.0,
      20.6,
      6.48,
      9.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FA-36",
      "8718692582606"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-02-01",
      "8718692582583"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      8.1,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-04-01",
      "8718692582590"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      9.0,
      11.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SC-13",
      "8718692582088"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      9.0,
      11.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SC-14",
      "8718692582095"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      15,
      66.7,
      45.0,
      20.6,
      7.65,
      10.0,
      0.0618309,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "VA-01H",
      "8718692582330"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      66.7,
      39.0,
      18.6,
      6.0,
      8.0,
      0.04838418,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-09H-01",
      "8718692582125"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      66.7,
      39.0,
      18.6,
      6.0,
      8.0,
      0.04838418,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-04S",
      "8718692582422"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      66.7,
      39.0,
      18.6,
      6.0,
      8.0,
      0.04838418,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-10S",
      "8718692582439"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      66.7,
      39.0,
      18.6,
      6.0,
      8.0,
      0.04838418,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-10H-01",
      "8718692582118"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      66.7,
      39.0,
      18.6,
      6.0,
      8.0,
      0.04838418,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-02",
      "8718692582132"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      66.7,
      39.0,
      18.6,
      6.0,
      8.0,
      0.04838418,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-13",
      "8718692582101"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      30.8,
      8.0,
      10.0,
      0.05168117,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "BA-04H",
      "6927749810162"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      8.0,
      10.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "6927749810148"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-01H",
      "6927749810483"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      27.8,
      8.0,
      10.0,
      0.04664729,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-03H-6",
      "6927749812401"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      12,
      48.8,
      45.2,
      23.6,
      8.0,
      10.0,
      0.05205594,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04H",
      "6927749810155"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04H",
      "6927749810506"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      8.0,
      10.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04H-3",
      "6927749812395"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      26.8,
      8.0,
      10.0,
      0.04496933,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-01S",
      "6927749810186"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      46.3,
      34.3,
      28.6,
      8.0,
      10.0,
      0.04541937,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-02S",
      "6927749810674"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      27.8,
      8.0,
      10.0,
      0.04664729,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-09S",
      "6927749810681"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      32.8,
      8.0,
      10.0,
      0.05503709,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CD-04H",
      "6927749810667"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      30.8,
      8.0,
      10.0,
      0.05168117,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-10H - CD-10H",
      "6927749812388"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      31.8,
      8.0,
      10.0,
      0.05335913,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CE-08H",
      "6927749810179"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      29.8,
      8.0,
      10.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "6927749820079"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      20,
      47.4,
      35.4,
      29.8,
      10.0,
      12.0,
      0.05000321,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-01H",
      "6927749820093"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      30.8,
      8.0,
      10.0,
      0.05168117,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DD-10H",
      "6927749820444"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      27.8,
      8.0,
      10.0,
      0.04664729,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DE-08H",
      "6927749820437"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      27.8,
      8.0,
      10.0,
      0.04664729,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "FA-53",
      "6927749868040"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      25.8,
      8.0,
      10.0,
      0.04329137,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "LA-03S",
      "6927749840220"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      25.8,
      8.0,
      10.0,
      0.04329137,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-04S",
      "6927749830177"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      32.8,
      8.0,
      10.0,
      0.05503709,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-14H",
      "6927749830184"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-15S",
      "6927749830245"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      25.8,
      8.0,
      10.0,
      0.04329137,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "MA-30H",
      "6927749830191"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      34.8,
      8.0,
      10.0,
      0.05839301,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-02H",
      "6927749820116"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      34.8,
      8.0,
      10.0,
      0.05839301,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SA-04H",
      "6927749840053"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      21.8,
      8.0,
      10.0,
      0.03657953,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-01",
      "6927749810728"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      21.8,
      8.0,
      10.0,
      0.03657953,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-02",
      "6927749820130"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      22.8,
      8.0,
      10.0,
      0.03825749,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-04S-01",
      "6927749811077"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      20.8,
      8.0,
      10.0,
      0.03490157,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CA-09H",
      "6927749811084"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-04S",
      "6927749811114"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-05S",
      "6927749811107"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      24.8,
      8.0,
      10.0,
      0.04161341,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-08S-01",
      "6927749811091"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      21.8,
      8.0,
      10.0,
      0.03657953,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "CC-10S",
      "6927749811145"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      22.8,
      8.0,
      10.0,
      0.03825749,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "DA-02S-01",
      "6927749811497"
    ]
  },
  {
    "sql": "UPDATE products SET carton_qty = COALESCE(carton_qty, $1::int), box_l = COALESCE(box_l, $2::numeric), box_w = COALESCE(box_w, $3::numeric), box_h = COALESCE(box_h, $4::numeric), net_weight = COALESCE(net_weight, $5::numeric), gross_weight = COALESCE(gross_weight, $6::numeric), cbm = COALESCE(cbm, $7::numeric), spec_source = COALESCE(spec_source, $8), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $9) WHERE sku = $10 AND barcode = $11",
    "params": [
      100,
      47.4,
      35.4,
      21.8,
      8.0,
      10.0,
      0.03657953,
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-02-01",
      "6927749811138"
    ]
  },
  {
    "sql": "UPDATE products SET spec_source = COALESCE(spec_source, $1), spec_verified = COALESCE(spec_verified, TRUE), spec_verified_at = COALESCE(spec_verified_at, NOW()), spec_verified_by = COALESCE(spec_verified_by, $2) WHERE sku = $3 AND barcode = $4",
    "params": [
      "factory_spec",
      "factory_confirmed_xlsx_2026-05-20",
      "SB-01-01",
      "6927749811121"
    ]
  }
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const pool = getPool();
    const client = await pool.connect();
    let updated = 0, skipped = 0, errors = [];

    try {
      await client.query("BEGIN");

      for (const s of STMTS) {
        try {
          const r = await client.query(s.sql, s.params);
          if (r.rowCount > 0) updated++;
          else skipped++;  // row didn't match sku+barcode in DB
        } catch (e) {
          errors.push({ sql: s.sql.slice(0, 80), error: e.message });
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // Verification count
    const v = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE carton_qty IS NOT NULL) AS has_carton_qty,
        COUNT(*) FILTER (WHERE box_l IS NOT NULL)      AS has_box_dims,
        COUNT(*) FILTER (WHERE spec_verified = TRUE)   AS spec_verified,
        COUNT(*) FILTER (WHERE spec_source = 'factory_spec') AS factory_spec_sourced,
        COUNT(*) AS total
      FROM products
    `);

    return res.status(200).json({
      migration: "migrate-products-carton-qty-backfill",
      date: "2026-05-20",
      total_statements: STMTS.length,
      updated,
      skipped,
      errors: errors.slice(0, 10),
      verification: v.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
