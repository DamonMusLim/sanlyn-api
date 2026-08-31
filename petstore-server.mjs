// 宠物店专用 API 服务。⛔ 跟海运彻底分开:自己的进程、自己的端口(9010)。
// 🔒 只挂 petstore-* 路由,⛔不许在这里挂任何海运的东西。
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, "api/db");
const PORT = Number(process.env.PETSTORE_PORT || 9010);

// 自动发现 api/db/petstore-*.js,文件名即路由
const routes = new Map();
for (const f of readdirSync(DB)) {
  if (!f.startsWith("petstore-") || !f.endsWith(".js")) continue;
  routes.set("/api/db/" + f.replace(/\.js$/, ""), join(DB, f));
}
console.log(`[petstore-api] 挂载 ${routes.size} 个路由:`, [...routes.keys()].map(p => p.split("/").pop()).join(" "));

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
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      // 0831:导入 xlsx 要【原始字节】—— JSON.parse 之后就拿不到了,所以先留一份。
      req.rawBody = raw;
      try { req.body = JSON.parse(raw.toString() || "{}"); } catch { req.body = {}; }
    }
    await handler(req, res);
  } catch (e) {
    console.error("[petstore-api]", url.pathname, e);
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); }
    res.end(JSON.stringify({ error: String(e).slice(0, 200) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`[petstore-api] :${PORT}`));
