// /api/db/petstore-staff-magic — War Room 嵌店员 App 免登录(Damon 1004:「嵌入就要做事的,War Room 就是给我工作的地方」)
// 入口链:War Room → pet /console/magic?k=…&next=/dataops/api/db/petstore-staff-magic(种 diary_auth)
//        → nginx /dataops/api/ 的 auth_request 验 diary_auth(单用户=damon)后补 X-Gateway-Auth → 到这里。
// 给 Damon 本人(hr_employees #35,店长)签一张与 hr-staff-auth 同格式的员工 token(role=staff,30 天),
// 写进 localStorage.jf_staff_token → 跳 /m/staff。
// ⛔ 只认网关来的请求(任何 Bearer 都不行,否则谁有 JWT 都能换成 Damon);⛔ 只签 #35,不接受传工号。
import crypto from "crypto";

const DAMON_EID = 35;
const TOKEN_DAYS = 30;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signDamonStaffToken(secret, now = Math.floor(Date.now() / 1000)) {
  const seg = [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
               b64url(JSON.stringify({ role: "staff", employee_id: DAMON_EID, name: "Damon", iat: now, exp: now + TOKEN_DAYS * 86400 }))];
  seg.push(b64url(crypto.createHmac("sha256", secret).update(seg.join(".")).digest()));
  return seg.join(".");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const viaGateway = req.headers["x-gateway-auth"] === "gw-dataops-0903";
  const secret = process.env.JWT_SECRET;
  if (req.method !== "GET" || !viaGateway || !secret) {
    res.statusCode = 403; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "forbidden" })); return;
  }
  const tok = signDamonStaffToken(secret);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><meta charset="utf-8"><title>进入店员App</title><script>' +
    'try{localStorage.setItem("jf_staff_token",' + JSON.stringify(tok) + ')}catch(e){}' +
    'location.replace("/m/staff#business")</script>');
}
