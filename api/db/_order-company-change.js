// Order_no prefix must match company_code numeric suffix.
// Naming convention: order_no = "{customer_num}-{factory}-{seq}", e.g. "37-WP-60" for CN-00037.
// Add `raw.order_no_prefix_exempt: true` to bypass (used for legacy JDY customs declaration numbers).
// Returns { ok: true } or { ok: false, error: string } — caller responds with 400.
export function checkOrderNoPrefix(order_no, company_code, raw) {
  if (raw && raw.order_no_prefix_exempt) return { ok: true };
  if (!order_no || !company_code) return { ok: true }; // partial PATCH — skip when either is missing
  const prefixMatch = String(order_no).match(/^([0-9]{2})-/);
  const ccMatch     = String(company_code).match(/00([0-9]{2})$/);
  if (!prefixMatch || !ccMatch) return { ok: true }; // unconventional format — don't block
  if (prefixMatch[1] !== ccMatch[1]) {
    return {
      ok: false,
      error: "order_no_prefix_mismatch",
      message: `Prefix '${prefixMatch[1]}-' on order_no '${order_no}' does not match company_code '${company_code}'. ` +
               `Either correct the prefix or set raw.order_no_prefix_exempt=true with reason if intentional.`
    };
  }
  return { ok: true };
}

// 同一集团内换下单公司时，订单号前缀闸不该拦（2026-08-14）。
// company_group_items 用 group_id 关联 company_groups.id（该表没有 group_code 列）。
async function sameActiveGroup(pool, companyCodeA, companyCodeB) {
  if (!companyCodeA || !companyCodeB || companyCodeA === companyCodeB) return null;
  const r = await pool.query(
    `SELECT g.group_code
       FROM company_groups g
       JOIN company_group_items ia
         ON ia.group_id = g.id
        AND ia.tenant_code = g.tenant_code
        AND ia.left_at IS NULL
       JOIN company_group_items ib
         ON ib.group_id = g.id
        AND ib.tenant_code = g.tenant_code
        AND ib.left_at IS NULL
      WHERE g.status = 'active'
        AND upper(btrim(ia.company_code)) = upper(btrim($1::text))
        AND upper(btrim(ib.company_code)) = upper(btrim($2::text))
      LIMIT 1`,
    [companyCodeA, companyCodeB]
  );
  return r.rows[0]?.group_code || null;
}

export async function checkOrderNoPrefixGroupAware(pool, order_no, company_code, raw, current_company_code) {
  const chk = checkOrderNoPrefix(order_no, company_code, raw);
  if (chk.ok) return chk;

  const groupCode = await sameActiveGroup(pool, current_company_code, company_code);
  if (groupCode) {
    return {
      ok: true,
      exempt_reason: "same_company_group",
      group_code: groupCode
    };
  }

  return chk;
}

export async function resolveCompanyIdentity(pool, company_code) {
  const r = await pool.query(
    `SELECT id, code, name_en, name_cn
       FROM companies
      WHERE upper(btrim(code)) = upper(btrim($1::text))
        AND active IS DISTINCT FROM false
      ORDER BY id
      LIMIT 1`,
    [company_code]
  );
  return r.rows[0] || null;
}

// 留痕失败绝不能连累主流程：只 warn，不抛。
export async function logGuard(pool, row) {
  try {
    await pool.query(
      `INSERT INTO data_guard_log
         (table_name, row_key, field, old_value, new_value, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        row.table_name,
        row.row_key,
        row.field,
        row.old_value == null ? null : String(row.old_value),
        row.new_value == null ? null : String(row.new_value),
        row.reason
      ]
    );
  } catch (err) {
    console.warn("[data_guard_log] write failed", err.message);
  }
}
