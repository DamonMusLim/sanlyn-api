function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function r2(v) {
  return Math.round(n(v) * 100) / 100;
}

function r5(v) {
  return Math.round(n(v) * 100000) / 100000;
}

function batchNo(v) {
  return String(v || "001").replace(/[^0-9]/g, "").padStart(3, "0").slice(-3);
}

function linkNo(ym, batch, seq) {
  return `${ym}${batchNo(batch)}${String(seq).padStart(8, "0")}`;
}

async function getBatch(pool, input) {
  if (input.id || input.batch_id) {
    const r = await pool.query(`SELECT * FROM rebate_batches WHERE id=$1`, [input.id || input.batch_id]);
    if (!r.rows[0]) throw new Error("batch not found");
    return r.rows[0];
  }
  const ym = String(input.declare_ym || "").replace(/[^0-9]/g, "");
  if (!/^\d{6}$/.test(ym)) throw new Error("declare_ym must be YYYYMM");
  const batch = batchNo(input.declare_batch);
  const r = await pool.query(
    `INSERT INTO rebate_batches(declare_ym,declare_batch,status,updated_at)
     VALUES ($1,$2,'draft',now())
     ON CONFLICT (declare_ym,declare_batch) DO UPDATE SET updated_at=now()
     RETURNING *`,
    [ym, batch]
  );
  return r.rows[0];
}

async function loadRate(pool, line) {
  const r = await pool.query(
    `SELECT hs_code, rebate_rate
       FROM hs_rebate_rates
      WHERE hs_code = $1 OR hs_code = $2
      ORDER BY CASE WHEN hs_code = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [line.hs_code_10, line.hs_code_8]
  );
  return r.rows[0]?.rebate_rate == null ? null : Number(r.rows[0].rebate_rate);
}

async function loadLines(pool, batch, customsNos) {
  if (customsNos?.length) {
    const r = await pool.query(
      `SELECT * FROM rebate_customs_lines
        WHERE customs_no = ANY($1::text[])
        ORDER BY customs_no,item_no`,
      [customsNos]
    );
    return r.rows;
  }
  // Multiple declare_batch runs can share the same declare_ym (period) —
  // e.g. 202607-002 filed first with 1 line, 202607-003 filed later with
  // more. A line already claimed (matched/needs_review) by a DIFFERENT
  // batch must not be swept into this one and double-counted/re-filed.
  const r = await pool.query(
    `SELECT l.* FROM rebate_customs_lines l
      WHERE l.declare_ym=$1
        AND NOT EXISTS (
          SELECT 1 FROM rebate_matching m
           WHERE m.customs_line_id = l.id
             AND m.batch_id <> $2
             AND m.status IN ('matched','needs_review')
        )
      ORDER BY l.customs_no,l.item_no`,
    [batch.declare_ym, batch.id]
  );
  return r.rows;
}

async function invoiceCandidates(pool, customsNo, targetAmount) {
  const r = await pool.query(
    `SELECT invoice_no,seller_name,amount_ex_tax,total_tax,amount_incl_tax,tax_rate,
            customs_nos,contract_nos,issue_date,currency
       FROM finance_invoices_in
      WHERE $1 = ANY(COALESCE(customs_nos,'{}'::varchar[]))`,
    [customsNo]
  );
  const rows = r.rows;
  // Multiple invoices sometimes share the same customs_no tag (data-quality
  // drift, not necessarily related to this one line) — sorting by issue_date
  // can greedily hand this line's whole allocation to an unrelated, wildly
  // oversized invoice while starving the real match. Prefer the invoice
  // whose amount is closest to what this line actually needs; ties broken
  // by issue_date. The needs_review threshold in runRebateMatching still
  // catches genuinely ambiguous cases.
  const target = n(targetAmount);
  rows.sort((a, b) => {
    const da = Math.abs(n(a.amount_ex_tax) - target);
    const db = Math.abs(n(b.amount_ex_tax) - target);
    if (da !== db) return da - db;
    const ta = a.issue_date ? new Date(a.issue_date).getTime() : Infinity;
    const tb = b.issue_date ? new Date(b.issue_date).getTime() : Infinity;
    return ta - tb;
  });
  return rows;
}

async function usedAmount(pool, batchId, invoiceNo) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(alloc_amount),0)::numeric AS used
      FROM rebate_matching
      WHERE batch_id=$1 AND invoice_no=$2 AND status IN ('matched','needs_review')`,
    [batchId, invoiceNo]
  );
  return n(r.rows[0]?.used);
}

export async function runRebateMatching(pool, input = {}) {
  const batch = await getBatch(pool, input);
  const lines = await loadLines(pool, batch, input.customs_nos);
  await pool.query(`DELETE FROM rebate_matching WHERE batch_id=$1`, [batch.id]);
  const missing = [];
  const blocked = [];
  const matched = [];
  const needsReview = [];
  let seq = 1;

  for (const line of lines) {
    const rate = await loadRate(pool, line);
    if (rate == null) {
      blocked.push({ customs_line_id: line.id, customs_no: line.customs_no, item_no: line.item_no, status: "rate_unknown" });
      await pool.query(
        `INSERT INTO rebate_matching(batch_id,link_no,customs_line_id,status,note)
         VALUES ($1,$2,$3,'rate_unknown','退税率缺失，hs_code_10/hs_code_8 均未命中')`,
        [batch.id, linkNo(batch.declare_ym, batch.declare_batch, seq), line.id]
      );
      seq++;
      continue;
    }
    const invoices = await invoiceCandidates(pool, line.customs_no, line.deal_amount_cny);
    if (!invoices.length) {
      missing.push({
        customs_line_id: line.id,
        customs_no: line.customs_no,
        item_no: line.item_no,
        name_cn: line.name_cn,
        deal_amount_cny: line.deal_amount_cny,
      });
      seq++;
      continue;
    }
    let need = n(line.deal_amount_cny);
    const no = linkNo(batch.declare_ym, batch.declare_batch, seq);
    for (const inv of invoices) {
      if (need <= 0) break;
      const remain = Math.max(0, n(inv.amount_ex_tax) - await usedAmount(pool, batch.id, inv.invoice_no));
      if (remain <= 0) continue;
      const alloc = Math.min(need, remain);
      const qty = n(line.legal_qty) && n(line.deal_amount_cny) ? r5(n(line.legal_qty) * alloc / n(line.deal_amount_cny)) : null;
      const rebate = r2(alloc * rate);
      const ratio = n(line.deal_amount_cny) ? n(inv.amount_ex_tax) / n(line.deal_amount_cny) : 0;
      const review = ratio > 2;
      const note = review
        ? `进项票¥${r2(inv.amount_ex_tax)}远超本出口行报关金额¥${r2(line.deal_amount_cny)}(${r2(ratio)}倍)，建议人工核对`
        : (remain > alloc ? "跨单分摊：本票剩余金额继续留给同批其他出口行" : "");
      const status = review ? "needs_review" : "matched";
      await pool.query(
        `INSERT INTO rebate_matching
         (batch_id,link_no,customs_line_id,invoice_no,alloc_amount,alloc_qty,rebate_rate,alloc_rebate,status,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [batch.id, no, line.id, inv.invoice_no, r2(alloc), qty, rate, rebate, status, note]
      );
      const item = { customs_line_id: line.id, invoice_no: inv.invoice_no, alloc_amount: r2(alloc), link_no: no, note };
      if (review) needsReview.push(item);
      else matched.push(item);
      need = r2(need - alloc);
    }
    if (need > 0) {
      missing.push({ customs_line_id: line.id, customs_no: line.customs_no, item_no: line.item_no, short_amount: need });
    }
    seq++;
  }

  return {
    success: true,
    batch,
    summary: { lines: lines.length, matched: matched.length, missing: missing.length, blocked: blocked.length, needs_review: needsReview.length },
    matched,
    missing,
    blocked,
    needs_review: needsReview,
  };
}

export async function previewRebateMatching(pool, batchId) {
  const batch = await getBatch(pool, { id: batchId });
  const r = await pool.query(
    `SELECT l.customs_no,l.item_no,l.name_cn,l.deal_amount_cny,l.usd_fob,l.legal_unit,l.legal_qty,
            m.link_no,m.invoice_no,m.alloc_amount,m.alloc_qty,m.rebate_rate,m.alloc_rebate,m.status,m.note
       FROM rebate_customs_lines l
       LEFT JOIN rebate_matching m ON m.customs_line_id=l.id AND m.batch_id=$2
      WHERE l.declare_ym=$1
      ORDER BY l.customs_no,l.item_no,m.id`,
    [batch.declare_ym, batch.id]
  );
  const rows = r.rows;
  const missing = rows.filter((x) => !x.status).map((x) => ({
    customs_no: x.customs_no, item_no: x.item_no, name_cn: x.name_cn, deal_amount_cny: x.deal_amount_cny,
  }));
  const needsReview = rows.filter((x) => x.status === "needs_review");
  const blocked = rows.filter((x) => x.status && x.status !== "matched" && x.status !== "needs_review");
  return { success: true, batch, rows, shortage: { missing_invoices: missing, needs_review: needsReview, blocked } };
}

export async function handleMatch(req, res, pool, batchId) {
  if (req.method === "GET") return res.json(await previewRebateMatching(pool, batchId || req.query.batch_id));
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  return res.json(await runRebateMatching(pool, { ...(req.body || {}), id: batchId || req.body?.batch_id }));
}
