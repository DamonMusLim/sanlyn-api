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
      if (sql.includes("gdc_result=$2")) {
        state.picks.filter((x) => x.order_no === params[0]).forEach((x) => {
          x.gdc_result = params[1];
          if (sql.includes("COALESCE(gdc_synced_at,now())")) x.gdc_synced_at = "now";
        });
        return { rows: [] };
      }
      if (sql.includes("UPDATE petstore_takeout_picks")) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function makeGdc({ status = 20, failPicked = false } = {}) {
  return {
    pickedCalls: [],
    async unpicked() { return 2; },
    async list() { return { list: [{ order_no: "O1", day_seq: "18", channel_code: 10, order_status: 20, quantity: 4, recipient_phone: "155****8888" }] }; },
    async detail() { return { plat: "MEI_TUAN", order_status: status, goods: [
      { product_name: "猫砂", upc_code: "1111", product_code: "P1", sku_spec: "5L", quantity: 1, actual_price: 9.9, product_price: 10.5, food_property: "" },
      { product_name: "罐头", upc_code: "2222", product_code: "P2", sku_spec: "80g", quantity: 2, actual_price: 6.8, product_price: 7, food_property: "常温" },
      { product_name: "赠品券", upc_code: "", product_code: null, sku_spec: "", quantity: 1, picked_quantity: 1, actual_price: 0.01, product_price: 0.01, food_property: "" },
    ] }; },
    async picked(body) {
      this.pickedCalls.push(body);
      if (failPicked) throw new Error("接口超时");
      return "ok";
    },
  };
}
const staff = { empId: 7, me: { id: 7, name: "汪卫云", role: "staff", company_code: "JINFANG", employment_status: "active" } };
function handler(p, gdc = makeGdc()) { return makeHandler({ poolFactory: () => p, setCorsFn: () => {}, verifyStaff: async () => staff, gdcClient: gdc }); }
async function call(h, body, method = "POST") { const out = res(); await h({ method, body, query: body }, out); return out; }
async function completeReady(h) {
  await call(h, { action: "scan", order_no: "O1", barcode: "1111" });
  await call(h, { action: "manual_plus", order_no: "O1", product_code: "P2" });
  await call(h, { action: "manual_plus", order_no: "O1", product_code: "P2" });
}
async function withPickedEnv(v, fn) {
  const old = process.env.GDC_WRITE_PICKED;
  if (v == null) delete process.env.GDC_WRITE_PICKED; else process.env.GDC_WRITE_PICKED = v;
  try { await fn(); } finally { if (old == null) delete process.env.GDC_WRITE_PICKED; else process.env.GDC_WRITE_PICKED = old; }
}

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
  await withPickedEnv(null, async () => {
    const p = pool(), g = makeGdc(), h = handler(p, g);
    await completeReady(h);
    const r = await call(h, { action: "complete", order_no: "O1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.gdc, "disabled");
    assert.equal(g.pickedCalls.length, 0);
  });
}

{
  await withPickedEnv("1", async () => {
    const p = pool(), g = makeGdc(), h = handler(p, g);
    await completeReady(h);
    const r = await call(h, { action: "complete", order_no: "O1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.gdc, "synced");
    assert.equal(g.pickedCalls.length, 1);
    assert.deepEqual(g.pickedCalls[0], {
      order_no: "O1",
      store_code: "63350001",
      is_check_pick_status: true,
      operator: "汪卫云",
      goods: [
        { product_code: "P1", picked_quantity: 1, product_price: 10.5, product_name: "猫砂", food_property: "" },
        { product_code: "P2", picked_quantity: 2, product_price: 7, product_name: "罐头", food_property: "常温" },
        { product_code: null, picked_quantity: 1, product_price: 0.01, product_name: "赠品券", food_property: "" },
      ],
    });
  });
}

{
  await withPickedEnv("1", async () => {
    const p = pool(), g = makeGdc({ status: 60 }), h = handler(p, g);
    await completeReady(h);
    const r = await call(h, { action: "complete", order_no: "O1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.gdc, "skipped");
    assert.equal(r.body.reason, "果冻橙已是已完成");
    assert.equal(g.pickedCalls.length, 0);
  });
}

{
  await withPickedEnv("1", async () => {
    const p = pool(), g = makeGdc({ failPicked: true }), h = handler(p, g);
    await completeReady(h);
    const r = await call(h, { action: "complete", order_no: "O1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.gdc, "failed");
    assert.match(r.body.gdc_error, /接口超时/);
    assert.equal(g.pickedCalls.length, 1);
  });
}

{
  await withPickedEnv("1", async () => {
    const p = pool(), g = makeGdc(), h = handler(p, g);
    await completeReady(h);
    await call(h, { action: "complete", order_no: "O1" });
    const r = await call(h, { action: "complete", order_no: "O1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.gdc, "synced");
    assert.equal(g.pickedCalls.length, 1);
  });
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
