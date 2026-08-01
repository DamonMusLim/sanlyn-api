# Field Truth Gate + Collab Data Gaps

Date: 2026-07-23
Status: dry-run/API contract only; no prod deploy

## Conflict Risk

`/home/damon/canonical/sanlyn-api` currently has unrelated uncommitted drift. This artifact only adds:

- `migrations/M037-20260723-field-truth-gaps-dry-run.sql`
- `docs/workstreams/20260723-field-truth-gate-and-collab-data-gaps.md`

It does not edit live-mounted API files, frontend files, or existing collaboration table structure.

## Schema Source

All referenced columns were checked against `~/field-truth-SCHEMA-PACK.txt`.

Important pack facts:

- `document_missing_items` has 20 existing columns and no PK/unique constraints.
- `collab_submissions.status` only allows `submitted`, `under_review`, `applied`, `rejected`, `superseded`.
- `collab_urges.target_role` only allows `factory`, `customer`, `driver`, `forwarder`, `customs_broker`.
- `products` has `spec_source`, `spec_verified`, `units_source`, `elements_source`, `supplier_company_id`, and `raw`.
- `orders` already has `buyer_company_id`, `customer_company_id`, and `factory_company_id`.

## Dry-Run SQL

File: `migrations/M037-20260723-field-truth-gaps-dry-run.sql`

The migration is intentionally wrapped in `BEGIN ... ROLLBACK`.

It does four things:

1. Preflights every table/column used by the SQL.
2. Adds only these four `document_missing_items` anchor columns in the transaction:
   `module_key`, `record_id`, `owner_company_id`, `required_source`.
3. Stores `truth_requirement` in existing `field_definitions.validation_json`; no new `field_definitions` column.
4. Downgrades `spec_verified=false` in the transaction for bad sources:
   `ai_estimated`, `auto_fill_by_similar`, `estimated_per_item`.
5. Generates first-batch master-data gaps for:
   `ai_estimated` / `auto_fill_by_similar` / `estimated_per_item` rows marked `spec_verified=true`,
   the 2026-06-06 copied `22.45` product price batch `1667..1673`,
   and the DFC-02 50G/500G suspected price conflict.

The dry-run reports counts by module/field/severity and shows a sample of generated gaps.

## Gap Model

`document_missing_items` remains the canonical gap register.

Master-data gaps use:

- `module_key`: `products`, `companies`, `orders`, or `order_line_items`
- `record_id`: target row PK as text
- `owner_company_id`: the external party expected to provide the value/evidence
- `required_source`: `contract`, `measured`, `master_verified`, `derived`, or `free`

For compatibility with current NOT NULL fields, master gaps set:

- `shipment_no = 'MASTER:<module_key>:<record_id>'`
- `doc_type = 'master_data_truth'`
- `raw.gap_key` as the idempotency key

## API Contract

### GET `/api/collab/data-gaps`

Purpose: list fields an external party must supplement.

Auth: magic link token. The server hashes `magic_link_token` and reads `magic_links`.

Fail-closed scope:

- Token must exist, not be expired, not revoked, and `revoked=false`.
- `recipient_role` must match the target gap owner role.
- A caller can only see rows where `document_missing_items.owner_company_id` matches the token scope.
- Query `company_id` is optional and must be equal to token scope when provided.

Query:

```text
company_id optional integer
module optional enum: products|companies|orders|order_line_items
status optional text, default open
```

Response:

```json
{
  "ok": true,
  "company_id": 123,
  "items": [
    {
      "gap_id": 456,
      "module_key": "products",
      "record_id": "1667",
      "field_name": "factory_price",
      "required_source": "contract",
      "severity": "critical",
      "description": "Factory price requires contract evidence.",
      "expected_val": "contract-backed factory_price",
      "actual_val": "22.45",
      "raw": { "sku": "CFC-02" }
    }
  ]
}
```

### POST `/api/collab/data-gaps/submit`

Purpose: external party submits values/evidence. This endpoint never writes master data.

Auth: `magic_link_token` in body; same validation as list.

Request:

```json
{
  "magic_link_token": "raw-token",
  "items": [
    {
      "gap_id": 456,
      "value": "23.80",
      "source_type": "contract",
      "evidence_url": "https://..."
    }
  ]
}
```

Validation:

- Every `gap_id` must be open and scoped to the token company.
- `source_type` must satisfy `required_source`.
- `evidence_url` is required for `contract`, `measured`, and `master_verified`.
- Empty values are rejected unless the submission is explicitly a "cannot provide" response stored in payload.

Persistence:

Insert one `collab_submissions` row:

- `magic_link_id`: matching `magic_links.id`
- `submitter_role`: `magic_links.recipient_role`
- `intent`: `data_gap_fill`
- `target_kind`: `document_missing_items`
- `target_ref`: comma-separated gap ids or a stable batch uid
- `payload`: raw submitted items
- `field_diffs`: normalized proposed changes
- `attachments`: evidence URLs
- `status`: `submitted`

`submitted` is required because the current DB check constraint does not allow `pending`.

Response:

```json
{
  "ok": true,
  "submission_id": 789,
  "status": "submitted"
}
```

### POST `/api/collab/data-gaps/apply`

Purpose: internal human-reviewed application.

Auth: internal admin/staff role only; no magic link access.

Request:

```json
{
  "submission_id": 789,
  "reviewed_by": "damon-or-staff-id"
}
```

Apply rules:

- Re-read submission under transaction and lock it.
- Only `status in ('submitted','under_review')` can be applied.
- Re-read every gap and target row.
- Fill empty fields only; never overwrite existing non-empty master data.
- Write the matching source marker where the table has a source column or raw JSON source slot.
- Mark gap `status='resolved'`, `resolved_by`, `resolved_at`, `resolve_note`.
- Mark `collab_submissions.status='applied'`, `applied_to`, `reviewed_by`, `reviewed_at`, `applied_at`.

Reject rules:

- If target value is already non-empty and differs, do not overwrite; leave gap open or mark rejected with reason.
- If evidence is missing for required sources, reject.
- If target row no longer exists, reject.

## Fail-Closed Gate

Document generation, customs, invoice, and packing-list flows should check required truth fields before rendering externally visible documents.

Expected error shape:

```json
{
  "ok": false,
  "error": "TRUTH_MISSING",
  "field": "products.factory_price",
  "gap_id": 456,
  "required_source": "contract"
}
```

No fallback value should be inserted into PDFs, customs forms, invoices, PL, or order progression state when a required `contract` or `measured` field is unresolved.

## Handoff Notes

- Collaboration frontend can consume only the GET/POST submit endpoints; it does not need schema ownership.
- `collab_urges` can point at `document_missing_items.id` with `sheet_table='document_missing_items'`.
- External submits land in `collab_submissions.status='submitted'`, not `pending`.
- The apply endpoint is intentionally internal and review-gated.
