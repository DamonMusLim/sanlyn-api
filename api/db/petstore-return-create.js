import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireWritable } from "../moduleGate.js";

const MODULE = "inventory";

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function positiveQty(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function json(res, status, data) {
  return res.status(status).json(data);
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) badRequest("明细不能为空");
  return lines.map((line, idx) => {
    const productCode = cleanText(line?.productCode, 80);
    const qtyReturn = positiveQty(line?.qtyReturn);
    if (!productCode) badRequest(`第 ${idx + 1} 行 productCode 不能为空`);
    if (!qtyReturn) badRequest(`第 ${idx + 1} 行 qtyReturn 必须大于 0`);
    return {
      productCode,
      qtyReturn,
      reason: cleanText(line?.reason, 200),
      batchNo: cleanText(line?.batchNo, 120),
    };
  });
}

async function loadSkus(client, lines) {
  const codes = [...new Set(lines.map((line) => line.productCode))];
  const { rows } = await client.query(
    `SELECT product_code, product_name, spec_text
       FROM petstore_skus
      WHERE product_code = ANY($1::text[])`,
    [codes],
  );
  const skuMap = new Map(rows.map((row) => [row.product_code, row]));
  const unknown = codes.filter((code) => !skuMap.has(code));
  if (unknown.length) badRequest(`不认识的商品编码: ${unknown.join(", ")}`);
  return skuMap;
}

async function nextReturnNo(client, storeCode) {
  const dateText = (await client.query("SELECT to_char(CURRENT_DATE, 'YYMMDD') AS d")).rows[0].d;
  const prefix = `TH${storeCode}${dateText}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [prefix]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX((right(return_no, 3))::int), 0) AS max_seq
       FROM petstore_returns
      WHERE return_no LIKE $1 || '___'`,
    [prefix],
  );
  const seq = String(Number(rows[0]?.max_seq || 0) + 1).padStart(3, "0");
  return `${prefix}${seq}`;
}

async function createReturn(req, gate) {
  const storeCode = cleanText(gate?.storeCode, 32);
  if (!storeCode) {
    const err = new Error("门店权限缺失");
    err.statusCode = 403;
    throw err;
  }
  const body = req.body || {};
  const lines = validateLines(body.lines);
  const qtyTotal = lines.reduce((sum, line) => sum + line.qtyReturn, 0);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const skuMap = await loadSkus(client, lines);
    const returnNo = await nextReturnNo(client, storeCode);
    await client.query(
      `INSERT INTO petstore_returns
        (return_no, store_code, warehouse, return_type, kind_count, qty_return,
         amt_return, audit_status, reason, operator, returned_at, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'pending', $7, $8, now(), $9, now())`,
      [
        returnNo,
        storeCode,
        cleanText(body.warehouse, 80),
        cleanText(body.returnType, 80),
        lines.length,
        qtyTotal,
        cleanText(body.reason, 200),
        cleanText(body.operator, 80),
        cleanText(body.notes, 500),
      ],
    );
    for (const line of lines) {
      const sku = skuMap.get(line.productCode);
      await client.query(
        `INSERT INTO petstore_return_lines
          (return_no, product_code, product_name, spec_text, qty_return,
           qty_audited, unit_cost, line_amount, reason, batch_no)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6, $7)`,
        [
          returnNo,
          line.productCode,
          sku.product_name,
          sku.spec_text,
          line.qtyReturn,
          line.reason,
          line.batchNo,
        ],
      );
    }
    await client.query("COMMIT");
    return { ok: true, returnNo, lineCount: lines.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
  if (!requireAuth(req, res)) return;
  const gate = await requireWritable(req, res, MODULE);
  if (!gate) return;
  try {
    return json(res, 200, await createReturn(req, gate));
  } catch (err) {
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "server_error" });
  }
}
