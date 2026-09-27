#!/usr/bin/env node
import assert from "node:assert/strict";
import { makeHandler } from "./petstore-inbox.mjs";

function res() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
    setHeader() {},
  };
}

const staff = { empId: 7, me: { id: 7, name: "汪卫云", role: "staff", company_code: "JINFANG", employment_status: "active" } };
const noCors = () => {};
const pool = () => ({ query: async () => ({ rows: [] }) });

async function call(h, body) {
  const out = res();
  await h({ method: "POST", body, query: {} }, out);
  return out;
}

{
  const h = makeHandler({ poolFactory: pool, setCorsFn: noCors, verifyStaff: async () => staff, env: {}, fetchFn: async () => { throw new Error("should not call"); } });
  const r = await call(h, { action: "list" });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "消息服务未配置");
}

{
  const secret = "relay-secret-token";
  let seenToken = "";
  const h = makeHandler({
    poolFactory: pool,
    setCorsFn: noCors,
    verifyStaff: async () => staff,
    env: { MSG_RELAY_TOKEN: secret },
    fetchFn: async (url, opt) => {
      seenToken = opt.headers["x-relay-token"];
      return new Response(JSON.stringify([{ conversation_id: "c1", unread: 2 }]), { status: 200 });
    },
  });
  const r = await call(h, { action: "list" });
  assert.equal(r.statusCode, 200);
  assert.equal(seenToken, secret);
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(secret));
}

{
  const h = makeHandler({
    poolFactory: pool,
    setCorsFn: noCors,
    verifyStaff: async () => staff,
    env: { MSG_RELAY_TOKEN: "t" },
    fetchFn: async () => new Response(JSON.stringify({ status: "blocked", reason: "需老板批准" }), { status: 200 }),
  });
  const r = await call(h, { action: "send", conversation_id: "c1", text: "好" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.status, "blocked");
  assert.equal(r.body.data.reason, "需老板批准");
}

{
  const h = makeHandler({ poolFactory: pool, setCorsFn: noCors, verifyStaff: async () => staff, env: {}, photoSaver: () => { throw new Error("只允许上传图片"); } });
  const r = await call(h, { action: "upload_image", photo: { mime: "text/plain", base64: "eA==" } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "只允许上传图片");
}

console.log("petstore-inbox tests passed");
