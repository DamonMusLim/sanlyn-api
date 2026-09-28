import assert from "node:assert/strict";
import fs from "node:fs";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const { handleFactoryLoginCode, handleFactoryLoginVerify } = await import("../api/db/lib/po-collab-factory-login.js");
const { handleCustomerLoginCode, hashCode } = await import("../api/db/lib/po-collab-customer-login.js");
const { isCustomerToken } = await import("../api/db/lib/po-collab-customer.js");

function res() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } };
}
const req = (body = {}, token = "factory-token") => ({ body: { token, ...body }, headers: { "x-real-ip": "8.8.8.8" } });
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

class FakePool {
  constructor(opts = {}) {
    this.sheet = opts.sheet || { id: 501, order_no: "PO-1", side: "factory", factory_company_id: 42, status: "sent" };
    this.company = opts.company || { id: 42, code: "VEN-LL", name_cn: "中砂", active: true,
      contact_email: "867623700@qq.com", biz_contact_email: "", fin_contact_email: "", cc_emails: ["568622322@qq.com"] };
    this.customerCompany = { id: 7, code: "CUS-1", name_en: "Customer", contact_email: "buyer@example.com", biz_contact_email: "", cc_emails: [] };
    this.customerSheet = { id: 701, order_no: "SO-1", side: "customer", status: "sent" };
    this.customerMagic = !!opts.customerMagic;
    this.codes = [];
    this.outbox = [];
    this.accounts = opts.accounts || [];
    this.events = [];
    this.attemptId = 1;
  }
  async connect() { return { query: (s, p) => this.query(s, p), release() {} }; }
  async query(sql, params = []) {
    sql = String(sql);
    if (sql.includes("INSERT INTO auth_login_attempts")) return { rows: [{ id: this.attemptId++ }] };
    if (sql.includes("UPDATE auth_login_attempts")) return { rows: [] };
    if (sql.includes("WITH last_ok")) return { rows: [{ acct_ip: 0, ip_fails: 0, ip_buckets: 0, trusted: false, acct_hour: 0 }] };
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM magic_links") && params[1] === "customer_order") return { rows: this.customerMagic ? [{ meta: { sheet_id: 701 } }] : [] };
    if (sql.includes("FROM magic_links") && params[1] === "factory_po") return { rows: [{ meta: { sheet_id: this.sheet.id }, expires_at: new Date() }] };
    if (sql.includes("FROM collab.po_sheet") && sql.includes("side = 'factory'")) return { rows: [this.sheet] };
    if (sql.includes("FROM collab.po_sheet") && sql.includes("side='customer'")) return { rows: [this.customerSheet] };
    if (sql.includes("FROM companies WHERE id=$1")) return { rows: [this.company] };
    if (sql.includes("FROM orders o JOIN companies c")) return { rows: [this.customerCompany] };
    if (sql.includes("COUNT(*)::int n FROM collab.customer_login_code WHERE email=$1")) {
      return { rows: [{ n: this.codes.filter((c) => c.email === params[0]).length }] };
    }
    if (sql.includes("COUNT(*)::int n FROM collab.customer_login_code WHERE ip=$1")) {
      return { rows: [{ n: this.codes.filter((c) => c.ip === params[0]).length }] };
    }
    if (sql.includes("INSERT INTO collab.customer_login_code")) {
      this.codes.push({ id: this.codes.length + 1, email: params[0], company_code: params[1], sheet_id: params[2],
        code_hash: params[3], ip: params[4], tries: 0, used_at: null });
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO mail_outbox")) {
      this.outbox.push({ to: JSON.parse(params[0]), subject: params[1], body: params[2], entity_id: params[3] });
      return { rows: [] };
    }
    if (sql.includes("COALESCE(SUM(tries),0)::int n")) {
      return { rows: [{ n: this.codes.filter((c) => c.email === params[0]).reduce((a, c) => a + c.tries, 0) }] };
    }
    if (sql.includes("SELECT id, code_hash, tries FROM collab.customer_login_code")) {
      const row = [...this.codes].reverse().find((c) => c.email === params[0] && c.company_code === params[1]
        && (!sql.includes("sheet_id=$3") || c.sheet_id === params[2]) && !c.used_at && c.tries < 5);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("SET tries = tries + 1")) { this.codes.find((c) => c.id === params[0]).tries += 1; return { rows: [] }; }
    if (sql.includes("SET used_at=NOW()")) { this.codes.find((c) => c.id === params[0]).used_at = true; return { rows: [] }; }
    if (sql.includes("FROM accounts WHERE lower(email)=$1")) {
      return { rows: this.accounts.filter((a) => [a.email, a.username].map((v) => String(v || "").toLowerCase()).includes(params[0])) };
    }
    if (sql.includes("UPDATE accounts SET password")) {
      const a = this.accounts.find((x) => x.id === params[0]); a.token_version = (a.token_version || 1) + 1; a.password = params[1];
      return { rows: [{ token_version: a.token_version }] };
    }
    if (sql.includes("INSERT INTO accounts")) {
      const a = { id: 100 + this.accounts.length, username: params[0], role: "factory", company: params[2],
        company_code: params[3], company_codes: [params[3]], email: params[0], token_version: 1, raw: JSON.parse(params[4]) };
      this.accounts.push(a); return { rows: [a] };
    }
    if (sql.includes("INSERT INTO collab.po_event")) { this.events.push({ sheet_id: params[0], kind: sql.match(/'([^']+_login_activated)'/)?.[1] }); return { rows: [] }; }
    throw new Error("unhandled sql: " + sql.slice(0, 120));
  }
}

async function sendCode() {
  const pool = new FakePool();
  const r = res();
  await handleFactoryLoginCode(req({ email: "568622322@qq.com" }), r, pool);
  assert.equal(r.statusCode, 200);
  assert.equal(pool.codes[0].company_code, "VEN-LL");
  assert.equal(pool.outbox[0].to[0], "568622322@qq.com");
  assert.match(pool.outbox[0].subject, /^采购单协同登录验证码:\d{6}$/);
  assert.match(pool.outbox[0].body, /重设密码/);
  return pool;
}

await sendCode();

{
  const pool = new FakePool();
  const r = res();
  await handleFactoryLoginCode(req({ email: "nope@example.com" }), r, pool);
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /不是我们登记/);
}

{
  const pool = new FakePool({ customerMagic: true });
  assert.equal(await isCustomerToken(pool, "customer-token"), true);
  const src = fs.readFileSync(new URL("../api/db/po-collab.js", import.meta.url), "utf8");
  assert(src.indexOf("handleCustomerLoginCode") < src.indexOf("handleFactoryLoginCode"));
}

{
  const pool = new FakePool();
  pool.codes.push({ id: 1, email: "568622322@qq.com", company_code: "VEN-LL", sheet_id: 501, code_hash: hashCode("568622322@qq.com", "123456"), tries: 0 });
  const r = res();
  await handleFactoryLoginVerify(req({ email: "568622322@qq.com", code: "123456", password: "password1" }), r, pool);
  assert.equal(r.statusCode, 200);
  assert.equal(pool.accounts[0].role, "factory");
  assert.deepEqual(pool.accounts[0].company_codes, ["VEN-LL"]);
  assert.equal(decode(r.body.token).companyCode, "VEN-LL");
}

{
  const pool = new FakePool();
  pool.codes.push({ id: 1, email: "568622322@qq.com", company_code: "VEN-LL", sheet_id: 501, code_hash: hashCode("568622322@qq.com", "123456"), tries: 0 });
  const r = res();
  await handleFactoryLoginVerify(req({ email: "568622322@qq.com", code: "000000", password: "password1" }), r, pool);
  assert.equal(r.statusCode, 401);
  assert.equal(pool.codes[0].tries, 1);
}

for (const acct of [
  { role: "customer", company_code: "VEN-LL", company_codes: ["VEN-LL"] },
  { role: "admin", company_code: "VEN-LL", company_codes: ["VEN-LL"] },
  { role: "factory", company_code: "OTHER", company_codes: ["OTHER"] },
]) {
  const pool = new FakePool({ accounts: [{ id: 9, username: "568622322@qq.com", email: "568622322@qq.com", token_version: 1, raw: {}, ...acct }] });
  pool.codes.push({ id: 1, email: "568622322@qq.com", company_code: "VEN-LL", sheet_id: 501, code_hash: hashCode("568622322@qq.com", "123456"), tries: 0 });
  const r = res();
  await handleFactoryLoginVerify(req({ email: "568622322@qq.com", code: "123456", password: "password1" }), r, pool);
  assert.equal(r.statusCode, 403);
}

{
  const pool = new FakePool({ accounts: [{ id: 9, username: "568622322@qq.com", email: "568622322@qq.com", role: "factory", company: "中砂", company_code: "VEN-LL", company_codes: ["VEN-LL"], token_version: 2, raw: {} }] });
  pool.codes.push({ id: 1, email: "568622322@qq.com", company_code: "VEN-LL", sheet_id: 501, code_hash: hashCode("568622322@qq.com", "123456"), tries: 0 });
  const r = res();
  await handleFactoryLoginVerify(req({ email: "568622322@qq.com", code: "123456", password: "password1" }), r, pool);
  assert.equal(r.statusCode, 200);
  assert.equal(pool.accounts[0].token_version, 3);
}

{
  const pool = new FakePool();
  const r = res();
  await handleFactoryLoginVerify(req({ email: "568622322@qq.com", code: "123456", password: "short" }), r, pool);
  assert.equal(r.statusCode, 400);
}

{
  const pool = new FakePool({ customerMagic: true });
  const r = res();
  await handleCustomerLoginCode(req({ email: "other@example.com" }, "customer-token"), r, pool);
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /not registered/);
}

console.log("po factory email login tests passed");
