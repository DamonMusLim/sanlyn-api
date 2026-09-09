// 宠物店专用 API 服务。⛔ 跟海运彻底分开:自己的进程、自己的端口(9010)。
// 🔒 只挂 petstore-* 路由,⛔不许在这里挂任何海运的东西。
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, setCors } from "./api/db.js";
import { requireAuth } from "./api/auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, "api/db");
const PORT = Number(process.env.PETSTORE_PORT || 9010);
const PETSTORE_ALLOWED_COMPANY_CODES = ["LUVSOME"];

// 自动发现 api/db/petstore-*.js,文件名即路由
const routes = new Map();
for (const f of readdirSync(DB)) {
  if (!f.startsWith("petstore-") || !f.endsWith(".js")) continue;
  routes.set("/api/db/" + f.replace(/\.js$/, ""), join(DB, f));
}
console.log(`[petstore-api] 挂载 ${routes.size} 个路由:`, [...routes.keys()].map(p => p.split("/").pop()).join(" "));

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

async function tenantCompanyCode(user) {
  const fromToken = cleanText(user?.companyCode || user?.company_code, 80);
  if (fromToken) return fromToken;
  const uid = user?.uid || user?.id || user?.sub;
  const username = cleanText(user?.username || user?.account, 160);
  if (!uid && !username) return null;
  const r = await getPool().query(
    `SELECT company_code
       FROM accounts
      WHERE ($1::text IS NOT NULL AND id::text = $1::text)
         OR ($2::text IS NOT NULL AND username = $2)
      LIMIT 1`,
    [uid ? String(uid) : null, username],
  );
  return cleanText(r.rows[0]?.company_code, 80);
}

async function requirePetstoreTenant(req, res) {
  const companyCode = await tenantCompanyCode(req.user);
  if (PETSTORE_ALLOWED_COMPANY_CODES.includes(companyCode)) return true;
  res.status(403).json({ ok: false, error: "tenant_forbidden" });
  return false;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "petstore-api", routes: routes.size }));
  }
  const file = routes.get(url.pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  try {
    const mod = await import(file);
    const handler = mod.default || mod.handler;
    if (typeof handler !== "function") throw new Error("no handler export");
    // 补上 express 风格的 res.status().json(),这些接口是照那个写法写的
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
    req.query = Object.fromEntries(url.searchParams);
    setCors(req, res);
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      // 0831:导入 xlsx 要【原始字节】—— JSON.parse 之后就拿不到了,所以先留一份。
      req.rawBody = raw;
      try { req.body = JSON.parse(raw.toString() || "{}"); } catch { req.body = {}; }
    }
    // OPTIONS 预检必须绕过闸:各端点自己在鉴权前就返回 204(见 petstore-*.js 的
    // `if (req.method === "OPTIONS") return res.status(204).end();`)。
    // 把 requireAuth 提前会让预检变成 401,跨域客户端直接坏掉。
    // 🔴 0909 止血:/dataops/api/ 这条路的身份【在 nginx 那层已经验过】——
    //    auth_request /__console_auth(diary_auth cookie)通过之后,nginx 才补上 X-Gateway-Auth。
    //    而外部直连那条口 /api/db/petstore- 会把同名头【清空】(0907 补的防伪造)。
    //    实测全站只有这两处转发到 9010,所以带着这个头到达的请求 = 已经过 console 登录。
    //    ⛔ 不能再要 Bearer,否则整个数据加工中心 401 —— 页面拿 cookie 登录,从来没有 Bearer。
    const viaGateway = req.headers["x-gateway-auth"] === "gw-dataops-0903";
    if (req.method !== "OPTIONS" && !viaGateway) {
      if (!requireAuth(req, res)) return;
      if (!(await requirePetstoreTenant(req, res))) return;
    }
    await handler(req, res);
  } catch (e) {
    console.error("[petstore-api]", url.pathname, e);
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); }
    res.end(JSON.stringify({ error: String(e).slice(0, 200) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[petstore-api] :${PORT}`));
