#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildTitle, makeHandler } from "./hr-ship-todo.mjs";

function res() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

function pool() {
  const inserted = [];
  return {
    inserted,
    async query(sql, params) {
      if (sql.includes("FROM hr_employees")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("SELECT id FROM hr_day_agenda")) {
        const row = inserted.find((x) =>
          x.company_code === params[0] && x.work_date === params[1]
          && x.created_by === params[2] && x.title === params[3]);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (sql.includes("INSERT INTO hr_day_agenda")) {
        const row = {
          id: inserted.length + 100,
          company_code: params[0],
          work_date: params[1],
          title: params[2],
          note: params[3],
          created_by: params[4],
        };
        inserted.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const noCors = () => {};

function baseBody(extra = {}) {
  return {
    customer_name: "王女士",
    items: [{ name: "猫粮", qty: 2 }],
    address: "中山路1号",
    phone: "13800000000",
    note: "放门口",
    source_channel: "wechat",
    source_conversation_id: "chatwoot:123",
    work_date: "2026-09-27",
    ...extra,
  };
}

async function call(handler, body, token = "secret") {
  const out = res();
  await handler({ method: "POST", headers: { "x-service-token": token }, body }, out);
  return out;
}

const fixedNow = () => new Date("2026-09-27T01:00:00Z");

{
  const h = makeHandler({ poolFactory: pool, setCorsFn: noCors, env: { SHIP_TODO_TOKEN: "secret" }, now: fixedNow });
  const r = await call(h, baseBody(), "");
  assert.equal(r.statusCode, 401);
}

{
  const h = makeHandler({ poolFactory: pool, setCorsFn: noCors, env: {}, now: fixedNow });
  const r = await call(h, baseBody());
  assert.equal(r.statusCode, 503);
}

{
  const h = makeHandler({ poolFactory: pool, setCorsFn: noCors, env: { SHIP_TODO_TOKEN: "secret" }, now: fixedNow });
  const r = await call(h, baseBody({ items: [] }));
  assert.equal(r.statusCode, 400);
}

{
  const h = makeHandler({ poolFactory: pool, setCorsFn: noCors, env: { SHIP_TODO_TOKEN: "secret" }, now: fixedNow });
  const r = await call(h, baseBody({ items: [{ name: "猫粮", qty: 0 }] }));
  assert.equal(r.statusCode, 400);
}

{
  const p = pool();
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, env: { SHIP_TODO_TOKEN: "secret" }, now: fixedNow });
  const r = await call(h, baseBody());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { success: true, id: 100, deduped: false });
  assert.equal(p.inserted[0].created_by, "ship:wechat:chatwoot:123");
  assert.match(p.inserted[0].note, /地址：中山路1号/);
}

{
  const p = pool();
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, env: { SHIP_TODO_TOKEN: "secret" }, now: fixedNow });
  await call(h, baseBody({ items: [{ name: "猫砂", qty: 1 }, { name: "猫粮", qty: 2 }] }));
  const r = await call(h, baseBody({ items: [{ name: "猫粮", qty: 2 }, { name: "猫砂", qty: 1 }] }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { success: true, id: 100, deduped: true });
}

{
  const items = Array.from({ length: 20 }, (_, i) => ({ name: `超长品名${i}号测试测试测试`, qty: i + 1 }));
  const title = buildTitle("一位名字不短的客户", items);
  assert.ok(Array.from(title).length <= 80);
  assert.match(title, /等\d+样/);
}

console.log("hr-ship-todo tests passed");
