#!/usr/bin/env node
import assert from "node:assert/strict";
import { makeSign } from "../lib/gdc-cashier.mjs";
import { makeHandler } from "./petstore-takeout.mjs";

function res() {
  return { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() {} };
}

function pool() {
  const state = { picks: [], lastSql: "" };
  return {
    state,
    async query(sql, params) {
      state.lastSql = sql;
      if (sql.includes("FROM petstore_takeout_picks")) {
        return { rows: state.picks.filter((x) => x.order_no === params[0]) };
      }
      if (sql.includes("FROM public.petstore_skus")) {
        return { rows: [
          { product_code: "P1", product_name: "猫砂", stock_num: 6, shelf_location: "[\"A-3\"]", barcodes: ["1111", "ALT1"] },
          { product_code: "P2", product_name: "罐头", stock_num: 1, shelf_location: "B-1", barcodes: ["2222"] },
        ].filter((x) => params[0].includes(x.product_code)) };
      }
      if (sql.includes("FROM public.petstore_product_barcodes")) {
        return { rows: params[0] === "ALT1" ? [{ product_code: "P1", barcode: "ALT1" }] : [] };
      }
      if (sql.includes("INSERT INTO petstore_takeout_picks")) {
        let row = state.picks.find((x) => x.order_no === params[0] && x.product_code === params[1]);
        if (!row) {
          row = { order_no: params[0], product_code: params[1], barcode: params[2], quantity: params[3], picked: 0, manual_count: 0 };
          state.picks.push(row);
        }
        row.picked = Math.min(Number(row.quantity), Number(row.picked) + 1);
        row.manual_count += Number(params[4] || 0);
        return { rows: [{ product_code: row.product_code, quantity: row.quantity, picked: row.picked, manual_count: row.manual_count }] };
      }
      if (sql.includes("UPDATE petstore_takeout_picks")) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const gdc = {
  async unpicked() { return 2; },
  async list() { return { list: [{ order_no: "O1", day_seq: "18", channel_code: 10, order_status: "WAIT_PICK", quantity: 3, recipient_phone: "155****8888" }] }; },
  async detail() { return { plat: "MEI_TUAN", goods: [
    { product_name: "猫砂", upc_code: "1111", product_code: "P1", sku_spec: "5L", quantity: 1, actual_price: 9.9 },
    { product_name: "罐头", upc_code: "2222", product_code: "P2", sku_spec: "80g", quantity: 2, actual_price: 6.8 },
  ] }; },
};
const staff = { empId: 7, me: { id: 7, name: "汪卫云", role: "staff", company_code: "JINFANG", employment_status: "active" } };
function handler(p) { return makeHandler({ poolFactory: () => p, setCorsFn: () => {}, verifyStaff: async () => staff, gdcClient: gdc }); }
async function call(h, body, method = "POST") { const out = res(); await h({ method, body, query: body }, out); return out; }

assert.equal(makeSign({ body: "{\"a\":1}", app_id: "app1", timestamp: "1000" }, "sec"), "516908b6f77e2de4ca50fec8fbf21586");

{
  const p = pool(), h = handler(p);
  const r = await call(h, { action: "scan", order_no: "O1", barcode: "ALT1" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.result, "ok");
  assert.equal(r.body.line.product_code, "P1");
}

{
  const p = pool(), h = handler(p);
  const r = await call(h, { action: "scan", order_no: "O1", barcode: "NOPE" });
  assert.equal(r.body.result, "not_in_order");
}

{
  const p = pool(), h = handler(p);
  await call(h, { action: "scan", order_no: "O1", barcode: "1111" });
  const r = await call(h, { action: "scan", order_no: "O1", barcode: "1111" });
  assert.equal(r.body.result, "over");
}

{
  const p = pool(), h = handler(p);
  const r = await call(h, { action: "complete", order_no: "O1" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "not_enough");
  assert.equal(r.body.missing.length, 2);
}

{
  const p = pool(), h = handler(p);
  await call(h, { action: "scan", order_no: "O1", barcode: "1111" });
  await call(h, { action: "manual_plus", order_no: "O1", product_code: "P2" });
  await call(h, { action: "manual_plus", order_no: "O1", product_code: "P2" });
  const r = await call(h, { action: "complete", order_no: "O1" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.message, "已记录，请去果冻橙点拣货完成");
}

{
  const p = pool(), h = handler(p);
  const r = await call(h, { action: "detail", order_no: "O1" });
  assert.equal(r.statusCode, 200);
  assert.equal(Object.hasOwn(r.body.goods[0], "actual_price"), false);
  assert.equal(JSON.stringify(r.body).includes("sec"), false);
  assert.equal(r.body.goods[0].location, "A-3");
}

console.log("petstore-takeout tests passed");
