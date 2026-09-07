// P1 宠物档案列表。⚠️ 受模块开关管:pet_profile 未开通时直接 403,⛔不能只靠前端藏菜单。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PAGE = 20, MAX = 200;
const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };

async function moduleOk(pool, storeCode, code) {
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements
      WHERE store_code=$1 AND module_code=$2`, [storeCode, code]);
  const st = rows[0]?.status || "disabled";
  return { visible: st !== "disabled", writable: st === "enabled", status: st };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;

  const storeCode = clean(req.query?.storeCode, 32) || "63350001";
  const pool = getPool();
  try {
    const gate = await moduleOk(pool, storeCode, "pet_profile");
    if (!gate.visible) {
      // 🔴 后端也要拦。菜单藏了但接口能调 = 没开通的功能白送。
      return res.status(403).json({ error: "module_disabled", module: "pet_profile" });
    }
    const page = Math.max(1, parseInt(req.query?.page || "1", 10) || 1);
    const size = Math.min(MAX, Math.max(1, parseInt(req.query?.pageSize || PAGE, 10) || PAGE));
    const kw = clean(req.query?.q, 40);
    const args = [storeCode];
    let where = "store_code = $1 AND is_active";
    if (kw) { args.push("%" + kw + "%"); where += ` AND (name ILIKE $${args.length} OR owner_phone ILIKE $${args.length} OR pet_code ILIKE $${args.length})`; }
    const total = (await pool.query(`SELECT count(*)::int n FROM pet_profiles WHERE ${where}`, args)).rows[0].n;
    args.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT id, pet_code, name, avatar_url, species, breed, gender, birth_date, neutered,
              owner_name, owner_phone, cert_no, tags, staple_food, coat_note, temperament,
              next_vaccine_at, remark, created_at
         FROM pet_profiles WHERE ${where}
        ORDER BY updated_at DESC, id DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return res.status(200).json({ rows, total, page, pageSize: size, writable: gate.writable });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
