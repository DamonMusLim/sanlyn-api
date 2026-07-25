// api/db/product-insurance-pref.js — 产品级投保偏好 GET/POST。仅内部(admin/finance)。
// 表 product_insurance_pref 记住「某产品+客户上次的承保方/范围/加成」,下单自动带默认。
// 红线:成本/费率(rate/cost/premium)绝不入表、不进对外响应、POST 不透传。markup_pct=对外投保比例,非成本。
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

function json(res, s, p) { return res.status(s).json(p); }
function clean(v, n = 120) { return String(v == null ? "" : v).trim().slice(0, n); }
function isAllowed(req) {
  const role = clean(req.user?.role, 40).toLowerCase();
  return role === "admin" || role === "finance";
}
function actor(user) {
  return clean(user?.username || user?.id || user?.user_id || user?.email || "system", 120);
}
// map a DB row (last_* columns) to the clean external contract; never exposes rate/cost.
function toPref(row, isDefault = false) {
  return {
    product_key: row.product_key,
    customer_id: row.customer_id,
    insurer: row.last_insurer,
    cover: row.last_cover,
    markup_pct: Number(row.last_markup_pct),
    special_cargo: row.last_special_cargo ?? null,
    is_default: isDefault,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
  };
}
function defaultPref(productKey, customerId) {
  return toPref({
    product_key: productKey,
    customer_id: customerId,
    last_insurer: "人保",
    last_cover: "ICC-A",
    last_markup_pct: 110,
    last_special_cargo: null,
    updated_by: null,
    updated_at: null,
  }, true);
}
function parseMarkup(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function queryKeys(req) {
  return {
    productKey: clean(req.query?.product_key, 160),
    customerId: clean(req.query?.customer_id, 160),
  };
}

export async function handleProductInsurancePref(req, res, pool = getPool()) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  if (!isAllowed(req)) return json(res, 403, { success: false, error: "forbidden" });

  try {
    if (req.method === "GET") {
      const { productKey, customerId } = queryKeys(req);
      if (!productKey || !customerId) {
        return json(res, 400, { success: false, error: "product_key_and_customer_id_required" });
      }
      const r = await pool.query(
        `
          SELECT product_key, customer_id, last_insurer, last_cover, last_markup_pct,
                 last_special_cargo, updated_by, updated_at
          FROM product_insurance_pref
          WHERE product_key = $1 AND customer_id = $2
          LIMIT 1
        `,
        [productKey, customerId],
      );
      const pref = r.rows.length ? toPref(r.rows[0], false) : defaultPref(productKey, customerId);
      return json(res, 200, { success: true, preference: pref });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const productKey = clean(body.product_key, 160);
      const customerId = clean(body.customer_id, 160);
      if (!productKey || !customerId) {
        return json(res, 400, { success: false, error: "product_key_and_customer_id_required" });
      }

      const markup = parseMarkup(body.markup_pct);
      if (Number.isNaN(markup) || (markup != null && (markup < 50 || markup > 300))) {
        return json(res, 400, { success: false, error: "invalid_markup_pct" });
      }

      // Explicit whitelist only. Cost/rate/premium fields are intentionally ignored (never persisted).
      const values = [
        productKey,
        customerId,
        clean(body.insurer || "人保", 80),
        clean(body.cover || "ICC-A", 80),
        markup ?? 110,
        body.special_cargo == null ? null : clean(body.special_cargo, 500),
        actor(req.user),
      ];
      const r = await pool.query(
        `
          INSERT INTO product_insurance_pref (
            product_key, customer_id, last_insurer, last_cover, last_markup_pct,
            last_special_cargo, updated_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (product_key, customer_id) DO UPDATE
          SET last_insurer = EXCLUDED.last_insurer,
              last_cover = EXCLUDED.last_cover,
              last_markup_pct = EXCLUDED.last_markup_pct,
              last_special_cargo = EXCLUDED.last_special_cargo,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          RETURNING product_key, customer_id, last_insurer, last_cover, last_markup_pct,
                    last_special_cargo, updated_by, updated_at
        `,
        values,
      );
      return json(res, 200, { success: true, preference: toPref(r.rows[0], false) });
    }

    return json(res, 405, { success: false, error: "method_not_allowed" });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message });
  }
}

export default handleProductInsurancePref;
