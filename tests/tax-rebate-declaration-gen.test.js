import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPairs, buildValidation, loadRows } from "../api/db/tax-rebate-declaration-gen.js";
import { renderExportXls, renderPurchaseXls } from "../api/db/tax-rebate-declaration-xls-template.js";

const info = { period: "202607" };

test("buildPairs splits export qty and FOB for one customs item linked to multiple invoices", () => {
  const rows = [
    {
      declaration_no: "370120260000000001",
      declared_at: "2026-07-05",
      item_id: 101,
      sort_order: 1,
      hs_code: "2309109000",
      declaration_name_cn: "宠物食品",
      unit: "千克",
      qty: 100,
      declaration_amount: 1000,
      fob_usd: 1000,
      fob_usd_source: "pdf_anchor_manual",
      link_id: 201,
      invoice_no: "INV-A",
      allocated_amount: 60,
      tax_rate: 0.13,
      hs_rebate_rate: 0.13,
    },
    {
      declaration_no: "370120260000000001",
      declared_at: "2026-07-05",
      item_id: 101,
      sort_order: 1,
      hs_code: "2309109000",
      declaration_name_cn: "宠物食品",
      unit: "千克",
      qty: 100,
      declaration_amount: 1000,
      fob_usd: 1000,
      fob_usd_source: "pdf_anchor_manual",
      link_id: 202,
      invoice_no: "INV-B",
      allocated_amount: 40,
      tax_rate: 0.13,
      hs_rebate_rate: 0.13,
    },
  ];

  const data = buildPairs(rows, info, "001");

  assert.equal(data.exportRows.length, 2);
  assert.deepEqual(data.exportRows.map((r) => r.link_no), ["20260700100000001", "20260700100000002"]);
  assert.equal(data.exportRows.reduce((sum, r) => sum + r.qty, 0), 100);
  assert.equal(data.exportRows.reduce((sum, r) => sum + r.fob_usd, 0), 1000);
  assert.deepEqual(data.exportRows.map((r) => r.qty), [60, 40]);
  assert.deepEqual(data.exportRows.map((r) => r.fob_usd), [600, 400]);
});

test("buildValidation does not trust finance_export_rebates rebate rate fallback", () => {
  const validations = buildValidation([
    {
      declaration_no: "370120260000000002",
      item_id: 102,
      fob_usd: 10,
      fob_usd_source: "pdf_anchor_manual",
      invoice_no: "INV-C",
      tax_rate: 0.13,
      fer_rebate_rate: 0.13,
    },
  ]);

  assert.equal(validations.some((v) => v.type === "missing_rebate_rate"), true);
});

test("buildValidation flags missing purchase invoice tax rate", () => {
  const validations = buildValidation([
    {
      declaration_no: "370120260000000003",
      item_id: 103,
      fob_usd: 10,
      fob_usd_source: "pdf_anchor_manual",
      invoice_no: "INV-D",
      hs_rebate_rate: 0.13,
      tax_rate: null,
    },
  ]);

  assert.equal(validations.some((v) => v.type === "missing_tax_rate"), true);
});

test("renderers accept buildDeclarationPackage-shaped exportRows and purchaseRows", async () => {
  const pkg = {
    period: "202607",
    batch: "001",
    totalRebate: 13,
    exportRows: [
      {
        link_no: "20260700100000001",
        declaration_no: "370120260000000004",
        sort_order: 1,
        export_date: "2026-04-01",
        hs_code: "2309109000",
        goods_name: "宠物食品",
        unit: "千克",
        qty: 100,
        fob_usd: 1000,
        note: "",
      },
    ],
    purchaseRows: [
      {
        link_no: "20260700100000001",
        invoice_no: "INV-E",
        seller_tax_id: "91370000000000000X",
        issue_date: "2026-07-01",
        hs_code: "2309109000",
        goods_name: "宠物食品",
        unit: "千克",
        qty: 100,
        taxable_amount: 100,
        tax_rate: 0.13,
        rebate_rate: 0.13,
        rebate_amount: 13,
        note: "",
      },
    ],
  };

  const exportXls = await renderExportXls(pkg);
  const purchaseXls = await renderPurchaseXls(pkg);

  assert.ok(Buffer.from(exportXls).byteLength > 0);
  assert.ok(Buffer.from(purchaseXls).byteLength > 0);
});

test("loadRows only queries declarations assigned to the requested rebate batch", async () => {
  const assignedRow = {
    declaration_no: "370120260000000005",
    item_id: 105,
    hs_code: "2309109000",
    fob_usd: 10,
    fob_usd_source: "pdf_anchor_manual",
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("FROM customs_declarations d")) {
        assert.match(sql, /d\.rebate_period = \$1/);
        assert.match(sql, /d\.rebate_batch = \$2/);
        assert.doesNotMatch(sql, /fer\.export_date\s*>=/);
        assert.deepEqual(params, ["202607", "001"]);
        return { rows: [assignedRow] };
      }
      if (sql.includes("to_regclass('public.hs_rebate_rates')")) return { rows: [{ t: null }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const rows = await loadRows(pool, info, "001");

  assert.deepEqual(rows, [assignedRow]);
});
