function safeIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

export async function getColumns(pool, table) {
  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ANY (current_schemas(false))
      AND table_name = $1
  `, [table]);
  return new Set(rows.map((r) => r.column_name));
}

export async function selectJsonByProduct(pool, table, productCode, opts = {}) {
  const cols = await getColumns(pool, table);
  if (!cols.has("product_code")) return [];
  const dateCol = ["ts", "created_at", "captured_at", "effective_at", "log_date", "note_date", "as_of", "change_time", "fetched_at"]
    .find((c) => cols.has(c));
  const orderCol = dateCol || "product_code";
  const where = [`product_code=$1`];
  const params = [productCode];

  if (opts.days && dateCol) {
    params.push(opts.days);
    where.push(`${safeIdent(dateCol)} >= now() - ($${params.length}::int || ' days')::interval`);
  }

  const limit = Number.isFinite(opts.limit) ? opts.limit : 200;
  params.push(limit);

  const { rows } = await pool.query(`
    SELECT to_jsonb(t) AS row
    FROM ${safeIdent(table)} t
    WHERE ${where.join(" AND ")}
    ORDER BY ${safeIdent(orderCol)} DESC NULLS LAST
    LIMIT $${params.length}
  `, params);
  return rows.map((r) => r.row);
}

function chineseExcludeReason(reason) {
  const s = String(reason || "").trim();
  const dict = {
    LOW_MONTHLY_SALES: "月销过低不可比",
    no_barcode: "条码不一致",
    bad_match: "匹配不可靠",
    far_price: "价格偏离太大",
    stale: "报价太旧",
    spec_mismatch: "规格不一致",
    duplicate: "重复报价",
  };
  return dict[s] || s || "未写排除原因";
}

function quoteExcluded(row) {
  return Boolean(row?.exclude_reason || row?.is_soft_excluded === true || row?.is_comparable === false);
}

export function splitQuotesByReviewState(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = row?.id == null ? JSON.stringify(row) : String(row.id);
    const prev = byId.get(key);
    if (!prev || (!quoteExcluded(prev) && quoteExcluded(row))) byId.set(key, row);
  }
  const valid = [];
  const excluded = [];
  for (const row of byId.values()) {
    const normalized = {
      ...row,
      market_sold: row.market_sold ?? row.monthly_sales ?? row.sold,
      market_spec: row.market_spec ?? row.spec_text ?? row.spec,
      market_captured_at: row.market_captured_at ?? row.captured_at,
    };
    if (quoteExcluded(row)) {
      excluded.push({ ...normalized, quote_group: "被排除报价", exclude_reason_cn: chineseExcludeReason(row.exclude_reason) });
    } else {
      valid.push({ ...normalized, quote_group: "有效报价" });
    }
  }
  valid.sort((a, b) => Number(a.price ?? a.market_price ?? Infinity) - Number(b.price ?? b.market_price ?? Infinity));
  return { valid, excluded };
}

function presenceStateCn(state) {
  return {
    seen_active: "在售",
    missing_once: "缺失1次",
    missing_since: "连续缺失",
    confirmed_offline: "已下架",
  }[state] || null;
}

function labelListText(value) {
  if (value == null) return "标签未同步";
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return "无标签";
  return value.map((v) => String(v?.labelName || v?.name || v).trim()).filter(Boolean).join(", ") || "无标签";
}

export function decorateRows(rows) {
  return rows.map((row) => ({
    ...row,
    presence_state_cn: presenceStateCn(row.presence_state),
    label_list_text: labelListText(row.label_list),
  }));
}

function actorKind(name) {
  const s = String(name || "").trim();
  if (!s) return "未知";
  return ["聂", "LEO"].includes(s) ? "真人" : "系统动作";
}

export async function productDetailExtras(pool, productCode) {
  const [notes, salesRows, rawRows] = await Promise.all([
    selectJsonByProduct(pool, "petstore_product_notes", productCode, { limit: 200 }),
    selectJsonByProduct(pool, "petstore_sku_sales_dna", productCode, { limit: 5 }),
    selectJsonByProduct(pool, "gdc_product_profile_raw", productCode, { limit: 5 }),
  ]);

  const operationHistory = [];
  for (const row of rawRows) {
    const p = row.raw_payload || {};
    if (p.createName || p.createTime) operationHistory.push({
      operation_group: "果冻橙建档",
      actor: p.createName || "",
      actor_kind: actorKind(p.createName),
      operated_at: p.createTime || "",
      action: "create",
    });
    if (p.updateName || p.updateTime) operationHistory.push({
      operation_group: "果冻橙更新",
      actor: p.updateName || "",
      actor_kind: actorKind(p.updateName),
      operated_at: p.updateTime || "",
      action: "update",
    });
  }
  for (const row of notes) {
    operationHistory.push({
      ...row,
      operation_group: "我方备注",
      actor: row.author || "",
      actor_kind: row.author ? "真人" : "未知",
      operated_at: row.created_at || "",
      action: "note",
    });
  }

  return {
    notes,
    operation_history: operationHistory.sort((a, b) => String(b.operated_at || "").localeCompare(String(a.operated_at || ""))),
    sales_record: salesRows.map((r) => ({ ...r, sales_group: "销售DNA" })),
  };
}
