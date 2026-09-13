import { getPool, setCors } from "../db.js";

function hasQueryParams(req) {
  if (req.query && Object.keys(req.query).length > 0) return true;
  const rawUrl = req.originalUrl || req.url || "";
  return rawUrl.includes("?");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  }
  if (hasQueryParams(req)) {
    return res.status(400).json({ success: false, error: "query_params_not_allowed" });
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  const { rows } = await getPool().query(`
    SELECT code, name_cn, size_ft, family_cn, is_reefer, is_common
      FROM container_types
     WHERE is_active
     ORDER BY is_common DESC, size_ft NULLS LAST, code`);

  return res.json({ success: true, data: rows });
}
