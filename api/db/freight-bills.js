import { getPool, setCors } from "../db.js";
import { actor, bad, requireFinance } from "./bill-center-auth.js";

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function text(v) {
  const out = clean(v);
  return out || null;
}

function idsOf(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map(clean).filter(Boolean))];
}

function uuidList(value) {
  const ids = idsOf(value);
  return ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    ? ids
    : null;
}

function normalizeDirection(v) {
  const s = clean(v).toUpperCase();
  if (s === "AR" || s === "RECEIVABLE") return "AR";
  if (s === "AP" || s === "PAYABLE") return "AP";
  return null;
}

function feeAmountExpr(direction) {
  return direction === "AR" ? "COALESCE(sale_amount, 0)" : "COALESCE(amount, 0)";
}

function feeCompanyExpr(direction) {
  return direction === "AR" ? "payer_company_code" : "supplier_company_code";
}

function feeDirectionOk(row, direction) {
  const value = clean(row.direction).toLowerCase();
  if (!value) return false;
  if (direction === "AR") return value === "receivable" || value === "ar";
  return value === "payable" || value === "ap";
}

function mismatch(rows, field, label = field) {
  const uniq = [...new Set(rows.map(r => clean(r[field]) || "(空)"))];
  if (uniq.length <= 1) return null;
  return {
    field: label,
    values: uniq,
    rows: rows.map(r => ({
      fee_id: r.id,
      bl_no: r.bl_no,
      cost_category: r.cost_category,
      value: clean(r[field]) || "(空)",
    })),
  };
}

async function nextBillNo(client, billDate) {
  const ymd = clean(billDate || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  const prefix = `BI${ymd}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`freight_bills.bill_no.${ymd}`]);
  const q = await client.query(
    `SELECT bill_no
       FROM freight_bills
      WHERE bill_no LIKE $1
      ORDER BY bill_no DESC
      LIMIT 1`,
    [`${prefix}%`]
  );
  const last = q.rows[0]?.bill_no || "";
  const seq = String((Number(last.slice(prefix.length)) || 0) + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}

async function getDetail(pool, idOrNo) {
  const q = await pool.query(
    `SELECT *
       FROM freight_bills
      WHERE id::text = $1 OR bill_no = $1
      LIMIT 1`,
    [idOrNo]
  );
  const bill = q.rows[0];
  if (!bill) return null;
  const items = await pool.query(
    `SELECT i.id, i.bill_id, i.fee_id, i.amount,
            f.bl_no, f.cost_category, f.currency, f.amount AS fee_cost_amount,
            f.sale_amount AS fee_sale_amount, f.supplier, f.supplier_company_code,
            f.payer_company_code, s.derived_fee_status
       FROM freight_bill_items i
       JOIN freight_supplier_bills f ON f.id = i.fee_id
       LEFT JOIN v_freight_bill_fee_status s ON s.fee_id = i.fee_id AND s.bill_id = i.bill_id
      WHERE i.bill_id = $1
      ORDER BY i.id`,
    [bill.id]
  );
  return { ...bill, items: items.rows };
}

async function listBills(req, res) {
  if (!requireFinance(req, res)) return;
  const pool = getPool();
  const id = text(req.query.id || req.query.bill_no);
  if (id) {
    const detail = await getDetail(pool, id);
    if (!detail) return bad(res, 404, "not_found", "freight bill not found");
    return res.status(200).json({ success: true, data: detail });
  }

  const params = [];
  const conds = [];
  const direction = normalizeDirection(req.query.direction);
  if (direction) {
    params.push(direction);
    conds.push(`b.direction = $${params.length}`);
  }
  for (const [key, col] of [["settlement_company_code", "settlement_company_code"], ["status", "status"]]) {
    const v = text(req.query[key]);
    if (!v) continue;
    params.push(v);
    conds.push(`b.${col} = $${params.length}`);
  }
  if (req.query.date_from) {
    params.push(req.query.date_from);
    conds.push(`b.bill_date >= $${params.length}`);
  }
  if (req.query.date_to) {
    params.push(req.query.date_to);
    conds.push(`b.bill_date <= $${params.length}`);
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const total = await pool.query(`SELECT COUNT(*) AS n FROM freight_bills b ${where}`, params);
  params.push(limit, offset);
  const rows = await pool.query(
    `SELECT b.*,
            COUNT(i.id)::int AS item_count
       FROM freight_bills b
       LEFT JOIN freight_bill_items i ON i.bill_id = b.id
      ${where}
      GROUP BY b.id
      ORDER BY b.bill_date DESC, b.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.status(200).json({ success: true, data: rows.rows, total: Number(total.rows[0]?.n || 0), limit, offset });
}

async function createBill(req, res) {
  if (!requireFinance(req, res)) return;
  const body = req.body || {};
  const direction = normalizeDirection(body.direction);
  const feeIds = uuidList(body.fee_ids || body.fee_id);
  if (!direction) return bad(res, 400, "bad_direction", "direction must be AR or AP");
  if (!feeIds || !feeIds.length) return bad(res, 400, "bad_fee_ids", "fee_ids must be non-empty uuid list");

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const amountExpr = feeAmountExpr(direction);
    const companyExpr = feeCompanyExpr(direction);
    const fees = await client.query(
      `SELECT id, bl_no, cost_category, currency, direction,
              ${companyExpr} AS settlement_company_code,
              ${amountExpr} AS bill_amount
         FROM freight_supplier_bills
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [feeIds]
    );
    if (fees.rowCount !== feeIds.length) {
      await client.query("ROLLBACK");
      const found = new Set(fees.rows.map(r => String(r.id)));
      return bad(res, 404, "fee_not_found", `missing fee_id: ${feeIds.filter(id => !found.has(id)).join(", ")}`);
    }

    const mismatches = [
      mismatch(fees.rows, "currency"),
      mismatch(fees.rows, "settlement_company_code"),
    ].filter(Boolean);
    const badDirections = fees.rows.filter(r => !feeDirectionOk(r, direction));
    if (badDirections.length) {
      mismatches.push({
        field: "direction",
        expected: direction,
        values: [...new Set(fees.rows.map(r => clean(r.direction) || "(空)"))],
        rows: badDirections.map(r => ({
          fee_id: r.id,
          bl_no: r.bl_no,
          cost_category: r.cost_category,
          value: clean(r.direction) || "(空)",
        })),
      });
    }
    if (mismatches.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "fee_group_mismatch", message: "selected fees must share direction, currency and settlement company", mismatches });
    }

    const occupied = await client.query(
      `SELECT i.fee_id, b.bill_no
         FROM freight_bill_items i
         JOIN freight_bills b ON b.id = i.bill_id
        WHERE i.fee_id = ANY($1::uuid[])
          AND b.status <> 'void'
        FOR UPDATE OF i`,
      [feeIds]
    );
    if (occupied.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, error: "fee_already_billed", conflicts: occupied.rows });
    }

    const sum = await client.query(
      `SELECT SUM(v.amount)::numeric AS total
         FROM unnest($1::numeric[]) AS v(amount)`,
      [fees.rows.map(r => r.bill_amount)]
    );
    const billDate = text(body.bill_date) || new Date().toISOString().slice(0, 10);
    const billNo = await nextBillNo(client, billDate);
    const bill = await client.query(
      `INSERT INTO freight_bills
        (bill_no, direction, settlement_company_code, invoice_head_code, currency,
         total_amount, bill_date, remarks, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::text,'draft'))
       RETURNING *`,
      [
        billNo, direction, fees.rows[0].settlement_company_code, text(body.invoice_head_code),
        fees.rows[0].currency, sum.rows[0].total, billDate, text(body.remarks), actor(req), text(body.status),
      ]
    );
    for (const fee of fees.rows) {
      await client.query(
        `INSERT INTO freight_bill_items (bill_id, fee_id, amount)
         VALUES ($1,$2,$3)`,
        [bill.rows[0].id, fee.id, fee.bill_amount]
      );
    }
    await client.query("COMMIT");
    return res.status(201).json({ success: true, data: await getDetail(pool, String(bill.rows[0].id)) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(err.status || 500).json({ success: false, error: err.code || "internal_error", message: err.message });
  } finally {
    client.release();
  }
}

async function voidBill(req, res) {
  if (!requireFinance(req, res)) return;
  const id = text(req.body?.id || req.body?.bill_no || req.query.id || req.query.bill_no);
  if (!id) return bad(res, 400, "id_required", "id or bill_no required");
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(`SELECT * FROM freight_bills WHERE id::text = $1 OR bill_no = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return bad(res, 404, "not_found", "freight bill not found");
    }
    const q = await client.query(
      `UPDATE freight_bills
          SET status = 'void',
              remarks = COALESCE($2, remarks),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [cur.rows[0].id, text(req.body?.remarks)]
    );
    await client.query("COMMIT");
    return res.status(200).json({ success: true, data: q.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({ success: false, error: "internal_error", message: err.message });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    if (req.method === "GET") return listBills(req, res);
    if (req.method === "POST" && clean(req.query.action || req.body?.action) === "void") return voidBill(req, res);
    if (req.method === "POST") return createBill(req, res);
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  } catch (err) {
    console.error("[freight-bills]", err);
    return res.status(500).json({ success: false, error: "internal_error", message: err.message });
  }
}
