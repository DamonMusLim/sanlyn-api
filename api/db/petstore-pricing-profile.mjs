// api/db/petstore-pricing-profile.mjs
function text(value, max = 500) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function moneyOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

const STOCK_REASONS = new Set([
  "PRODUCT_DAMAGE",
  "PRODUCT_LOSE",
  "PRODUCT_EXPIRATION",
  "QUALITY_EXCEPTION",
  "INTERNAL_REQUISITION",
  "PRODUCT_EXPIRED",
  "FILL_SALE",
  "OTHER_REASON",
]);

function profilePatch(body) {
  const patch = {};
  if (hasOwn(body, "shelf_location")) patch.shelf_location = text(body.shelf_location, 120);
  if (hasOwn(body, "expire_date_batch")) patch.expire_date_batch = text(body.expire_date_batch, 80);
  return patch;
}

function profileLabel(key) {
  return key === "shelf_location" ? "货位" : "到期日";
}

function profileChanged(oldValue, newValue) {
  return String(oldValue ?? "").trim() !== String(newValue ?? "").trim();
}

function requestedStock(body) {
  if (!hasOwn(body, "stock_count")) return { requested: false };
  if (body.stock_count === "" || body.stock_count == null) return { requested: false };
  const n = Number(body.stock_count);
  return { requested: true, value: Number.isFinite(n) ? n : NaN };
}

export function validateProfileActions(body) {
  const stock = requestedStock(body);
  if (stock.requested) {
    if (Number.isNaN(stock.value)) return "实盘数量必须是数字";
    if (!STOCK_REASONS.has(String(body.stock_reason || ""))) return "提交实盘数量必须选择盘点原因";
  }
  return "";
}

export async function applyProfileUpdate(pool, body, primaryId, person) {
  const patch = profilePatch(body);
  const keys = Object.keys(patch);
  const wantsDead = body.mark_dead === true;
  const wantsOffShelf = body.off_shelf === true;
  const stock = requestedStock(body);

  if (!keys.length && !wantsDead && !wantsOffShelf && !stock.requested) {
    return { updated: [], snapshot: null, intents: {} };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query(`
      SELECT
        p.product_code,
        p.product_name,
        ps.shelf_location,
        ps.expire_date_batch,
        o.cur_stock
      FROM petstore_price_intents p
      LEFT JOIN petstore_sku_supp ps ON ps.product_code = p.product_code
      LEFT JOIN petstore_ops_row o ON o.product_code = p.product_code
      WHERE p.id = $1`, [primaryId]);

    if (before.rowCount === 0) {
      await client.query("ROLLBACK");
      return { notFound: true, updated: [], snapshot: null, intents: {} };
    }

    const row = before.rows[0];
    const changed = keys.filter((key) => profileChanged(row[key], patch[key]));
    const updatedLabels = changed.map(profileLabel);
    const actions = {};

    if (changed.length) {
      await client.query(`
        INSERT INTO petstore_sku_supp (product_code, shelf_location, expire_date_batch)
        VALUES ($1, $2, $3)
        ON CONFLICT (product_code) DO UPDATE SET
          shelf_location = COALESCE(EXCLUDED.shelf_location, petstore_sku_supp.shelf_location),
          expire_date_batch = COALESCE(EXCLUDED.expire_date_batch, petstore_sku_supp.expire_date_batch)`,
        [row.product_code, hasOwn(patch, "shelf_location") ? patch.shelf_location : null,
          hasOwn(patch, "expire_date_batch") ? patch.expire_date_batch : null]);
    }

    if (wantsDead) {
      await client.query(`
        INSERT INTO petstore_product_status (product_code, marker, note, updated_by_person_id, updated_at)
        VALUES ($1, '死货', $2, $3, now())
        ON CONFLICT (product_code) DO UPDATE SET
          marker = EXCLUDED.marker,
          note = EXCLUDED.note,
          updated_by_person_id = EXCLUDED.updated_by_person_id,
          updated_at = now()`,
        [row.product_code, text(body.note, 500), person.person_id]);
      updatedLabels.push("已标记死货");
      actions.mark_dead = { marker: "死货", status: "applied" };
    }

    if (wantsOffShelf) {
      const existing = await client.query(`
        SELECT id, status
        FROM petstore_shelf_action_intents
        WHERE product_code = $1
          AND status IN ('proposed','approved','applying')
        ORDER BY created_at ASC, id ASC
        LIMIT 1`, [row.product_code]);

      if (existing.rowCount > 0) {
        await client.query("COMMIT");
        return {
          conflict: true,
          status: 409,
          error: `该商品已有未完成下架/上架意图 #${existing.rows[0].id}，不要重复提交`,
          updated: updatedLabels,
          snapshot: {
            product_code: row.product_code,
            decided_by_person_id: person.person_id,
            actions,
          },
          intents: { shelf_action_intent_id: existing.rows[0].id },
        };
      }

      const inserted = await client.query(`
        INSERT INTO petstore_shelf_action_intents
          (product_code, product_name, action, reason, status, requested_by_person_id, created_at)
        VALUES ($1, $2, 'LOWER', $3, 'proposed', $4, now())
        RETURNING id`,
        [row.product_code, row.product_name, text(body.note, 500), person.person_id]);
      updatedLabels.push("已提交下架申请(排队中)");
      actions.off_shelf = { action: "LOWER", status: "proposed", intent_id: inserted.rows[0].id };
    }

    if (stock.requested) {
      const book = moneyOrNull(row.cur_stock);
      const diff = book == null || Number.isNaN(book) ? null : stock.value - book;
      const inserted = await client.query(`
        INSERT INTO petstore_stocktake
          (ymd, store_code, product_code, product_name, book_qty, count_qty, diff,
           reason, status, note, requested_by_person_id, created_at, counted_at)
        VALUES
          (CURRENT_DATE, $1, $2, $3, $4, $5, $6,
           $7, 'pending', $8, $9, now(), now())
        RETURNING id`,
        [text(body.store_code, 80), row.product_code, row.product_name, book, stock.value,
          diff, String(body.stock_reason || ""), text(body.note, 500), person.person_id]);
      updatedLabels.push("已建盘点差异单(待审核)");
      actions.stock_count = {
        status: "pending",
        stocktake_id: inserted.rows[0].id,
        book_qty: book,
        count_qty: stock.value,
        diff,
        reason: String(body.stock_reason || ""),
      };
    }

    await client.query("COMMIT");
    return {
      updated: updatedLabels,
      snapshot: {
        product_code: row.product_code,
        decided_by_person_id: person.person_id,
        before: {
          shelf_location: row.shelf_location,
          expire_date_batch: row.expire_date_batch,
          cur_stock: row.cur_stock,
        },
        after: {
          shelf_location: hasOwn(patch, "shelf_location") ? patch.shelf_location : row.shelf_location,
          expire_date_batch: hasOwn(patch, "expire_date_batch") ? patch.expire_date_batch : row.expire_date_batch,
        },
        updated: updatedLabels,
        actions,
      },
      intents: {
        shelf_action_intent_id: actions.off_shelf?.intent_id || null,
        stocktake_id: actions.stock_count?.stocktake_id || null,
      },
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}
