#!/usr/bin/env node
import assert from "node:assert/strict";
import { makeHandler } from "./petstore-reception.mjs";

function res() {
  return {
    statusCode: 0, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

function pool(seed = {}) {
  const state = {
    appointments: seed.appointments ? seed.appointments.slice() : [],
    pets: seed.pets ? seed.pets.slice() : [],
    vacc: seed.vacc ? seed.vacc.slice() : [],
    cards: seed.cards || 0,
    agenda: [], notes: [], reports: [],
  };
  return {
    state,
    async query(sql, params) {
      if (sql.includes("SELECT id, COALESCE(reception_status, status)")) {
        return { rows: state.appointments.filter((x) => x.id === params[0] && x.store_code === params[1]) };
      }
      if (sql.includes("UPDATE appointments") && sql.includes("reception_status=$3")) {
        const row = state.appointments.find((x) => x.id === params[0]);
        Object.assign(row, { reception_status: params[2], status: params[3], reception_operator_id: params[4] });
        return { rows: [{ id: row.id, status: row.status, reception_status: row.reception_status }] };
      }
      if (sql.includes("FROM appointments a") && sql.includes("LEFT JOIN pet_profiles") && sql.includes("a.id=$1")) {
        const a = state.appointments.find((x) => x.id === params[0] && x.store_code === params[1]);
        const p = state.pets.find((x) => x.id === a?.pet_id) || {};
        return { rows: a ? [{ id: a.id, pet_id: a.pet_id, pet_name: p.name }] : [] };
      }
      if (sql.includes("INSERT INTO grooming_reports")) {
        const row = { id: state.reports.length + 1, appointment_id: params[1], share_text: params[8] };
        state.reports.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SELECT id FROM hr_day_agenda")) {
        const exists = state.agenda.find((x) => x.company_code === params[0] && x.work_date === params[1] && x.title === params[2]);
        return { rows: exists ? [{ id: 1 }] : [] };
      }
      if (sql.includes("INSERT INTO hr_day_agenda")) {
        state.agenda.push({ company_code: params[0], work_date: params[1], title: params[2], note: params[3] });
        return { rows: [{ id: state.agenda.length }] };
      }
      if (sql.includes("INSERT INTO petstore_pet_notes")) {
        state.notes.push({ title: params[2], body: params[3], source_ref: params[4] });
        return { rows: [] };
      }
      if (sql.includes("FROM pet_profiles") && sql.includes("(($2::int>0")) {
        return { rows: state.pets.filter((x) => x.store_code === params[0] && ((params[1] > 0 && x.id === params[1]) || (params[2] && x.owner_phone === params[2]))) };
      }
      if (sql.includes("FROM pet_vaccinations")) return { rows: state.vacc };
      if (sql.includes("FROM member_cards")) return { rows: [{ remaining: state.cards }] };
      if (sql.includes("FROM grooming_reports g JOIN appointments")) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const staff = { empId: 7, me: { id: 7, name: "阿云", role: "staff", company_code: "JINFANG", employment_status: "active" } };
const off = { empId: 9, me: { id: 9, name: "泉州", role: "staff", company_code: "QUANZHOU", employment_status: "active" } };
const noCors = () => {};
const now = () => Date.parse("2026-09-27T12:00:00.000Z");
const photoSaver = () => "https://ai.sanlyn.cn/uploads/staff-reception/a.jpg";

async function call(h, body) {
  const out = res();
  await h({ method: "POST", body, query: {} }, out);
  return out;
}

{
  const p = pool({ appointments: [{ id: 1, store_code: "63350001", status: "booked", reception_status: "booked" }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "finish", id: 1 });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "bad_transition");
}

{
  const p = pool({ appointments: [{ id: 1, store_code: "63350001", pet_id: 2, status: "doing", reception_status: "doing" }], pets: [{ id: 2, name: "豆豆" }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "groom_report", appointment_id: 1, before_photos: [], after_photos: [{ mime: "image/jpeg", base64: "x" }] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "photo_required");
}

{
  const p = pool({ appointments: [{ id: 1, store_code: "63350001", pet_id: 2, status: "doing", reception_status: "doing" }], pets: [{ id: 2, name: "豆豆" }] });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const body = { action: "groom_report", appointment_id: 1, before_photos: [{ mime: "image/jpeg", base64: "x" }], after_photos: [{ mime: "image/jpeg", base64: "y" }], skin_normal: false };
  const r1 = await call(h, body);
  const r2 = await call(h, body);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.todo_created, true);
  assert.equal(r2.body.todo_created, false);
  assert.equal(p.state.agenda.length, 1);
  assert.equal(p.state.notes.length, 2);
}

{
  const p = pool({
    pets: [{ id: 2, store_code: "63350001", name: "豆豆", owner_name: "王姐", owner_phone: "13812345678" }],
    vacc: [
      { pet_id: 2, kind: "疫苗", executed_at: "2025-09-20", next_due_at: "2026-09-20", frequency_days: 365 },
      { pet_id: 2, kind: "体外驱虫", executed_at: "2026-09-25", next_due_at: "2026-10-02", frequency_days: 30 },
    ],
    cards: 3,
  });
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => staff, now, photoSaver });
  const r = await call(h, { action: "pet", pet_id: 2 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.customer.phone_tail, "****5678");
  assert.equal(r.body.card_remaining, 3);
  assert.equal(r.body.pets[0].lines.vaccine.state, "overdue");
  assert.equal(r.body.pets[0].lines.deworm_external.state, "soon");
}

{
  const p = pool();
  const h = makeHandler({ poolFactory: () => p, setCorsFn: noCors, verifyStaff: async () => ({ ...off, error: "feature_off" }), now, photoSaver });
  const r = await call(h, { action: "today" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "feature_off");
}

console.log("petstore-reception tests passed");
