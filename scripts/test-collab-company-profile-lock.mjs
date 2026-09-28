import assert from "node:assert/strict";
import fs from "node:fs";
import { handleCompanyProfile } from "../api/db/lib/collab-company-profile.js";

process.env.JWT_SECRET ||= "test-secret";
const { handleCompaniesRequest } = await import("../api/db/companies.js");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    },
  };
}

function collabPool(rowsForName) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/ALTER TABLE companies/.test(sql)) return { rows: [] };
      if (/FROM magic_links/.test(sql)) {
        return { rows: [{ recipient_role: "supplier_portal", meta: { shipment_id: 1, company_label: "Acme" } }] };
      }
      if (/FROM companies/.test(sql) && /ANY\(\$1::text\[\]\)/.test(sql)) return { rows: rowsForName };
      if (/UPDATE companies SET/.test(sql)) return { rowCount: 1, rows: [{ id: 7, code: "ACME" }] };
      return { rows: [] };
    },
  };
}

async function postProfile(pool, profile) {
  const res = makeRes();
  await handleCompanyProfile({ method: "POST", body: { token: "1234567890x", profile } }, res, pool);
  return res;
}

async function getProfile(pool) {
  const res = makeRes();
  await handleCompanyProfile({ method: "GET", query: { token: "1234567890x" } }, res, pool);
  return res;
}

{
  const pool = collabPool([{ id: 7, code: "ACME", profile_locked: false }]);
  const res = await postProfile(pool, { biz_contact_email: "evil@example.com", biz_contact_name: "Alice" });
  assert.equal(res.statusCode, 200);
  const update = pool.calls.find(c => /UPDATE companies SET/.test(c.sql));
  const setClause = update.sql.split("WHERE id=")[0];
  assert.ok(update, "expected UPDATE");
  assert.match(setClause, /biz_contact_name/);
  assert.doesNotMatch(setClause, /biz_contact_email|fin_contact_email/);
}

{
  const pool = collabPool([{ id: 7, code: "ACME", profile_locked: false }]);
  const res = await postProfile(pool, { fin_contact_email: "evil@example.com" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /由我方维护/);
  assert.ok(!pool.calls.some(c => /UPDATE companies SET/.test(c.sql)));
}

{
  const pool = collabPool([{ id: 1, code: "A" }, { id: 2, code: "B" }]);
  const res = await getProfile(pool);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /匹配到多家同名公司/);
}

{
  const pool = collabPool([{ id: 1, code: "A" }]);
  const res = await getProfile(pool);
  assert.equal(res.statusCode, 200);
  const nameSql = pool.calls.find(c => /ANY\(\$1::text\[\]\)/.test(c.sql)).sql;
  assert.match(nameSql, /merged_into_code IS NULL/);
  assert.match(nameSql, /NOT ILIKE 'DEPRECATED%'/);
}

{
  const pool = collabPool([]);
  const res = await getProfile(pool);
  assert.equal(res.statusCode, 404);
}

function companiesPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/UPDATE companies SET/.test(sql)) return { rowCount: 1, rows: [{ id: params[params.length - 1], cc_emails: params[0] }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

{
  const pool = companiesPool();
  const res = makeRes();
  await handleCompaniesRequest({ method: "PATCH", user: { role: "user" }, body: { id: 1, cc_emails: "a@x.com" } }, res, pool);
  assert.equal(res.statusCode, 403);
}

{
  const pool = companiesPool();
  const res = makeRes();
  await handleCompaniesRequest({ method: "PATCH", user: { role: "admin" }, body: { id: 1, cc_emails: "A@x.com; b@y.com" } }, res, pool);
  assert.equal(res.statusCode, 200);
  const update = pool.calls.find(c => /UPDATE companies SET/.test(c.sql));
  assert.deepEqual(update.params[0], ["a@x.com", "b@y.com"]);
}

{
  const pool = companiesPool();
  const res = makeRes();
  await handleCompaniesRequest({ method: "PATCH", user: { role: "admin" }, body: { id: 1, cc_emails: "bad-email" } }, res, pool);
  assert.equal(res.statusCode, 400);
}

{
  const js = fs.readFileSync("public/templates/collab-company-card.js", "utf8");
  const patchBlock = js.slice(js.indexOf("var patch = {"), js.indexOf("var r = await fetch", js.indexOf("var patch = {")));
  assert.doesNotMatch(patchBlock, /biz_contact_email|fin_contact_email/);
}

console.log("collab company profile lock tests passed");
