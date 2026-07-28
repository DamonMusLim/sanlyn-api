// /api/db/hr-handbook.mjs — 集团HRM · 员工手册 / 门店问题库（资料+图片）
// GET  ?category=&q=            → 列表（管理端全量）
// GET  ?id=X                    → 单篇详情（阅读数+1）
// POST {title,body,images[],..} → 新建（图片走 base64，存 /opt/sanlyn-uploads/handbook/）
// PATCH {id,...}                → 编辑
// DELETE ?id=X                  → 删除
//
// 图片放**公开目录**（ai.sanlyn.cn/uploads/handbook/…）：手册配图要在店员手机 H5 里直接渲染，
// 走私有接口取 blob 在 markdown 里很麻烦。手册是内部资料但**不含个人隐私**，与身份证/合同不同级；
// 路径带时间戳不可猜。⚠️所以别把含身份证/工资/客户名单的图往手册里塞。
import fs from "fs";
import path from "path";
import { getPool, setCors } from "./db.js";

const UPLOAD_DIR = "/opt/sanlyn-uploads/handbook";
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_BYTES = 8 * 1024 * 1024;
const CATEGORIES = ["员工手册", "常见问题", "操作指引", "安全须知"];

function saveImage(filename, mime, dataB64) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("只支持图片");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) throw new Error("图片超过8MB");
  const dir = path.join(UPLOAD_DIR, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || "img").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf);
  return `${PUBLIC_HOST}/uploads/handbook/${path.basename(dir)}/${safe}`;
}

// body 里新传的图片(base64) → 落盘换成 url，已是 url 的原样保留
function normalizeImages(list) {
  const out = [];
  for (const im of Array.isArray(list) ? list : []) {
    if (im && im.base64) {
      out.push({ url: saveImage(im.filename, im.mime, im.base64), caption: im.caption || "" });
    } else if (im && im.url) {
      out.push({ url: im.url, caption: im.caption || "" });
    }
  }
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const company = req.query?.company_code || req.body?.company_code || "JINFANG";

  try {
    if (req.method === "GET") {
      const { id, category, q, limit = 300 } = req.query;

      if (id) {
        const r = await pool.query("SELECT * FROM hr_handbook WHERE id=$1", [id]);
        if (!r.rows.length) return res.status(404).json({ success: false, error: "文章不存在" });
        pool.query("UPDATE hr_handbook SET view_count=view_count+1 WHERE id=$1", [id]).catch(() => {});
        return res.status(200).json({ success: true, data: r.rows[0] });
      }

      const params = [company]; const conds = ["company_code=$1"];
      if (category) { params.push(category); conds.push(`category=$${params.length}`); }
      if (q) {
        params.push(`%${q}%`);
        const i = params.length;
        conds.push(`(title ILIKE $${i} OR body ILIKE $${i} OR tags ILIKE $${i})`);
      }
      params.push(Math.min(parseInt(limit) || 300, 1000));
      const r = await pool.query(
        `SELECT id, category, title, body, images, tags, visibility, sort_order,
                is_published, view_count, updated_by, updated_at
           FROM hr_handbook WHERE ${conds.join(" AND ")}
          ORDER BY category, sort_order, id LIMIT $${params.length}`, params);
      return res.status(200).json({ success: true, data: r.rows, count: r.rows.length, categories: CATEGORIES });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.title) return res.status(400).json({ success: false, error: "标题必填" });
      let imgs;
      try { imgs = normalizeImages(b.images); }
      catch (e) { return res.status(400).json({ success: false, error: e.message }); }
      const r = await pool.query(
        `INSERT INTO hr_handbook (company_code,category,title,body,images,tags,visibility,sort_order,is_published,updated_by)
         VALUES ($1,COALESCE($2,'员工手册'),$3,$4,$5,$6,COALESCE($7,'all'),COALESCE($8,100),COALESCE($9,true),$10)
         RETURNING *`,
        [company, b.category || null, b.title, b.body || null, JSON.stringify(imgs),
         b.tags || null, b.visibility || null, b.sort_order ?? null, b.is_published ?? null, b.updated_by || null]);
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "PATCH") {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ success: false, error: "id 必填" });
      const sets = [], params = [];
      for (const k of ["category", "title", "body", "tags", "visibility", "sort_order", "is_published", "updated_by"]) {
        if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
      }
      if ("images" in b) {
        let imgs;
        try { imgs = normalizeImages(b.images); }
        catch (e) { return res.status(400).json({ success: false, error: e.message }); }
        params.push(JSON.stringify(imgs)); sets.push(`images=$${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "无可更新字段" });
      sets.push("updated_at=now()");
      params.push(b.id);
      const r = await pool.query(`UPDATE hr_handbook SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "文章不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ success: false, error: "id 必填" });
      const r = await pool.query("DELETE FROM hr_handbook WHERE id=$1 RETURNING id,title", [id]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "文章不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
