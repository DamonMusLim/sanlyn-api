// api/db/invoice-orphan-match.js
// 用途：进项孤票配对建议、人工确认绑定、已绑定票自动核对。
// mount建议：mount("/api/db/invoice-orphan-match", () => import("./invoice-orphan-match.js"));
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const OK_ROLES = new Set(["admin", "finance"]);
let schemaCache = null;
const COMBO_MAX_UNMATCHED = 300;
const COMBO_POOL_LIMIT = 25;
const COMBO_MAX_PER_INVOICE = 5;

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function requireFinance(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!OK_ROLES.has(req.user?.role)) {
    res.status(403).json({ error: "Forbidden", message: "仅财务/管理员可见" });
    return false;
  }
  return true;
}

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function cleanArray(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,\s，;；]+/);
  return [...new Set(arr.map(clean).filter(Boolean))];
}

function parseContractNos(v) {
  if (Array.isArray(v)) return cleanArray(v);
  if (v == null) return [];
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "[]" || s === "{}") return [];
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return cleanArray(j);
    } catch {}
    return cleanArray(s.replace(/[{}[\]"]/g, ""));
  }
  return [];
}

function isEmptyContracts(v) {
  return parseContractNos(v).length === 0;
}

function sameSeller(inv, due) {
  const codeOk = clean(inv.seller_company_code) && clean(inv.seller_company_code) === clean(due.factory_code);
  const nameOk = clean(inv.seller_name) && clean(inv.seller_name) === clean(due.factory);
  return !!(codeOk || nameOk);
}

function userName(req) {
  return clean(req.user?.username || req.user?.name || req.user?.uid || req.user?.id || req.user?.account || "unknown");
}

async function loadSchema(pool) {
  if (schemaCache) return schemaCache;
  const r = await pool.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = ANY (current_schemas(false))
        AND table_name = 'finance_invoices_in'`
  );
  const cols = new Map(r.rows.map((x) => [x.column_name, x]));
  const c = cols.get("contract_nos") || {};
  let kind = "text";
  if (c.data_type === "ARRAY" || String(c.udt_name || "").startsWith("_")) kind = "array";
  if (c.data_type === "jsonb" || c.udt_name === "jsonb") kind = "jsonb";
  const arrayCast = c.udt_name === "_varchar" ? "varchar[]" : "text[]";
  schemaCache = { cols, contractKind: kind, arrayCast };
  return schemaCache;
}

function emptyContractsSql(schema, alias = "fii") {
  if (schema.contractKind === "array") return `(${alias}.contract_nos IS NULL OR cardinality(${alias}.contract_nos) = 0)`;
  if (schema.contractKind === "jsonb") return `(${alias}.contract_nos IS NULL OR ${alias}.contract_nos = '[]'::jsonb)`;
  return `(${alias}.contract_nos IS NULL OR btrim(${alias}.contract_nos::text) IN ('', '[]', '{}'))`;
}

function nonEmptyContractsSql(schema, alias = "fii") {
  if (schema.contractKind === "array") return `(${alias}.contract_nos IS NOT NULL AND cardinality(${alias}.contract_nos) > 0)`;
  if (schema.contractKind === "jsonb") return `(${alias}.contract_nos IS NOT NULL AND ${alias}.contract_nos <> '[]'::jsonb)`;
  return `(${alias}.contract_nos IS NOT NULL AND btrim(${alias}.contract_nos::text) NOT IN ('', '[]', '{}'))`;
}

function bindValueAndSql(schema, contractNos) {
  if (schema.contractKind === "array") return { value: contractNos, sql: `$2::${schema.arrayCast}` };
  if (schema.contractKind === "jsonb") return { value: JSON.stringify(contractNos), sql: "$2::jsonb" };
  return { value: contractNos.join(","), sql: "$2" };
}

function voidWhere(schema, alias = "fii") {
  // 实测 void_status 存状态值('normal'=有效,全库454张都是normal),NULL反而是老数据——排除的是明确作废的
  return schema.cols.has("void_status") ? ` AND COALESCE(${alias}.void_status, 'normal') NOT IN ('void', 'voided', '作废', 'red', 'cancelled')` : "";
}

async function fetchDue(pool) {
  const r = await pool.query(
    `SELECT o.contract_no, o.factory, o.factory_code,
            SUM(COALESCE(oli.factory_subtotal, 0)) AS due
       FROM orders o
       JOIN order_line_items oli ON oli.order_id = o.id
      WHERE COALESCE(o.status, '') <> 'cancelled'
      GROUP BY 1, 2, 3`
  );
  return r.rows.map((x) => ({ ...x, due: Number(x.due) || 0 }));
}

function candidateFor(inv, due) {
  if (!sameSeller(inv, due)) return null;
  const amt = Number(inv.amount_incl_tax);
  if (!Number.isFinite(amt)) return null;
  const diff = Math.abs(amt - Number(due.due || 0));
  let confidence = null;
  if (diff <= 1) confidence = "high";
  else if (Math.abs(Number(due.due || 0)) > 0 && diff <= Math.abs(Number(due.due)) * 0.01) confidence = "medium";
  if (!confidence) return null;
  return {
    contract_no: due.contract_no,
    factory: due.factory,
    due: money(due.due),
    diff: money(diff),
    confidence,
  };
}

function comboCandidateFor(inv, combo) {
  const amt = Number(inv.amount_incl_tax);
  if (!Number.isFinite(amt)) return null;
  const total = combo.reduce((s, d) => s + (Number(d.due) || 0), 0);
  const diff = Math.abs(amt - total);
  let confidence = null;
  if (diff <= 1) confidence = "high";
  else if (Math.abs(amt) > 0 && diff <= Math.abs(amt) * 0.005) confidence = "medium";
  if (!confidence) return null;
  return {
    contract_no: combo.map((d) => d.contract_no).join("+"),
    factory: combo[0]?.factory || "",
    due: money(total),
    diff: money(diff),
    confidence,
    combo: combo.map((d) => ({
      contract_no: d.contract_no,
      factory: d.factory,
      due: money(d.due),
    })),
  };
}

function comboCandidatesFor(inv, dues) {
  const amt = Number(inv.amount_incl_tax);
  if (!Number.isFinite(amt)) return [];
  let pool = dues.filter((d) => sameSeller(inv, d) && clean(d.contract_no) && Number.isFinite(Number(d.due)));
  if (pool.length > COMBO_POOL_LIMIT) {
    pool = pool
      .slice()
      .sort((a, b) => {
        const sa = Math.min(Math.abs(Number(a.due) - amt / 2), Math.abs(Number(a.due) - amt / 3));
        const sb = Math.min(Math.abs(Number(b.due) - amt / 2), Math.abs(Number(b.due) - amt / 3));
        return sa - sb;
      })
      .slice(0, COMBO_POOL_LIMIT);
  }
  const out = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const cand = comboCandidateFor(inv, [pool[i], pool[j]]);
      if (cand) out.push(cand);
    }
  }
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      for (let k = j + 1; k < pool.length; k += 1) {
        const cand = comboCandidateFor(inv, [pool[i], pool[j], pool[k]]);
        if (cand) out.push(cand);
      }
    }
  }
  return out
    .sort((a, b) => Number(a.diff) - Number(b.diff))
    .slice(0, COMBO_MAX_PER_INVOICE);
}

async function handleSuggestions(req, res) {
  const pool = getPool();
  const schema = await loadSchema(pool);
  const invR = await pool.query(
    `SELECT id, invoice_no, seller_name, seller_company_code, amount_incl_tax,
            to_char(issue_date, 'YYYY-MM-DD') AS issue_date
       FROM finance_invoices_in fii
      WHERE ${emptyContractsSql(schema, "fii")}${voidWhere(schema, "fii")}
      ORDER BY issue_date DESC NULLS LAST, id DESC`
  );
  const dues = await fetchDue(pool);
  const suggestions = [];
  const unmatched = [];
  let comboChecked = 0;
  let comboCount = 0;
  let truncated = false;
  for (const inv of invR.rows) {
    let candidates = dues.map((d) => candidateFor(inv, d)).filter(Boolean)
      .sort((a, b) => Number(a.diff) - Number(b.diff));
    if (candidates.length === 0 && comboChecked < COMBO_MAX_UNMATCHED) {
      comboChecked += 1;
      candidates = comboCandidatesFor(inv, dues);
      if (candidates.length) comboCount += 1;
    } else if (candidates.length === 0) {
      truncated = true;
    }
    const row = {
      invoice_id: inv.id,
      invoice_no: inv.invoice_no,
      seller_name: inv.seller_name,
      amount_incl_tax: money(inv.amount_incl_tax),
      issue_date: inv.issue_date,
      candidates,
    };
    if (candidates.length) suggestions.push(row);
    else unmatched.push({
      invoice_id: inv.id,
      invoice_no: inv.invoice_no,
      seller_name: inv.seller_name,
      amount_incl_tax: money(inv.amount_incl_tax),
      issue_date: inv.issue_date,
    });
  }
  return res.json({ suggestions, orphan_total: invR.rows.length, unmatched, combo_count: comboCount, truncated });
}

async function handleBind(req, res) {
  const body = req.body || {};
  const invoiceId = Number(body.invoice_id);
  const contractNos = cleanArray(body.contract_nos);
  if (!invoiceId || contractNos.length === 0) return json(res, 400, { error: "invoice_id/contract_nos invalid" });
  const pool = getPool();
  const schema = await loadSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invR = await client.query(`SELECT id, contract_nos FROM finance_invoices_in WHERE id=$1 FOR UPDATE`, [invoiceId]);
    const inv = invR.rows[0];
    if (!inv) {
      await client.query("ROLLBACK");
      return json(res, 404, { error: "invoice not found" });
    }
    if (!isEmptyContracts(inv.contract_nos)) {
      await client.query("ROLLBACK");
      return json(res, 409, { error: "invoice already bound" });
    }

    const exists = await client.query(
      `SELECT contract_no FROM orders WHERE contract_no = ANY($1::text[])`,
      [contractNos]
    );
    const found = new Set(exists.rows.map((x) => clean(x.contract_no)));
    const missing = contractNos.filter((x) => !found.has(x));
    if (missing.length) {
      await client.query("ROLLBACK");
      return json(res, 400, { error: "contract_no not found", missing });
    }

    const bound = bindValueAndSql(schema, contractNos);
    const sets = [`contract_nos=${bound.sql}`];
    const params = [invoiceId, bound.value];
    if (schema.cols.has("remark")) {
      params.push(` [orphan-bind by ${userName(req)} ${new Date().toISOString().slice(0, 10)}]`);
      sets.push(`remark=COALESCE(remark, '') || $${params.length}`);
    }
    if (schema.cols.has("updated_at")) sets.push("updated_at=NOW()");
    await client.query(`UPDATE finance_invoices_in SET ${sets.join(", ")} WHERE id=$1`, params);
    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return json(res, 500, { error: e.message });
  } finally {
    client.release();
  }
}

async function handleReconcile(req, res) {
  const dry = !!(req.body && req.body.dry);
  const pool = getPool();
  const schema = await loadSchema(pool);
  const invR = await pool.query(
    `SELECT id, amount_incl_tax, contract_nos, review_status
       FROM finance_invoices_in fii
      WHERE ${nonEmptyContractsSql(schema, "fii")}${voidWhere(schema, "fii")}
      ORDER BY id`
  );
  const dues = await fetchDue(pool);
  const dueMap = new Map(dues.map((d) => [clean(d.contract_no), Number(d.due) || 0]));
  const stats = { matched: 0, mismatch: 0, skipped: 0 };
  const updates = [];
  for (const inv of invR.rows) {
    const cns = parseContractNos(inv.contract_nos);
    const amt = Number(inv.amount_incl_tax);
    if (!cns.length || !Number.isFinite(amt) || !cns.some((c) => dueMap.has(c))) {
      stats.skipped += 1;
      continue;
    }
    const expected = cns.reduce((s, c) => s + (dueMap.get(c) || 0), 0);
    const status = Math.abs(amt - expected) <= 1 ? "matched" : "mismatch";
    stats[status] += 1;
    if (status === "mismatch" && inv.review_status === "matched") {
      stats.skipped += 1;
      continue;
    }
    if (inv.review_status == null || inv.review_status === "mismatch") updates.push({ id: inv.id, status });
  }
  if (!dry && updates.length) {
    const sets = ["review_status = v.status"];
    if (schema.cols.has("reviewed_at")) sets.push("reviewed_at = NOW()");
    if (schema.cols.has("updated_at")) sets.push("updated_at = NOW()");
    await pool.query(
      `UPDATE finance_invoices_in fii
          SET ${sets.join(", ")}
         FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id int, status text)) v
        WHERE fii.id = v.id`,
      [JSON.stringify(updates)]
    );
  }
  return res.json(stats);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireFinance(req, res)) return;
  try {
    const action = clean(req.query?.action);
    if (req.method === "GET" && action === "suggestions") return handleSuggestions(req, res);
    if (req.method === "POST" && action === "bind") return handleBind(req, res);
    if (req.method === "POST" && action === "reconcile") return handleReconcile(req, res);
    return json(res, 405, { error: "Method/action not allowed" });
  } catch (e) {
    console.error("[invoice-orphan-match]", e);
    return json(res, 500, { error: "Internal server error", detail: e.message });
  }
}

/*
行号说明：
1-3：声明用途和建议挂载行，便于后续在 server.js 接入。
69-84：运行时读取 information_schema，确认 contract_nos 真实列类型。
122-161：单合同候选保持原金额/卖方规则；组合候选输出 combo 明细并按总差额评级。
163-195：组合匹配仅枚举同卖方 2-3 合同，候选池最多 25、每票最多 5，避免组合爆炸。
197-240：GET suggestions 只对无单合同候选的孤票跑组合，总处理上限 300 并返回 combo_count/truncated。
243-292：POST bind，锁行、防覆盖、校验合同存在后人工绑定，继续接收 contract_nos 数组。
294-336：POST reconcile，对已绑定进项票自动核对并保护 matched 不降级。
*/
