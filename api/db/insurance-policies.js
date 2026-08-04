// /api/db/insurance-policies.js — 投保单 CRUD(保险模块 / 投保下单模块的数据端点)
//
// 2026-08-02:前端 InsuranceModule / InsuranceApplyModule 一直调 /api/db/insurance-policies,
// 但这个端点从来没被实现过 —— 模块因此接不上线(点开就报错),在 Studio 磁盘上躺了很久。
// 本文件按 api/db/ports.js 的同款写法补齐,不自创风格。
//
// 表 insurance_policies 已存在(建表在先,端点在后),字段以库为准,**不新增不改表**。
// 鉴权:保单含客户名称/货值/税号,属内部数据 → 按 collab-closure.js 同样用 requireAuth。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 白名单 = insurance_policies 的真实列(id/created_at 由库自己管,不许外部写)。
// ⚠️ 不用 SELECT 到什么就写什么 —— 白名单挡住脏字段,也挡住 SQL 注入面。
const FIELDS = [
  "shipping_plan_id", "order_ref", "status", "insured_name",
  "policyholder_name", "policyholder_tax_id", "bl_no", "contract_no",
  "vessel_voyage", "pol", "pod", "etd", "cargo_description", "packing_qty",
  "invoice_amount", "currency", "markup_pct", "insured_amount",
  "goods_category", "transport_mode", "insurer", "rate", "exchange_rate",
  "premium_estimates", "premium_rmb", "policy_no", "policy_pdf_url",
  "filled_at", "submitted_at", "created_by",
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  // 🛡️ 保险台页面(HTML外壳,无数据→无需鉴权;页面自身读localStorage token再拉数据)
  if (req.method === "GET" && req.query.view) {
    try {
      const fsm = await import("fs");
      const pathm = await import("path");
      const urlm = await import("url");
      const root = pathm.join(pathm.dirname(urlm.fileURLToPath(import.meta.url)), "..", "..");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(fsm.readFileSync(pathm.join(root, "public", "insurance-desk.html"), "utf8"));
    } catch (e) { return res.status(500).send("保险台加载失败: " + e.message); }
  }
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  if (req.method === "GET") {
    // 📄 PDF 直链下载: ?pdf=<保单号> → 流式返回保单PDF(后台"下载保单"链接;鉴权走 ?token= 见 auth.js)
    if (req.query.pdf) {
      try {
        const fsm = await import("fs");
        const pathm = await import("path");
        const urlm = await import("url");
        const root = pathm.join(pathm.dirname(urlm.fileURLToPath(import.meta.url)), "..", "..");
        const dir = pathm.join(root, "public", "insurance-policies");
        const safe = String(req.query.pdf).replace(/[^A-Za-z0-9_.-]/g, "");
        const fp = pathm.join(dir, safe.endsWith(".pdf") ? safe : safe + ".pdf");
        if (!fp.startsWith(dir) || !fsm.existsSync(fp)) return res.status(404).json({ error: "PDF不存在或未归档" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${safe}.pdf"`);
        return fsm.createReadStream(fp).pipe(res);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    try {
      const { status, shipping_plan_id, bl_no, limit = 500 } = req.query;
      const params = [], conds = [];
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      if (shipping_plan_id) { params.push(shipping_plan_id); conds.push(`shipping_plan_id = $${params.length}`); }
      if (bl_no) { params.push(bl_no); conds.push(`bl_no = $${params.length}`); }
      let q = "SELECT * FROM insurance_policies";
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit) || 500);
      q += ` ORDER BY created_at DESC NULLS LAST, id DESC LIMIT $${params.length}`;
      const r = await pool.query(q, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rowCount });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const cols = [], vals = [], ph = [];
      for (const k of FIELDS) {
        if (body[k] === undefined) continue;
        vals.push(body[k] === "" ? null : body[k]);   // 空串一律存 NULL,别造出 '' 这种半吊子值
        cols.push(k); ph.push(`$${vals.length}`);
      }
      if (!cols.length) return res.status(400).json({ error: "没有可写入的字段" });
      const r = await pool.query(
        `INSERT INTO insurance_policies(${cols.join(",")}) VALUES(${ph.join(",")}) RETURNING *`, vals);
      return res.status(201).json({ success: true, data: r.rows[0] });
    } catch (err) {
      if (err.code === "23503") return res.status(400).json({ error: "shipping_plan_id 在海运计划里找不到" });
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "PATCH") {
    try {
      const { id, ...patch } = req.body || {};
      if (!id) return res.status(400).json({ error: "id required" });
      const sets = [], vals = [];
      for (const k of FIELDS) {
        if (patch[k] === undefined) continue;
        vals.push(patch[k] === "" ? null : patch[k]);
        sets.push(`${k} = $${vals.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: "no fields to update" });
      vals.push(id);
      const r = await pool.query(
        `UPDATE insurance_policies SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
      if (!r.rowCount) return res.status(404).json({ error: "保单不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "DELETE") {
    try {
      const id = req.query.id || req.body?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await pool.query("DELETE FROM insurance_policies WHERE id = $1", [id]);
      if (!r.rowCount) return res.status(404).json({ error: "保单不存在" });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
