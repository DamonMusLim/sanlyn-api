# P0a External Order Identity Plan

## Scope

P0a only adds a read-only classifier and a dry-run candidate list. It does not write database rows, change audit or health endpoints, touch frontend code, deploy, commit, or backfill `shipping_plans.source_system`.

## Classifier Priority

`api/db/lib/external-order.js` exports `isFreightAgency(plan, options)`.

1. `plan.source_system === "freight_agency"` returns `true`.
2. `plan.raw.order_type === "external"` returns `true`.
3. Non-empty `shipper` whose normalized name is not in the Sanlyn entity whitelist returns `"candidate"`.
4. Everything else returns `false`.

Empty `shipper` is not treated as internal evidence. The dry-run script reports those rows separately as `unknown_missing_shipper`.

## Whitelist Source

The dry-run script loads names from `companies WHERE is_sanlyn_entity = true`, using available name columns such as `name_cn`, `name_en`, and alias-like columns when present.

If the schema lacks `is_sanlyn_entity` or no rows are returned, the helper falls back to the P0a brief's Sanlyn group list:

- 厦门巴匕进出口 / XIAMEN PET BABY
- 建平中砂膨润土
- 厦门宠爱我宠物用品
- 富城山凌 / FORTUNESANLYN
- 连云港中砂
- 徐州大之圣

## Normalization

Names are compared conservatively by exact normalized equality only:

- Unicode NFKC normalization
- uppercase
- remove spaces, punctuation, and symbols

There is no substring matching. This avoids loose matches such as swallowing an unrelated external company because it contains `中砂`.

## Candidate Evidence

`api/db/list-external-candidates.mjs` scans `shipping_plans` rows with non-empty `bl_no`, classifies each plan, and writes:

`shipment_no | shipper | customer | bl_no | basis`

Candidate basis is `shipper=X not in Sanlyn entity whitelist`.

## P0b Hook

P0b should take `external-candidates.json`, have Damon confirm which candidates are real external orders, then run a separate idempotent backfill that only updates confirmed rows to `source_system='freight_agency'`. P0a intentionally leaves that write path out.
