// hr-staff-portal-lib.mjs — 员工自助接口的取数/存档小工具
// 从 hr-staff-portal.mjs 拆出来（0802，单文件≤500行铁律）。这里只放纯工具，
// 不做鉴权、不碰 req/res —— 鉴权与动作分发一律留在 hr-staff-portal.mjs。
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export const D = "YYYY-MM-DD";

// 当天条目:kind='tip' 进「建议」(Damon 自己写的)，其余进「今日待办」(带时间的安排)。
// 一张表两种用途，不另加表。
export async function agendaFor(pool, companyCode, today) {
  const r = await pool.query(
    `SELECT id, to_char(at_time,'HH24:MI') AS at_time, title, note, kind, status
       FROM hr_day_agenda
      WHERE company_code=$1 AND work_date=$2
      ORDER BY at_time NULLS LAST, id`, [companyCode, today]);
  const all = r.rows;
  return {
    items: all.filter((x) => x.kind !== "tip"),
    tips: all.filter((x) => x.kind === "tip"),
  };
}

// 点检照片交 MiniMax-M3 判。⚠️ 只标不拦:判不合格也记完成，异常留给店长看。
// (M3 是多模态的,2026-08-01 实测;旧的 MiniMax-VL-01 已下线)
export async function reviewPhoto(title, hint, dataUrl) {
  const key = process.env.MINIMAX_API_KEY;
  if (!key || !dataUrl) return null;
  const prompt = `宠物店点检项「${title}」。看图后只回JSON：`
    + `{"能判断":true/false,"合格":true/false,"看到什么":"25字内","问题":["没有就空"]}`;
  try {
    const r = await fetch("https://api.minimaxi.com/v1/text/chatcompletion_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "MiniMax-M3", max_tokens: 1500,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } }] }],
      }),
      signal: AbortSignal.timeout(40000),
    });
    const d = await r.json();
    const m = d?.choices?.[0]?.message || {};
    let t = m.content || m.reasoning_content || "";   // M3 是推理模型,正文可能为空
    t = t.replace(/```json|```/g, "").trim();       // M3 会用 code fence 包
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    return JSON.parse(t.slice(a, b + 1));
  } catch (e) { return null; }   // AI 挂了不影响店员打勾
}

// 开店点检：模板 hr_checklist_items(phase='open') + 当天执行记录 hr_checklist_logs。
// 只在「当天还没人做完开店点检」时返回，做完就不再打扰。
export async function openChecklist(pool, companyCode, today) {
  const r = await pool.query(
    `SELECT i.id, i.seq, i.title, i.hint, i.need_photo,
            l.status, l.employee_name, to_char(l.done_at,'HH24:MI') AS done_at
       FROM hr_checklist_items i
       LEFT JOIN hr_checklist_logs l
         ON l.item_id = i.id AND l.work_date = $2 AND l.company_code = i.company_code
      WHERE i.company_code = $1 AND i.phase = 'open' AND i.is_active = true
      ORDER BY i.seq, i.id`, [companyCode, today]);
  const items = r.rows;
  if (!items.length) return null;
  const left = items.filter((x) => !x.status).length;
  return { phase: "open", total: items.length, left, items };
}

// ── 今日待办：读店员任务真源 ────────────────────────────────────────
// 真源 = 腾讯本地 /opt/pet-ai-clerk/data/decisions.db（clerk-service 在写）。
// ⚠️ mini 上那份 ~/.openclaw/decisions.db 是**陈旧存档**(2026-07-05 后就没更新)，别再读它。
// 腾讯 node v18 没有 node:sqlite，走 sqlite3 CLI 只读。
const CLERK_DB = "/opt/pet-ai-clerk/data/decisions.db";
const KIND_LABEL = {
  verify_expiry: "保质期核查", verify_stock: "库存核对", restock_photo: "补货拍照",
  stocktake: "盘点", discount_review: "改价复核", review_losing: "亏本复核",
  review_expired: "临期复核",
};
function clerkQuery(sql) {
  try {
    const r = spawnSync("sqlite3", ["-json", "-readonly", CLERK_DB, sql],
      { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return [];
    return JSON.parse(r.stdout || "[]");
  } catch { return []; }
}
// 只给金枋的人看（clerk_tasks 全是金枋店的活）。开第二家店时这里要改成按 store_code 过滤。
export function todoFor(companyCode) {
  if (String(companyCode || "") !== "JINFANG") return { total: 0, by_kind: [], recent: [] };
  const byKind = clerkQuery(
    "SELECT kind, COUNT(*) AS n FROM clerk_tasks WHERE status='pending' GROUP BY kind ORDER BY n DESC");
  // 批数:件数对店员没意义(3541 件一天做不完)，「还有几批」才抓得住
  const bat = clerkQuery(
    "SELECT COUNT(DISTINCT batch_token) AS n FROM clerk_tasks WHERE status='pending'");
  // 只取品名和货架，system_data 里有成本价，绝不外泄
  const recent = clerkQuery(
    "SELECT kind, product_name, shelf_list FROM clerk_tasks WHERE status='pending' " +
    "ORDER BY assigned_at DESC LIMIT 3");
  return {
    total: byKind.reduce((a, x) => a + (x.n || 0), 0),
    batches: (bat[0] && bat[0].n) || 0,
    by_kind: byKind.map((x) => ({ kind: x.kind, label: KIND_LABEL[x.kind] || x.kind, n: x.n })),
    recent: recent.map((x) => ({ label: KIND_LABEL[x.kind] || x.kind,
      product_name: x.product_name, shelf: x.shelf_list })),
  };
}
const UPLOAD_DIR = "/opt/sanlyn-uploads/reimbursement";
export const PRIVATE_ROOT = "/opt/sanlyn-private/hr";   // 证件私有目录，不在任何 web root 内
const PUBLIC_HOST = "https://ai.sanlyn.cn";
const MAX_BYTES = 6 * 1024 * 1024;

export function saveReceipt(filename, mime, dataB64) {
  if (!/^image\//.test(String(mime || ""))) throw new Error("小票只能是图片");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > MAX_BYTES) throw new Error("图片超过6MB");
  const dir = path.join(UPLOAD_DIR, String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || "receipt").replace(/[^a-zA-Z0-9._一-龥-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf);
  return `${PUBLIC_HOST}/uploads/reimbursement/${path.basename(dir)}/${safe}`;
}

// 身份证照片存私有目录，路径规则跟 hr-employees.mjs 的 saveDoc 保持一致（只存相对路径）
export function savePrivateIdCard(employeeId, filename, mime, dataB64) {
  const ok = /^image\//.test(String(mime || "")) || mime === "application/pdf";
  if (!ok) throw new Error("身份证只能传图片或 PDF");
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length > 8 * 1024 * 1024) throw new Error("文件超过8MB");
  const dir = path.join(PRIVATE_ROOT, String(employeeId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = `id_card_${Date.now()}_` +
    String(filename || "doc").replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_");
  fs.writeFileSync(path.join(dir, safe), buf, { mode: 0o600 });
  return path.posix.join(String(employeeId), safe);
}

export function monthOf(v) {
  if (/^\d{4}-\d{2}$/.test(String(v || ""))) return v;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
