#!/usr/bin/env node
import assert from "node:assert/strict";
import { makeHandler } from "./petstore-stock-report.mjs";

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

function pool(seed = {}) {
  const state = {
    reports: seed.reports ? seed.reports.slice() : [],
    agenda: [],
    count30: seed.count30 || 0,
    lookup: seed.lookup || [],
    lastSql: "",
  };
  return {
    state,
    async query(sql, params) {
      state.lastSql = sql;
      if (sql.includes("FROM petstore_stock_reports") && sql.includes("COUNT(*)::int AS n")) {
        return { rows: [{ n: state.count30 }] };
      }
      if (sql.includes("INSERT INTO petstore_stock_reports")) {
        const row = {
          id: state.reports.length + 1,
          company_code: params[0],
          product_code: params[1],
          barcode: params[2],
          product_name: params[3],
          bound_location: params[4],
          system_qty: params[5],
          actual_qty: params[6],
          reason: params[7],
          photos: JSON.parse(params[8]),
          status: params[9],
          is_frequent_lost: params[10],
          reported_by_employee_id: params[11],
          reported_by_name: params[12],
          shift_note: params[13],
          created_at: "2026-09-27T00:00:00.000Z",
        };
        state.reports.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SELECT id FROM hr_day_agenda")) return { rows: state.agenda.length ? [{ id: 1 }] : [] };
      if (sql.includes("INSERT INTO hr_day_agenda")) {
        state.agenda.push({ company_code: params[0], work_date: params[1], title: params[2], note: params[3] });
        return { rows: [{ id: state.agenda.length }] };
      }
      if (sql.includes("WHERE id=$1 AND company_code=$2 AND status='searching'")) {
        return { rows: state.reports.filter((x) => x.id === params[0] && x.company_code === params[1] && x.status === "searching") };
      }
      if (sql.includes("SET status='found'")) {
        const row = state.reports.find((x) => x.id === params[0] && x.company_code === params[1]);
        Object.assign(row, { status: "found", found_location: params[2], found_action: params[3], found_photos: JSON.parse(params[4]) });
        return { rows: [row] };
      }
      if (sql.includes("SELECT * FROM petstore_stock_reports WHERE id=$1")) {
        return { rows: state.reports.filter((x) => x.id === params[0] && x.company_code === params[1]) };
      }
      if (sql.includes("SET status='confirmed_lost'")) {
        const row = state.reports.find((x) => x.id === params[0] && x.company_code === params[1]);
        Object.assign(row, { status: "confirmed_lost", confirmed_by: params[2], confirmed_loss_qty: params[3] });
        return { rows: [row] };
      }
      if (sql.includes("FROM public.petstore_skus")) return { rows: state.lookup };
      if (sql.includes("ORDER BY created_at DESC LIMIT 200")) {
        return { rows: state.reports.map((x) => ({ ...x, overdue: x.status === "searching" && new Date(x.created_at).getTime() < Date.parse("2026-09-26T12:00:00.000Z") })) };
      }
      if (sql.includes("GROUP BY product_code HAVING COUNT")) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const staff = { empId: 7, me: { id: 7, name: "汪卫云", role: "staff", company_code: "JINFANG", employment_status: "active" } };
const mgr = { empId: 8, me: { id: 8, name: "店长", role: "store_manager", company_code: "JINFANG", employment_status: "active" } };
const noCors = () => {};
const now = () => Date.parse("2026-09-27T12:00:00.000Z");
const photoSaver = () => "https://ai.sanlyn.cn/uploads/staff-stock-report/test.jpg";

async function call(h, body) {
  const out = res();
  await h({ method: "POST", body, query: {} }, out);
  return out;
}

{
  const p = pool();
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "create", product_code: "P1", reason: "missing", photos: [] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "photo_required");
}

{
  const p = pool({ reports: [{ id: 1, company_code: "JINFANG", product_code: "P1", status: "searching", created_at: "2026-09-27T01:00:00.000Z", system_qty: 2, actual_qty: 1 }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => mgr, now, photoSaver });
  const r = await call(h, { action: "confirm_loss", id: 1 });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "too_early");
}

{
  const p = pool({ reports: [{ id: 1, company_code: "JINFANG", product_code: "P1", status: "searching", bound_location: "B-1", created_at: "2026-09-27T00:00:00.000Z" }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "found", id: 1, found_location: "C-4" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "found_action_required");
}

{
  const p = pool({ reports: [{ id: 1, company_code: "JINFANG", product_code: "P1", status: "searching", bound_location: "B-1", created_at: "2026-09-27T00:00:00.000Z" }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "found", id: 1, found_location: "C-4", found_action: "return_bound" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "return_photo_required");
}

{
  const reports = [
    { id: 1, company_code: "JINFANG", product_code: "P1", product_name: "猫砂", status: "searching", bound_location: "B-1", created_at: "2026-09-27T00:00:00.000Z" },
    { id: 2, company_code: "JINFANG", product_code: "P1", product_name: "猫砂", status: "searching", bound_location: "B-1", created_at: "2026-09-27T00:00:00.000Z" },
  ];
  const p = pool({ reports });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r1 = await call(h, { action: "found", id: 1, found_location: "C-4", found_action: "rebind_new" });
  const r2 = await call(h, { action: "found", id: 2, found_location: "C-4", found_action: "rebind_new" });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r1.body.rebind_todo_created, true);
  assert.equal(r2.body.rebind_todo_created, false);
  assert.equal(p.state.agenda.length, 1);
  assert.match(p.state.agenda[0].title, /改绑货位:猫砂 B-1→C-4/);
}

{
  const p = pool({ count30: 1 });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "create", product_code: "P1", product_name: "猫砂", reason: "missing", photos: [{ mime: "image/jpeg", base64: "xx" }] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.frequent_lost, true);
  assert.equal(r.body.todo_created, true);
  assert.match(p.state.agenda[0].title, /重新定位\+贴货位标签:猫砂/);
}

{
  const p = pool({ reports: [{ id: 1, company_code: "JINFANG", product_code: "P1", status: "pending_confirm", created_at: "2026-09-26T00:00:00.000Z", system_qty: 3, actual_qty: 1 }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "confirm_loss", id: 1 });
  assert.equal(r.statusCode, 403);
}

{
  const p = pool({ lookup: [{ product_code: "P1", barcode: "BC2", product_name: "猫砂", spec: "5L", out_price: 19.9, stock_num: 2, shelf_location: "B-1", recent_expiry: "2027-01-01", cost_price: 9.9 }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "product_lookup", q: "BC2" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 1);
  assert.doesNotMatch(p.state.lastSql, /s\.barcode/);
  assert.match(p.state.lastSql, /LATERAL/);
  assert.equal(r.body.rows[0].product_name, "猫砂");
  assert.equal(r.body.rows[0].barcode, "BC2");
  assert.equal(Object.hasOwn(r.body.rows[0], "cost_price"), false);
}

{
  const p = pool({ reports: [
    { id: 1, company_code: "JINFANG", product_code: "P1", status: "searching", created_at: "2026-09-26T11:59:59.000Z" },
    { id: 2, company_code: "JINFANG", product_code: "P2", status: "searching", created_at: "2026-09-26T12:00:01.000Z" },
  ] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => mgr, now, photoSaver });
  const r = await call(h, { action: "list" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows[0].overdue, true);
  assert.equal(r.body.rows[1].overdue, false);
}

console.log("petstore-stock-report tests passed");
