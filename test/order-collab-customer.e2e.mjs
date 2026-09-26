// 订单协同·客户版 全流程测试（只打 API；测试单 48-DG-1 = HARMONIOUS CN-00048）
// 用法：BASE_URL=http://127.0.0.1:4902 node test/order-collab-customer.e2e.mjs   → 结果 /tmp/oc-e2e.json
// 账号全是签发的测试令牌（不碰密码）；跑完用同目录的清理段把测试数据收掉（见文件尾）。
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
const env = Object.fromEntries(fs.readFileSync("/opt/sanlyn-api-test/.env", "utf8").split(/\n/).filter(l => l.includes("="))
  .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const mk = (pl) => { const b = o => Buffer.from(JSON.stringify(o)).toString("base64url"); const n = Math.floor(Date.now() / 1000);
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ ...pl, iat: n, exp: n + 1800 });
  return h + "." + p + "." + crypto.createHmac("sha256", env.JWT_SECRET).update(h + "." + p).digest("base64url"); };
const ADMIN = mk({ uid: 1, username: "damon_sl", role: "admin" });
const DAMON = mk({ uid: 91, username: "damon", role: "petstore" });
const HARM = mk({ uid: 15, username: "harmonious", role: "customer", companyCode: "CN-00048", companyCodes: ["CN-00048", "CN-00079"] });
const ENRICH = mk({ uid: 14, username: "enrich", role: "customer", companyCode: "CN-00040", companyCodes: ["CN-00040"] });
const PETSOME = mk({ uid: 42, username: "petsome", role: "customer", companyCode: "CN-00037", companyCodes: ["CN-00037", "CN-00038", "CN-00039"] });
const ZA = mk({ uid: 51, username: "za", role: "factory", companyCode: "VEN-LL" });
const SHOP = mk({ uid: 555, username: "shop", role: "petstore" });
const B = (process.env.BASE_URL || "http://127.0.0.1:4902") + "/api/db/po-collab";
const call = async (jwt, method, path, body) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: "Bearer " + jwt } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) { const j = await r.json(); return { s: r.status, ...j, _raw: JSON.stringify(j) }; }
  return { s: r.status, buf: Buffer.from(await r.arrayBuffer()), ct };
};
const R = {}; const ok = (k, c, info) => { R[k] = { pass: !!c, ...(info || {}) }; };
const ORDER = "48-DG-1";

// 1 发客户链接
const sl = await call(ADMIN, "POST", "/send-link", { order_no: ORDER, side: "customer" });
const raw = (sl.magic_link || "").split("c=")[1]; const SID = sl.sheet_id;
ok("01_send_link_customer", sl.s === 200 && raw && sl.side === "customer", { sheet: SID });
ok("01b_shop_cannot_send", (await call(SHOP, "POST", "/send-link", { order_no: ORDER, side: "customer" })).s === 403);
// 2 同一订单可同时有工厂单：发一张工厂单，客户单不能被作废
const fsl = await call(ADMIN, "POST", "/send-link", { order_no: ORDER });
const fraw = (fsl.magic_link || "").split("c=")[1];
const V = (jwt, tok = raw) => call(jwt, "GET", `/validate?token=${tok}`);
let v = await V(HARM);
ok("02_factory_and_customer_coexist", fsl.s === 200 && v.s === 200 && v.valid, { factory_sheet: fsl.sheet_id });
// 3 权限
ok("03_group_account_opens", v.s === 200 && v.sheet?.side === "customer");
ok("03b_other_customer_403", (await V(ENRICH)).s === 403);
ok("03c_other_group_403", (await V(PETSOME)).s === 403);
ok("03d_factory_account_403", (await V(ZA)).s === 403);
ok("03e_no_login_401", (await V(null)).s === 401);
ok("03f_damon_internal_200", (await V(DAMON)).s === 200);
ok("03g_customer_cannot_open_factory_link", [401, 403].includes((await V(HARM, fraw)).s) && !(await V(HARM, fraw)).valid);
ok("03h_factory_link_not_customer_page", (await V(ZA, fraw)).sheet?.side !== "customer");
// 4 隔离：客户版响应里不许有工厂/内部字段
const J = v._raw;
const fac = (await call(ADMIN, "GET", `/validate?token=${fraw}`));   // 取工厂名做反证
const facName = fac.sheet?.factory_name || "义乌市淘淘";
ok("04_no_factory_name", !J.includes(facName) && !J.includes("义乌"), { facName });
ok("04b_no_factory_keys", !/factory_price|factory_amount|factory_company|middleman|markup|cost/i.test(J));
ok("04c_no_order_no", !J.includes(ORDER));
ok("04d_customer_price_present", v.lines?.[0]?.ours?.price != null && v.lines?.[0]?.ours?.amount != null, { p: v.lines?.[0]?.ours });
ok("04e_factory_view_no_customer", !fac._raw.includes("HARMONIOUS") && !fac._raw.includes("1.8156"));
ok("04f_seller_buyer_payee", v.sheet?.seller?.name_en?.includes("PET BABY") && v.sheet?.buyer?.name_en?.includes("HARMONIOUS") && !!v.sheet?.payee,
  { seller: v.sheet?.seller?.name_en, buyer: v.sheet?.buyer?.name_en, payee: v.sheet?.payee?.currency });
ok("04g_siblings_listed", (v.sheet?.siblings || []).some(x => String(x.id) === String(SID)));
ok("04h_shipment_flag", v.sheet?.shipment?.available === false);
// 5 客户提修改申请
const L0 = v.lines[0], L1 = v.lines[1];
const T = { token: raw, sheet: SID };
const sub = await call(HARM, "POST", "/submit", { ...T, lines: [{ id: L0.id, qty: Number(L0.ours.qty) + 10, note: "please pack double" }, { id: L1.id, qty: L1.ours.qty }],
  request: { delivery: "2026-11-15", marks: "HHV / PORT KLANG / C/NO.1-UP", remarks: "test remark" } });
ok("05_submit_changes", sub.s === 200 && sub.changed === 5, { changed: sub.changed, status: sub.status });
v = await V(HARM);
ok("05b_changes_visible", Number(v.lines[0].theirs?.qty) === Number(L0.ours.qty) + 10 && v.sheet.request?.delivery === "2026-11-15" && v.history.length >= 2);
ok("05c_bad_qty_ignored", (await call(HARM, "POST", "/submit", { ...T, lines: [{ id: L0.id, qty: -5 }] })).changed === 0);
ok("05d_enrich_cannot_submit", (await call(ENRICH, "POST", "/submit", { ...T, lines: [] })).s === 403);
// 6 PI PDF：客户页渲染、盖章位在买方栏、PDF 里没有工厂名/采购合同字样
const pdf = await call(HARM, "GET", `/contract-pdf?token=${raw}&sheet=${SID}`);
let pdfText = "";
if (pdf.buf) { fs.writeFileSync("/tmp/oc-pi.pdf", pdf.buf); pdfText = execFileSync("pdftotext", ["/tmp/oc-pi.pdf", "-"]).toString(); }
ok("06_pi_pdf", pdf.s === 200 && pdf.buf?.slice(0, 4).toString() === "%PDF", { bytes: pdf.buf?.length });
ok("06b_pi_has_seal_spot", pdfText.includes("（盖章）"));
ok("06c_pi_no_factory", !pdfText.includes(facName) && !pdfText.includes("采购合同") && !pdfText.includes(ORDER));
ok("06d_pi_shows_buyer", pdfText.includes("HARMONIOUS"));
// 7 盖章：没登记章 → 409；工厂/内部账号不能替客户盖
ok("07_seal_without_stamp_409", (await call(HARM, "POST", "/seal", T)).s === 409);
ok("07b_admin_cannot_seal", (await call(ADMIN, "POST", "/seal", T)).s === 403);
// 8 公章上传 → 待审核 → 驳回（测试用假章，跑完作废）
const png = execFileSync("python3", ["-c", "import base64,zlib,struct\n"
  + "def c(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)\n"
  + "raw=b''.join(b'\\x00'+b'\\xcc\\x00\\x00'*8 for _ in range(8))\n"
  + "print(base64.b64encode(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b'')).decode())"]).toString().trim();
ok("08_admin_cannot_upload_seal", (await call(ADMIN, "POST", "/seal-upload", { ...T, filename: "t.png", mime: "image/png", data_base64: png })).s === 403);
const su = await call(HARM, "POST", "/seal-upload", { ...T, filename: "test-seal.png", mime: "image/png", data_base64: png });
v = await V(HARM);
ok("08b_seal_pending", su.s === 200 && v.sheet.seal?.status === "pending", { stamp: su.stamp_id });
const rj = await call(ADMIN, "POST", "/seal-approve", { stamp_id: su.stamp_id, approve: false, reason: "测试章，作废" });
v = await V(HARM);
ok("08c_seal_rejected_shown", rj.s === 200 && v.sheet.seal?.status === "rejected");
// 9 上传签好的 PI → confirmed → 任务 pi-confirm
const up = await call(HARM, "POST", "/upload", { ...T, kind: "signed_back", filename: "signed.pdf", mime: "application/pdf", data_base64: pdf.buf.toString("base64") });
ok("09_upload_signed_confirmed", up.s === 200 && up.status === "confirmed", { status: up.status, err: up.error });
ok("09b_bad_mime_400", (await call(HARM, "POST", "/upload", { ...T, filename: "x.exe", mime: "application/x-msdownload", data_base64: "AAAA" })).s === 400);
const cdl = await call(HARM, "GET", `/contract?token=${raw}&sheet=${SID}`);
ok("09c_contract_download", cdl.s === 200 && cdl.buf?.slice(0, 4).toString() === "%PDF");
// 10 我方审核页
const rv = await call(ADMIN, "GET", `/review?sheet=${SID}`);
ok("10_review_customer_side", rv.s === 200 && rv.sheet?.side === "customer" && rv.task?.id === `pi-confirm-${SID}`, { task: rv.task });
ok("10b_review_customer_403", (await call(HARM, "GET", `/review?sheet=${SID}`)).s === 403);
// 11 退回 → 客户看到原因 → 重交 → 仍 confirmed（签好的 PI 还在）
ok("11_return_needs_reason", (await call(ADMIN, "POST", "/return", { sheet_id: +SID })).s === 400);
const rt = await call(ADMIN, "POST", "/return", { sheet_id: +SID, reason: "Please confirm the quantity of line 1" });
v = await V(HARM);
ok("11b_returned_visible", rt.s === 200 && v.sheet.status === "returned" && /quantity/.test(v.sheet.return_reason || ""));
const re = await call(HARM, "POST", "/submit", { ...T, lines: [{ id: L0.id, qty: L0.ours.qty }] });
ok("11c_resubmit_confirmed", re.s === 200 && re.status === "confirmed", { status: re.status });
// 12 采纳 → customer_confirmed_at；只读
const ad = await call(DAMON, "POST", "/adopt", { sheet_id: +SID });
v = await V(HARM);
ok("12_adopt", ad.s === 200 && ad.customer_confirmed === true && v.sheet.status === "adopted", { err: ad.error });
ok("12b_submit_after_adopt_409", (await call(HARM, "POST", "/submit", { ...T, lines: [] })).s === 409);
ok("12c_upload_after_adopt_409", (await call(HARM, "POST", "/upload", { ...T, filename: "a.pdf", mime: "application/pdf", data_base64: pdf.buf.toString("base64") })).s === 409);
// 13 发货协同：没订舱 → 404
ok("13_shipment_link_404_before_booking", (await call(HARM, "POST", "/shipment-link", T)).s === 404);

R._ids = { customer_sheet: SID, factory_sheet: fsl.sheet_id, stamp: su.stamp_id };
fs.writeFileSync("/tmp/oc-e2e.json", JSON.stringify(R, null, 1));
const fails = Object.entries(R).filter(([k, x]) => k[0] !== "_" && !x.pass).map(([k]) => k);
console.log(JSON.stringify({ total: Object.keys(R).length - 1, fails, ids: R._ids }, null, 1));
