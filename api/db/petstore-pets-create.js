// 宠物档案 写口 · 0903。⚠️ 这是【第一个走 moduleGate 的写接口】,后面所有写口照它写。
// 🔴 read_only/suspended 态一律 403 —— 不是靠前端禁按钮,是接口层挡住。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

const clean = (v, m = 120) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;

  // 🔴 就这一行 —— 写口的模块闸。少了它,关掉模块照样能往里塞数据。
  const gate = await requireWritable(req, res, "pet_profile");
  if (!gate) return;

  const b = req.body || {};
  const name = clean(b.name, 40);
  if (!name) return res.status(400).json({ error: "name_required", message: "宠物名必填" });

  const pool = getPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO pet_profiles
         (store_code,pet_code,name,species,breed,gender,birth_date,neutered,
          owner_name,owner_phone,staple_food,coat_note,temperament,remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, name, pet_code`,
      [gate.storeCode, clean(b.petCode, 30), name, clean(b.species, 10), clean(b.breed, 40),
       clean(b.gender, 4), b.birthDate || null,
       typeof b.neutered === "boolean" ? b.neutered : null,
       clean(b.ownerName, 40), clean(b.ownerPhone, 20), clean(b.stapleFood, 60),
       clean(b.coatNote, 200), clean(b.temperament, 200), clean(b.remark, 300)]
    );
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
