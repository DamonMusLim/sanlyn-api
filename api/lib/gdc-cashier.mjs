import crypto from "crypto";

const BASE = "http://emallopen.guodongcheng.cn/api/";
// 收银端登录链(与 mini ~/guodongcheng-agent/lib/login.mjs 一致,0816 实测通)
const CASHIER_BASE = "https://mini.guodongcheng.cn/cashier/";
const TOKEN_SKEW_MS = 3600_000;

let cashierCache = null;
let secretCache = null;

function form(obj) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => p.set(k, v == null ? "" : String(v)));
  return p;
}

function parseJwtExp(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return Date.now() + 1800_000;
  }
}

function mergeCookie(oldCookie, setCookie) {
  const jar = new Map();
  String(oldCookie || "").split(";").forEach((x) => {
    const i = x.indexOf("=");
    if (i > 0) jar.set(x.slice(0, i).trim(), x.slice(i + 1).trim());
  });
  const xs = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean);
  xs.forEach((line) => {
    const part = String(line).split(";")[0];
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  });
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function responseCookies(res) {
  if (typeof res.headers?.getSetCookie === "function") return res.headers.getSetCookie();
  const v = res.headers?.get?.("set-cookie");
  return v ? [v] : [];
}

// 公钥是 base64 的 DER(SPKI),不是 PEM
function publicEncryptDer(b64, text) {
  const key = crypto.createPublicKey({ key: Buffer.from(String(b64).replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(text, "utf8")).toString("base64");
}

export function makeSign(params, appSecret) {
  const s = Object.keys(params).sort().map((k) => `${k}${String(params[k] ?? "").trim()}`).join("");
  return crypto.createHash("md5").update(s + String(appSecret || "").trim()).digest("hex");
}

async function postForm(fetcher, url, body, headers = {}, cookie = "") {
  const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers, ...(cookie ? { cookie } : {}) }, body: form(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { success: false, message: text }; }
  return { json, cookie: mergeCookie(cookie, responseCookies(res)) };
}

export function createGdcCashierClient({ fetcher = fetch, env = process.env, now = Date.now } = {}) {
  const tenant = env.GDC_TENANT_CODE;
  const account = env.GDC_USER_ACCOUNT;
  const password = env.GDC_PASSWORD;
  const storeCode = env.GDC_STORE_CODE;

  async function cashierToken() {
    if (cashierCache && cashierCache.exp - TOKEN_SKEW_MS > now()) return cashierCache;
    if (!tenant || !account || !password || !storeCode) throw new Error("gdc_env_missing");
    let cookie = "";
    const hdr = { "user-env-flag": "APPLET", "head-store-code": storeCode };
    let r = await postForm(fetcher, CASHIER_BASE + "miniOrange/login/getPublicKey", { tenantCode: tenant, userAccount: account }, hdr, cookie);
    cookie = r.cookie;
    const pub = r.json?.data?.public_key;
    const random = r.json?.data?.random_str;
    if (!pub || !random) throw new Error("gdc_public_key_missing");
    // loginPwd 要双重编码:这里 encodeURIComponent 一次,表单提交再编一次(只编一次恒返 201)
    const loginPwd = encodeURIComponent(publicEncryptDer(pub, password + random));
    r = await postForm(fetcher, CASHIER_BASE + "miniOrange/login/signIn", { tenantCode: tenant, userAccount: account, loginPwd, token: "", deviceBrand: "server", newVersion: "true" }, hdr, cookie);
    cookie = r.cookie;
    if (Number(r.json?.code) !== 200) throw new Error("gdc_signin_failed");
    r = await postForm(fetcher, CASHIER_BASE + "miniOrange/auth/receiveUerInfo", { tenantCode: tenant, userAccount: account, storeCode }, hdr, cookie);
    const token = r.json?.data?.token;
    if (!token) throw new Error("gdc_token_missing");
    cashierCache = { token, cookie: r.cookie, exp: parseJwtExp(token), storeCode };
    return cashierCache;
  }

  async function secret() {
    if (secretCache) return secretCache;
    if (!tenant) throw new Error("gdc_env_missing");
    const r = await postForm(fetcher, BASE + "api/company/miniRentLogin", { rentAccount: tenant });
    const app_id = r.json?.data?.app_id;
    const app_secret = r.json?.data?.app_secret;
    if (!app_id || !app_secret) throw new Error("gdc_secret_missing");
    secretCache = { app_id, app_secret };
    return secretCache;
  }

  async function call(path, body) {
    const auth = await cashierToken();
    const sec = await secret();
    const payload = JSON.stringify(body || {});
    const timestamp = String(now());
    const sign = makeSign({ app_id: sec.app_id, body: payload, timestamp }, sec.app_secret);
    const r = await postForm(fetcher, BASE + path, { app_id: sec.app_id, timestamp, body: encodeURIComponent(payload), sign }, { "user-env-flag": "APPLET", "head-store-code": auth.storeCode, token: auth.token }, auth.cookie);
    if (r.json?.code != null && !["0", "200"].includes(String(r.json.code))) throw new Error(r.json.message || "gdc_error");
    return r.json?.data ?? r.json;
  }

  return {
    list: (body) => call("pos/order/list", body),
    detail: (body) => call("pos/order/detailsV2", body),
    unpicked: (body) => call("pos/order/queryUnpickedOrderCount", body),
  };
}
