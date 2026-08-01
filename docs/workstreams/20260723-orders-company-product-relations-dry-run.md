# Orders Company/Product Relations Dry-Run

Date: 2026-07-23
Branch observed: `overhaul/po-frame-v1`
Scope: forge brief M1/M1b/M2/M3/M4/M5/M6, artifact-only. No `--apply`.

## Files

- `migrations/M036-20260723-orders-company-product-relations-dry-run.sql`
- `migrations/M036-20260723-orders-company-product-relations-verify.sql`
- `migrations/M036-20260723-orders-company-product-relations-rollback.sql`

## What The Dry-Run Does

- Adds missing ID columns in a transaction:
  `seller_company_id`, `buyer_company_id`, `customer_company_id`,
  `issuing_company_id`, `operating_company_id`, `owner_company_id`,
  `factory_company_id`, `supplier_company_id`, `supplier_role_at_hop`,
  `trader_company_id`.
- Adds `seller_profiles.company_id` and treats `seller_profiles` as issuing
  document config rather than legal company identity.
- Maps seller config codes to company IDs:
  `BABI` and `petbaby` -> `companies.id = 37`;
  `OCEANBABY` and `yangbaobao` -> `companies.id = 38`.
- Backfills orders with `COALESCE` only:
  seller from the fixed company map, buyer/customer from `company_code`,
  factory from `factory_code`, issuing from seller/company name, supplier hop
  only when active `partner_relationships` has a single unambiguous edge.
- Inserts independent field relations for each `orders -> companies` role,
  plus `orders -> order_line_items`, `order_line_items.product_id -> products.id`,
  and the logical SKU relation.
- Inserts snapshot-mode lookups for seller/buyer/factory company identity data
  that exists on `companies`. Bank/seal remain a follow-up because current code
  evidence still points to `seller_profiles` and `customer_stamps`, not stable
  `companies` columns.
- Produces unresolved reports, customers missing from `companies`, product
  link gaps, duplicate SKU ambiguity, and text snapshot columns that must move
  to ID-only write paths.

## Red Lines Preserved

- No weight, quantity, CBM, or amount calculation is touched.
- `orders.factory_code` is never updated, so BABI cannot be written into the
  factory field by this migration.
- Existing non-null FK values are not overwritten.
- Ambiguous `partner_relationships` supplier hops are reported unresolved.
- Products three-table split is not applied.

## Required Prod Sequence

1. Take backup on Tencent before any apply:

   ```bash
   pg_dump "$DATABASE_URL" \
     --table=orders \
     --table=seller_profiles \
     --table=partner_relationships \
     --table=field_relations \
     --table=field_lookups \
     --file="/tmp/m036-orders-company-product-$(date -u +%Y%m%dT%H%M%SZ).sql"
   ```

2. Run dry-run in one Tencent DB session:

   ```bash
   psql "$DATABASE_URL" \
     -v ON_ERROR_STOP=1 \
     -f migrations/M036-20260723-orders-company-product-relations-dry-run.sql
   ```

3. Damon/Claude review the report blocks printed before `ROLLBACK`.

4. Only after approval, derive an apply script from the dry-run by replacing
   the final `ROLLBACK;` with `COMMIT;`, then run `verify.sql`.

## Known Limits

- Local sandbox cannot reach the DB (`EPERM 127.0.0.1:5432`), so the prod
  `BEGIN ... ROLLBACK` has not been executed from this Codex environment.
- M1b tax number enrichment is intentionally not automated here. The script
  reports missing `customers -> companies` rows and missing `companies.tax_id`;
  Tianyancha evidence must be collected separately before writing those values.
- M6 API write-path hardening is identified but not patched here because this
  repository has substantial unrelated live drift in order/document files. The
  current safe deliverable is DB dry-run artifacts plus the explicit list of
  text snapshot columns that must be removed from direct write paths.
