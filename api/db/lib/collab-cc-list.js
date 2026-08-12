// 单据自动发信的「抄送名单」自助管理（我方 业务/财务）。存 system_settings.key='doc_mail.cc'，
// value=JSON 数组 [{email,label,category:'biz'|'fin',active,added_at,added_by}]。mailer 发信时全员抄送(active)。
// ⚠ 内部登录才可管（本路由不进 PUBLIC_PATHS → requireAuth 自动生效）。
// ⚠ system_settings.key 无唯一索引，写它用 DELETE+INSERT，别 ON CONFLICT。
import { requireAuth } from "../../auth.js";

const KEY = "doc_mail.cc";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readList(pool) {
  const r = await pool.query(`SELECT value FROM system_settings WHERE key=$1 LIMIT 1`, [KEY]);
  let a = [];
  if (r.rows[0] && r.rows[0].value) { try { a = JSON.parse(r.rows[0].value); } catch (_e) { a = []; } }
  if (!Array.isArray(a)) a = [];
  // 归一：老的纯字符串项 → 对象（默认业务）
  return a.map((x) => (typeof x === "string"
    ? { email: String(x).trim(), label: "", phone: "", category: "biz", active: true }
    : { email: String(x.email || "").trim(), label: String(x.label || ""), phone: String(x.phone || ""), category: (x.category === "fin" ? "fin" : "biz"), active: x.active !== false, added_at: x.added_at || null, added_by: x.added_by || null }
  )).filter((x) => x.email);
}

async function writeList(pool, arr) {
  await pool.query(`DELETE FROM system_settings WHERE key=$1`, [KEY]);
  await pool.query(`INSERT INTO system_settings(key, value, updated_at) VALUES($1, $2, now())`, [KEY, JSON.stringify(arr)]);
}

async function handleCcList(req, res, pool) {
  if (!requireAuth(req, res)) return; // 未登录 → requireAuth 已回 401

  if (req.method === "GET") {
    const list = await readList(pool);
    return res.json({ ok: true, list });
  }

  const b = req.body || {};
  const action = String(b.action || "");
  const email = String(b.email || "").trim().toLowerCase();
  const category = b.category === "fin" ? "fin" : "biz";
  let list = await readList(pool);

  if (action === "add") {
    if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: "邮箱格式不对" });
    if (list.some((x) => x.email.toLowerCase() === email)) return res.status(409).json({ ok: false, error: "该邮箱已在名单里" });
    list.push({ email, label: String(b.label || "").slice(0, 40), phone: String(b.phone || "").slice(0, 40), category, active: true, added_at: new Date().toISOString(), added_by: (req.user && req.user.username) || null });
    await writeList(pool, list);
    return res.json({ ok: true, list });
  }

  if (action === "remove") {
    const before = list.length;
    list = list.filter((x) => x.email.toLowerCase() !== email);
    if (list.length === before) return res.status(404).json({ ok: false, error: "名单里没找到这个邮箱" });
    await writeList(pool, list);
    return res.json({ ok: true, list });
  }

  if (action === "toggle") { // 启/停某项（不删，暂时不抄送）
    let hit = false;
    list = list.map((x) => { if (x.email.toLowerCase() === email) { hit = true; return { ...x, active: !x.active }; } return x; });
    if (!hit) return res.status(404).json({ ok: false, error: "名单里没找到这个邮箱" });
    await writeList(pool, list);
    return res.json({ ok: true, list });
  }

  return res.status(400).json({ ok: false, error: "unknown action" });
}

export { handleCcList };
export default { handleCcList };
