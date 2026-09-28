#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTitle, buildNote, makeHandler, savePhoto, readPhoto } from "./hr-photo-todo.mjs";

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

const CATALOG = [
  { product_code: "6335102720", barcode: "6949047599624", product_name: "皇家 I27 室内成猫粮", spec_text: "2kg", shelf_code: "3-105", stock_num: "9" },
  { product_code: "6335105234", barcode: "9551016102079", product_name: "SNIFFLY 金枪鱼猫罐头", spec_text: "80g", shelf_code: "7-219", stock_num: "2" },
  { product_code: "6335105235", barcode: "9551016102017", product_name: "SNIFFLY 金枪鱼猫罐头", spec_text: "80g 虾", shelf_code: "7-220", stock_num: "11" },
];

function pool() {
  const inserted = [];
  return {
    inserted,
    async query(sql, params) {
      if (sql.includes("FROM hr_employees")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM public.petstore_ops_row")) {
        const hit = sql.includes("ILIKE")
          ? CATALOG.filter((x) => x.product_name.includes(params[0]))
          : CATALOG.filter((x) => x.product_code === params[0] || x.barcode === params[0]);
        return { rows: hit.slice(0, 2) };
      }
      if (sql.includes("SELECT id FROM hr_day_agenda")) {
        const row = inserted.find((x) =>
          x.company_code === params[0] && x.work_date === params[1] && x.created_by === params[2]);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (sql.includes("INSERT INTO hr_day_agenda")) {
        const row = { id: inserted.length + 100, company_code: params[0], work_date: params[1],
          title: params[2], note: params[3], created_by: params[4] };
        inserted.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (sql.includes("FROM hr_day_agenda a")) {
        return { rows: [{ id: 100, title: "客户要实拍：x", status: "done", photos: [{ photo_id: 7 }] }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const noCors = () => {};
const env = { SHIP_TODO_TOKEN: "tok" };
const now = () => new Date("2026-09-28T02:00:00Z");

async function call(p, { method = "POST", body, query, token = "tok" } = {}) {
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, env, now });
  const r = res();
  await h({ method, body, query, headers: { "x-service-token": token } }, r);
  return r;
}

const base = { source_channel: "meituan", source_conversation_id: "conv-1", request_text: "能拍张实物看看吗" };

// 1. 条码唯一命中 → 标题带商品名规格,备注带货位和库存
{
  const p = pool();
  const r = await call(p, { body: { ...base, barcode: "6949047599624" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.matched, true);
  assert.equal(p.inserted[0].title, "客户要实拍：皇家 I27 室内成猫粮 2kg");
  assert.match(p.inserted[0].note, /货位：3-105（系统库存 9）/);
  assert.match(p.inserted[0].note, /客户说：能拍张实物看看吗/);
  assert.match(p.inserted[0].note, /来源：美团/);
  assert.equal(p.inserted[0].work_date, "2026-09-28");
  // 同会话同商品再来一次 → 去重,不重复派活
  const r2 = await call(p, { body: { ...base, barcode: "6949047599624" } });
  assert.equal(r2.body.deduped, true);
  assert.equal(p.inserted.length, 1);
}

// 2. 关键词命中两个 → 不瞎认,标题提示按描述找,不写货位
{
  const p = pool();
  const r = await call(p, { body: { ...base, keyword: "SNIFFLY" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.matched, false);
  assert.match(p.inserted[0].title, /「SNIFFLY」\(商品没认出来,按描述找\)/);
  assert.doesNotMatch(p.inserted[0].note, /货位/);
}

// 3. 关键词唯一命中也认
{
  const p = pool();
  const r = await call(p, { body: { ...base, keyword: "皇家" } });
  assert.equal(r.body.matched, true);
}

// 4. 闸:令牌错 401;缺会话/缺商品/渠道不对 400
{
  assert.equal((await call(pool(), { body: { ...base, barcode: "x" }, token: "bad" })).statusCode, 401);
  assert.equal((await call(pool(), { body: { source_channel: "meituan", barcode: "x" } })).statusCode, 400);
  assert.equal((await call(pool(), { body: { source_channel: "meituan", source_conversation_id: "c" } })).statusCode, 400);
  assert.equal((await call(pool(), { body: { ...base, source_channel: "sms", barcode: "x" } })).statusCode, 400);
}

// 5. GET 按会话取照片;缺参数 400
{
  const r = await call(pool(), { method: "GET", query: { source_channel: "meituan", source_conversation_id: "conv-1" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.items[0].photos.length, 1);
  assert.equal((await call(pool(), { method: "GET", query: {} })).statusCode, 400);
}

// 6. 纯函数:标题不超过80字
{
  const long = { product_name: "长".repeat(100), spec_text: "", shelf_code: null, stock_num: null };
  assert.ok(Array.from(buildTitle(long, {})).length <= 80);
  assert.match(buildNote(long, { sourceChannel: "wechat", customerName: "顾客" }), /没登记货位（系统库存 未知）/);
}

// 7. 照片落盘→按 id 读回;非图片/空图拒收;库里被塞 ../ 读不到别的文件
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "photo-"));
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const rel = savePhoto("image/png", png1x1, () => 1, root);
  assert.match(rel, /^staff-photo-request\/1-[0-9a-f]{8}\/photo\.png$/);
  const fakePool = (p) => ({ async query() { return { rows: [{ photo_path: p }] }; } });
  const got = await readPhoto(fakePool(rel), 1, root);
  assert.equal(got.mime, "image/png");
  assert.ok(got.buf.length > 0);
  assert.equal(await readPhoto(fakePool("../../etc/passwd"), 1, root), null);
  assert.equal(await readPhoto(fakePool("staff-photo-request/../x"), 1, root), null);
  assert.throws(() => savePhoto("text/plain", png1x1, () => 1, root), /照片必须是图片/);
  assert.throws(() => savePhoto("image/png", "", () => 1, root), /照片是空的/);
  fs.rmSync(root, { recursive: true, force: true });
}

// 8. GET ?photo_id= 走令牌,返回图片字节;没有返回 404
{
  const p = { async query(sql) { if (sql.includes("FROM hr_agenda_photos WHERE id")) return { rows: [] }; throw new Error(sql); } };
  const r = await call(p, { method: "GET", query: { photo_id: "9" } });
  assert.equal(r.statusCode, 404);
  assert.equal((await call(p, { method: "GET", query: { photo_id: "9" }, token: "bad" })).statusCode, 401);
}

console.log("hr-photo-todo: all tests passed");
