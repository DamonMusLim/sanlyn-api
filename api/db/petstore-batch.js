// /api/db/petstore-batch —— 在后台直接看任务批次的内容，不用开店员链接。
// (Damon 2026-08-13：「我们后台看」+「1、2 可以同时」)
//
// 老板在后台已经是登录状态，批次内容本来就该在这里展开：
// 这 300 件是什么、做了多少、谁做的。链接是给店员用的，不该是老板查看的方式。
//
// 走本机 127.0.0.1 调 clerk 服务的 /progress（boss 字段全集）——
// 本机直连不带 X-Forwarded-For，过得了 clerk 的管理员守卫。
import { setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import fs from "node:fs";

const CLERK = "http://127.0.0.1:7432";

function adminToken() {
  try {
    for (const line of fs.readFileSync("/opt/pet-ai-clerk/.env", "utf8").split("\n"))
      if (line.startsWith("CLERK_ADMIN_TOKEN=")) return line.slice(18).trim();
  } catch { /* 本机直连时守卫也会放行 */ }
  return "";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).json({ success: false, error: "token required" });

  try {
    const r = await fetch(`${CLERK}/progress?token=${encodeURIComponent(token)}`, {
      headers: { "X-Clerk-Admin": adminToken() },
    });
    const j = await r.json();
    if (!j.ok) return res.status(r.status || 500).json({ success: false, error: j.error || "读不到批次" });

    const tasks = j.tasks || [];
    const done = tasks.filter((t) => t.status && t.status !== "pending").length;
    // 卡片里的 system_data 是字符串，展开成对象方便前端直接用
    const rows = tasks.map((t) => {
      let sd = {};
      try { sd = JSON.parse(t.system_data || "{}"); } catch { /* 不是 JSON 就算了 */ }
      return {
        id: t.id, product_code: t.product_code, product_name: t.product_name,
        spec: t.spec || "", shelf: String(t.shelf_list || "").replace(/[[\]"]/g, "") || "",
        status: t.status, clerk_note: t.clerk_note || "", clerk_id: t.clerk_id || "",
        submitted_at: t.submitted_at || null, actual_qty: t.actual_qty,
        actual_expiry: t.actual_expiry || "", exception_type: t.exception_type || "",
        stock: sd.stock, out_price: sd.out_price, cost_price: sd.cost_price,
        warn_status: sd.warn_status || "", sys_expiry: sd.sys_expiry || "",
        problem: sd["🔴问题"] || "", suggest: sd["💡建议价"] || "",
      };
    });

    return res.json({
      success: true,
      data: {
        batch: {
          token: j.batch?.token, purpose: j.batch?.purpose,
          task_count: tasks.length, done_count: done,
          pending_count: tasks.length - done,
          created_at: j.batch?.created_at, expires_at: j.batch?.expires_at,
          assigned_name: j.batch?.assigned_name || null,
          owner_role: j.batch?.owner_role || null,
          // 做完即失效：expires_at 被拨到过去就说明这批已收工
          finished: !!(j.batch?.expires_at && new Date(j.batch.expires_at) <= new Date()),
        },
        rows,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e.message || e) });
  }
}
