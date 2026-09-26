export const CUSTOMS_PRODUCT_ONE_CTE = `product_one AS (
       SELECT DISTINCT ON (sku)
              sku, hs_code, declaration_name, declaration_elements
       FROM products
       WHERE NULLIF(btrim(sku), '') IS NOT NULL
       ORDER BY sku, active DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
     )`;

export const CUSTOMS_PRODUCT_JOIN_SQL = `LEFT JOIN products p_id ON p_id.id = oli.product_id
       LEFT JOIN product_one p ON oli.product_id IS NULL AND p.sku = oli.sku`;

export const CUSTOMS_HS_EXPR = "NULLIF(btrim(COALESCE(oli.hs_code, p_id.hs_code, p.hs_code, '')), '')";

export const CUSTOMS_DECLARATION_NAME_EXPR =
  "COALESCE(NULLIF(btrim(oli.declaration_name), ''), NULLIF(btrim(p_id.declaration_name), ''), NULLIF(btrim(p.declaration_name), ''), NULLIF(btrim(oli.product_name), ''))";

export const CUSTOMS_DECLARATION_ELEMENTS_EXPR =
  "NULLIF(btrim(COALESCE(p_id.declaration_elements, p.declaration_elements, '')), '')";
