import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TABLES = Object.create(null);
TABLES.archive = "petstore_pet_archive";

function textParam(value) {
  const s = String(value ?? "").trim();
  return s ? s : null;
}

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function addTextFilter(where, params, column, value) {
  const s = textParam(value);
  if (!s) return;
  params.push(s);
  where.push(`${column}::text = $${params.length}`);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!requireAuth(req, res)) return;

  const kind = textParam(req.query?.kind) || "archive";
  if (!Object.hasOwn(TABLES, kind)) {
    return res.status(400).json({ ok: false, error: "invalid_kind" });
  }

  const page = intParam(req.query?.page ?? req.query?.pageNum, 1, 1, 100000);
  const pageSize = intParam(req.query?.pageSize ?? req.query?.limit, 20, 1, 500);
  const params = [];
  const where = [];

  addTextFilter(where, params, "source_system", req.query?.source_system);
  addTextFilter(where, params, "source_shop_id", req.query?.source_shop_id);
  addTextFilter(where, params, "sex", req.query?.sex);
  addTextFilter(where, params, "species", req.query?.species);
  addTextFilter(where, params, "is_ligation", req.query?.is_ligation);
  addTextFilter(where, params, "pet_status", req.query?.pet_status);

  const keyword = textParam(req.query?.keyword ?? req.query?.q ?? req.query?.search);
  if (keyword) {
    params.push(`%${keyword}%`);
    where.push(`(
      name::text ILIKE $${params.length}
      OR owner_name::text ILIKE $${params.length}
      OR owner_phone::text ILIKE $${params.length}
      OR medical_card::text ILIKE $${params.length}
      OR breed::text ILIKE $${params.length}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(pageSize);
  const limitParam = params.length;
  params.push((page - 1) * pageSize);
  const offsetParam = params.length;

  const sql = `
    SELECT
      id,
      source_system,
      source_id,
      source_shop_id,
      name,
      sex,
      birthday,
      breed,
      species,
      color,
      weight_kg,
      height_cm,
      is_ligation,
      habit,
      note,
      thumb_url,
      medical_card,
      dog_license,
      pet_status,
      pet_status_text,
      owner_source_id,
      owner_name,
      owner_phone,
      CASE
        WHEN NULLIF(owner_name, '') IS NOT NULL AND NULLIF(owner_phone, '') IS NOT NULL
          THEN owner_name || ' ' || owner_phone
        ELSE COALESCE(NULLIF(owner_name, ''), NULLIF(owner_phone, ''))
      END AS owner_contact,
      vaccine_status,
      vaccine_last_at,
      next_vaccine_at,
      next_rabies_vaccine_at,
      disinfest_status,
      disinfest_last_at,
      disinfest_frequency,
      next_deworming_internal_at,
      next_deworming_external_at,
      CONCAT_WS(
        ' / ',
        CASE WHEN next_vaccine_at IS NOT NULL THEN '疫苗 ' || next_vaccine_at::text END,
        CASE WHEN next_rabies_vaccine_at IS NOT NULL THEN '狂犬 ' || next_rabies_vaccine_at::text END,
        CASE WHEN next_deworming_internal_at IS NOT NULL THEN '内驱 ' || next_deworming_internal_at::text END,
        CASE WHEN next_deworming_external_at IS NOT NULL THEN '外驱 ' || next_deworming_external_at::text END
      ) AS next_pet_care_at,
      imported_at,
      updated_at,
      COUNT(*) OVER()::int AS __total
    FROM ${TABLES[kind]}
    ${whereSql}
    ORDER BY updated_at DESC NULLS LAST, imported_at DESC NULLS LAST, id DESC
    LIMIT $${limitParam}
    OFFSET $${offsetParam}`;

  try {
    const r = await getPool().query(sql, params);
    const total = r.rows[0]?.__total || 0;
    const rows = r.rows.map((row) => {
      const out = { ...row };
      delete out.__total;
      return out;
    });
    return res.status(200).json({ ok: true, rows, total, page, pageSize });
  } catch (e) {
    console.error("[petstore-pet-archive]", e);           // 细节只进服务端日志
    return res.status(500).json({ ok: false, error: "query_failed" });  // ⛔ 不把 e.message 吐给客户端(会漏库结构)
  }
}
