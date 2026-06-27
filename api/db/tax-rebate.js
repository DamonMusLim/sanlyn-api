// api/db/tax-rebate.js
// 退税板块 v3 — finance_rebate_inv_map 支持按品名行录入进项票
// GET /api/db/tax-rebate?list=months          → finance_export_rebates 有数据的月份
// GET /api/db/tax-rebate?year=2026&month=5     → 该月退税明细+汇总（含 declaration_name_invoices）
// PATCH /api/db/tax-rebate { customs_no, declaration_name, invoice_no, invoice_date } → 按品名行录入进项票
// PATCH /api/db/tax-rebate { customs_no, status } → 改退税状态
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const REBATE_STATUSES = ["未退税", "待退税", "已申报", "已退税", "已到账"];

function extractInvoiceFileUrl(attachments) {
  const list = Array.isArray(attachments) ? attachments : attachments ? [attachments] : [];
  for (const x of list) {
    if (!x) continue;
    if (typeof x === "string") return x;
    if (x.oss_url) return x.oss_url;
    if (x.url) return x.url;
  }
  return null;
}

function pushInvoice(map, key, inv) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(inv);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin" && req.user?.role !== "finance") {
    return res.status(403).json({ error: "退税板块仅财务/管理员可见" });
  }
  const pool = getPool();

  try {
    // 自保证列/表存在
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rebate_status TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE finance_export_rebates ADD COLUMN IF NOT EXISTS rebate_lifecycle_status TEXT DEFAULT '未退税'`).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_rebate_inv_map (
        id               SERIAL PRIMARY KEY,
        customs_no       TEXT NOT NULL,
        declaration_name TEXT NOT NULL,
        invoice_no       TEXT NOT NULL,
        invoice_date     DATE,
        factory_name     TEXT,
        amount_incl_tax  NUMERIC(14,2),
        created_at       TIMESTAMPTZ DEFAULT now(),
        updated_at       TIMESTAMPTZ DEFAULT now(),
        UNIQUE (customs_no, declaration_name)
      )
    `).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rim_customs ON finance_rebate_inv_map(customs_no)`).catch(() => {});
    await pool.query(`ALTER TABLE finance_rebate_inv_map ADD COLUMN IF NOT EXISTS qty NUMERIC(12,3)`).catch(() => {});
    await pool.query(`ALTER TABLE finance_rebate_inv_map ADD COLUMN IF NOT EXISTS invoice_goods_name TEXT`).catch(() => {});

    // ── PATCH ──
    if (req.method === "PATCH") {
      const { customs_no, order_no, status, before, invoice_no, invoice_date,
              factory_name, amount_incl_tax, declaration_name, qty, invoice_goods_name } = req.body || {};

      // Mode A: 按品名行录入进项票 {customs_no, declaration_name, invoice_no, [invoice_date]}
      if (customs_no && declaration_name && invoice_no) {
        const ferR = await pool.query(
          `SELECT export_date FROM finance_export_rebates WHERE customs_no=$1`, [customs_no]);
        if (!ferR.rows.length) return res.status(404).json({ error: "找不到报关单: " + customs_no });
        const exportDate = ferR.rows[0].export_date;
        if (exportDate && invoice_date && new Date(invoice_date) > new Date(exportDate)) {
          const edStr = new Date(exportDate).toISOString().slice(0, 10);
          return res.status(400).json({ error: `开票日期 ${invoice_date} 晚于出口日期 ${edStr}，请核查` });
        }
        // UPSERT 进品名行映射表
        const mapR = await pool.query(
          `INSERT INTO finance_rebate_inv_map
             (customs_no, declaration_name, invoice_no, invoice_date, factory_name, amount_incl_tax, qty, invoice_goods_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7::numeric, $8, now(), now())
           ON CONFLICT (customs_no, declaration_name) DO UPDATE SET
             invoice_no         = EXCLUDED.invoice_no,
             invoice_date       = EXCLUDED.invoice_date,
             factory_name       = EXCLUDED.factory_name,
             amount_incl_tax    = EXCLUDED.amount_incl_tax,
             qty                = EXCLUDED.qty,
             invoice_goods_name = EXCLUDED.invoice_goods_name,
             updated_at         = now()
           RETURNING *`,
          [customs_no, declaration_name, invoice_no,
           invoice_date || null, factory_name || null,
           amount_incl_tax ? parseFloat(amount_incl_tax) : null,
           qty ? parseFloat(qty) : null,
           invoice_goods_name || null]);
        // 向后兼容：同时更新 finance_invoices_in + finance_export_rebates.invoice_nos
        await pool.query(
          `INSERT INTO finance_invoices_in (invoice_no, issue_date, customs_nos, seller_name, amount_incl_tax, source, created_at, updated_at)
           SELECT $1, $2::date, ARRAY[$3::varchar], $4, $5, 'manual-entry', now(), now()
           WHERE NOT EXISTS (SELECT 1 FROM finance_invoices_in WHERE invoice_no=$1 AND customs_nos @> ARRAY[$3::varchar])`,
          [invoice_no, invoice_date || null, customs_no, factory_name || null,
           amount_incl_tax ? parseFloat(amount_incl_tax) : null]);
        await pool.query(
          `UPDATE finance_export_rebates
           SET invoice_nos = CASE WHEN COALESCE(invoice_nos,'{}') @> ARRAY[$1::varchar]
                                  THEN invoice_nos
                                  ELSE array_append(COALESCE(invoice_nos,'{}'), $1) END,
               updated_at = now()
           WHERE customs_no = $2`,
          [invoice_no, customs_no]);
        return res.json({ success: true, customs_no, declaration_name, invoice_no, data: mapR.rows[0] });
      }

      // Mode B: 改退税状态 {status, ...}
      if (!REBATE_STATUSES.includes(status)) {
        return res.status(400).json({ error: "合法 status 必填", valid: REBATE_STATUSES });
      }
      // 批量: 出口日期 < before月1号 的全部
      if (before && /^\d{4}-\d{2}$/.test(before)) {
        const [y, m] = before.split("-").map(Number);
        const cutoff = new Date(Date.UTC(y, m - 1, 1)).toISOString();
        const r = await pool.query(
          `UPDATE finance_export_rebates SET rebate_lifecycle_status=$1, updated_at=now()
           WHERE export_date < $2`,
          [status, cutoff]);
        await pool.query(
          `UPDATE orders SET tax_rebate_status=$1, updated_at=now()
           WHERE COALESCE(etd,delivery_date,created_at) < $2 AND status!='cancelled'`,
          [status, cutoff]).catch(() => {});
        return res.json({ success: true, bulk: true, before, status, updated: r.rowCount });
      }
      // 单票: by customs_no (preferred) or order_no (legacy)
      if (customs_no) {
        await pool.query(
          `UPDATE finance_export_rebates SET rebate_lifecycle_status=$1, updated_at=now() WHERE customs_no=$2`,
          [status, customs_no]);
        const ferR = await pool.query(`SELECT contract_no FROM finance_export_rebates WHERE customs_no=$1`, [customs_no]);
        if (ferR.rows[0]?.contract_no) {
          await pool.query(
            `UPDATE orders SET tax_rebate_status=$1, updated_at=now() WHERE contract_no=$2`,
            [status, ferR.rows[0].contract_no]).catch(() => {});
        }
        return res.json({ success: true, customs_no, status });
      }
      if (order_no) {
        await pool.query(`UPDATE orders SET tax_rebate_status=$1, updated_at=now() WHERE order_no=$2`, [status, order_no]);
        return res.json({ success: true, order_no, status });
      }
      return res.status(400).json({ error: "customs_no 或 order_no 必填" });
    }

    // ── GET list=months ──
    if (req.query.list === "months") {
      const r = await pool.query(`
        SELECT DISTINCT to_char(export_date, 'YYYY-MM') AS ym
        FROM finance_export_rebates
        WHERE export_date IS NOT NULL
        ORDER BY ym DESC LIMIT 36`);
      return res.json({ success: true, months: r.rows.map(x => x.ym).filter(Boolean) });
    }

    // ── GET list=status ──
    if (req.query.list === "status") {
      const r = await pool.query(`
        SELECT to_char(export_date,'YYYY-MM') AS period,
               COUNT(*) AS total,
               COUNT(NULLIF(array_length(invoice_nos,1),0)) AS invoiced
        FROM finance_export_rebates
        GROUP BY period ORDER BY period DESC LIMIT 24`).catch(() => ({ rows: [] }));
      return res.json({ success: true, status: r.rows.map(x => ({
        period: x.period, invoices: +x.total, matched: +x.invoiced,
        orders_matched: +x.invoiced, done: +x.invoiced > 0,
      }))});
    }

    // ── GET 月度明细 ──
    const isAll = req.query.all === "1" || req.query.month === "all";
    const now = new Date();
    const year = parseInt(req.query.year || now.getFullYear(), 10);
    const month = parseInt(req.query.month || now.getMonth() + 1, 10);
    let start, end, label;
    if (!isAll) {
      if (month < 1 || month > 12) return res.status(400).json({ error: "month 1-12" });
      start = new Date(Date.UTC(year, month - 1, 1));
      end = new Date(Date.UTC(year, month, 1));
      label = `${year}-${String(month).padStart(2, "0")}`;
    } else {
      label = "全部";
    }

    // 主查询: WITH base AS (...) + LEFT JOIN LATERAL declaration_name_invoices
    const BASE_COLS = `
      fer.id, fer.customs_no, fer.export_date, fer.fob_foreign, fer.fob_cny, fer.raw,
      fer.rebate_rate, fer.rebate_expected, fer.invoice_nos,
      COALESCE(fer.rebate_lifecycle_status, '未退税') AS rebate_lifecycle_status,
      fer.note, fer.contract_no,
      STRING_AGG(DISTINCT o.order_no, ', ') AS order_nos,
      STRING_AGG(DISTINCT COALESCE(o.company_name_en, o.customer), ', ')
        FILTER (WHERE COALESCE(o.company_name_en, o.customer) IS NOT NULL) AS customers,
      STRING_AGG(DISTINCT oli.declaration_name, '、')
        FILTER (WHERE oli.declaration_name IS NOT NULL) AS declaration_names,
      STRING_AGG(DISTINCT COALESCE(comp.name_cn, comp_o.name_cn, p.factory_code, o.factory_code), ' / ')
        FILTER (WHERE COALESCE(comp.name_cn, comp_o.name_cn, p.factory_code, o.factory_code) IS NOT NULL) AS factory_names`;
    const BASE_FROM = `
      FROM finance_export_rebates fer
      LEFT JOIN orders o ON o.contract_no = fer.contract_no AND o.status != 'cancelled'
      LEFT JOIN order_line_items oli ON oli.order_id = o.id
      LEFT JOIN products p ON p.id = oli.product_id
      LEFT JOIN companies comp ON comp.code = p.factory_code
      LEFT JOIN companies comp_o ON comp_o.code = o.factory_code`;
    const BASE_GROUP = `
      GROUP BY fer.id, fer.customs_no, fer.export_date, fer.fob_foreign, fer.fob_cny, fer.raw,
               fer.rebate_rate, fer.rebate_expected, fer.invoice_nos,
               fer.rebate_lifecycle_status, fer.note, fer.contract_no`;
    const LATERAL = `
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'declaration_name',   x.declaration_name,
            'invoice_no',         x.invoice_no,
            'invoice_date',       to_char(x.invoice_date, 'YYYY-MM-DD'),
            'factory_name',       x.factory_name,
            'amount_incl_tax',    x.amount_incl_tax,
            'qty',                x.qty,
            'invoice_goods_name', x.invoice_goods_name
          ) ORDER BY x.declaration_name
        ) AS declaration_name_invoices
        FROM finance_rebate_inv_map x
        WHERE x.customs_no = base.customs_no
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'declaration_name',  d.dn,
            'qty',               d.qty,
            'unit',              d.unit,
            'qty2',              d.qty2,
            'unit2',             d.unit2,
            'net_weight_kg',     d.nw,
            'amount_usd',        d.amt_usd,
            'declaration_amount',d.decl_amount,
            'declaration_currency', d.decl_cur,
            'factory_name',      d.factory_name,
            'factory_subtotal',  d.factory_subtotal,
            'factory_price',     d.factory_price,
            'from_customs',      d.from_customs
          ) ORDER BY d.dn
        ) AS declaration_name_details
        FROM (
          SELECT
            oli_sub.dn,
            COALESCE(NULLIF(ci.qty1,'')::numeric, oli_sub.qty)              AS qty,
            COALESCE(NULLIF(ci.unit1,''), oli_sub.unit)                    AS unit,
            NULLIF(ci.qty2,'')::numeric                                    AS qty2,
            NULLIF(ci.unit2,'')                                            AS unit2,
            COALESCE(CASE WHEN ci.name_cn IS NOT NULL THEN NULLIF(base.raw->>'net_weight_kg','')::numeric END, oli_sub.nw) AS nw,
            oli_sub.amt_usd                                                AS amt_usd,
            NULLIF(ci.amount,'')::numeric                                  AS decl_amount,
            COALESCE(NULLIF(ci.currency,''), NULLIF(base.raw->>'total_currency',''), 'CNY') AS decl_cur,
            oli_sub.factory_name, oli_sub.factory_subtotal, oli_sub.factory_price,
            (ci.name_cn IS NOT NULL)                                       AS from_customs
          FROM (
            SELECT
              oli2.declaration_name                            AS dn,
              SUM(oli2.qty_ctn)::numeric                       AS qty,
              MAX(oli2.unit)                                   AS unit,
              SUM(COALESCE(oli2.nw_ctn,0) * COALESCE(oli2.qty_ctn,0))::numeric AS nw,
              SUM(COALESCE(oli2.declare_amount_per_box, oli2.unit_price, 0) * COALESCE(oli2.qty_ctn,0))::numeric AS amt_usd,
              SUM(COALESCE(oli2.factory_subtotal, 0))::numeric  AS factory_subtotal,
              COALESCE(AVG(NULLIF(oli2.factory_price, 0)), 0)::numeric AS factory_price,
              MAX(COALESCE(comp2.name_cn, comp_o2.name_cn, p2.factory_code, o2.factory_code))    AS factory_name
            FROM orders o2
            JOIN order_line_items oli2 ON oli2.order_id = o2.id
            LEFT JOIN products p2 ON p2.id = oli2.product_id
            LEFT JOIN companies comp2 ON comp2.code = p2.factory_code
            LEFT JOIN companies comp_o2 ON comp_o2.code = o2.factory_code
            WHERE o2.contract_no = base.contract_no
              AND o2.status != 'cancelled'
              AND oli2.declaration_name IS NOT NULL
              AND oli2.declaration_name != ''
            GROUP BY oli2.declaration_name
          ) oli_sub
          LEFT JOIN LATERAL (
            SELECT * FROM jsonb_to_recordset(COALESCE(base.raw->'items','[]'::jsonb))
              AS x(name_cn text, qty1 text, unit1 text, qty2 text, unit2 text, amount text, currency text)
            WHERE x.name_cn ILIKE '%'||oli_sub.dn||'%' OR oli_sub.dn ILIKE '%'||x.name_cn||'%'
            LIMIT 1
          ) ci ON true
        ) d
      ) dn_det ON true`;

    const ferR = isAll
      ? await pool.query(`
          WITH base AS (SELECT ${BASE_COLS} ${BASE_FROM} ${BASE_GROUP})
          SELECT base.*,
            COALESCE(m.declaration_name_invoices, '[]'::json) AS declaration_name_invoices,
            COALESCE(dn_det.declaration_name_details, '[]'::json) AS declaration_name_details
          FROM base ${LATERAL}
          ORDER BY base.export_date DESC NULLS LAST`)
      : await pool.query(`
          WITH base AS (SELECT ${BASE_COLS} ${BASE_FROM}
            WHERE fer.export_date >= $1 AND fer.export_date < $2
            ${BASE_GROUP})
          SELECT base.*,
            COALESCE(m.declaration_name_invoices, '[]'::json) AS declaration_name_invoices,
            COALESCE(dn_det.declaration_name_details, '[]'::json) AS declaration_name_details
          FROM base ${LATERAL}
          ORDER BY base.export_date DESC`,
          [start.toISOString(), end.toISOString()]);

    const ferRows = ferR.rows;
    if (!ferRows.length) {
      return res.json({ success: true, period: label, generated_at: new Date().toISOString(),
        summary: { total_orders: 0, est_rebate: 0, materials_ok: 0, materials_missing: 0 },
        orders: [] });
    }

    // 资料齐否
    const allOrderNos = [...new Set(ferRows.flatMap(r =>
      (r.order_nos || "").split(", ").map(s => s.trim()).filter(Boolean)))];
    let declByOrder = {};
    if (allOrderNos.length) {
      const phs = allOrderNos.map((_, i) => `$${i + 1}`).join(",");
      const dR = await pool.query(
        `SELECT doc_id, name FROM document_uploads WHERE doc_id IN (${phs}) AND doc_type='customs_decl' ORDER BY uploaded_at DESC`,
        allOrderNos).catch(() => ({ rows: [] }));
      for (const d of dR.rows) {
        if (!declByOrder[d.doc_id]) declByOrder[d.doc_id] = { name: d.name };
      }
    }

    // 进项票勾稽 (向后兼容，仍检 finance_invoices_in)
    const invByCustoms = new Set(), invByContract = new Set();
    const inputInvByCustoms = new Map(), inputInvByContract = new Map();
    const allCustomsNos = [...new Set(ferRows.map(r => r.customs_no).filter(Boolean))];
    const allContracts = [...new Set(ferRows.flatMap(r => String(r.contract_no || "").split(/[\/,，;；\s]+/).filter(Boolean)))];
    if (allCustomsNos.length) {
      const icR = await pool.query(
        `SELECT DISTINCT unnest(customs_nos) AS k FROM finance_invoices_in WHERE customs_nos && $1::varchar[]`,
        [allCustomsNos]).catch(() => ({ rows: [] }));
      for (const x of icR.rows) invByCustoms.add(x.k);
    }
    if (allContracts.length) {
      const ccR = await pool.query(
        `SELECT DISTINCT unnest(contract_nos) AS k FROM finance_invoices_in WHERE contract_nos && $1::varchar[]`,
        [allContracts]).catch(() => ({ rows: [] }));
      for (const x of ccR.rows) invByContract.add(x.k);
    }
    if (allCustomsNos.length || allContracts.length) {
      const inputInvR = await pool.query(
        `SELECT id, invoice_no, seller_name, amount_incl_tax, attachments, customs_nos, contract_nos
           FROM finance_invoices_in
          WHERE ($1::varchar[] <> '{}'::varchar[] AND customs_nos && $1::varchar[])
             OR ($2::varchar[] <> '{}'::varchar[] AND contract_nos && $2::varchar[])`,
        [allCustomsNos, allContracts]
      ).catch(() => ({ rows: [] }));
      for (const inv of inputInvR.rows) {
        const item = {
          id: inv.id,
          invoice_no: inv.invoice_no,
          seller_name: inv.seller_name,
          amount_incl_tax: inv.amount_incl_tax,
          file_url: extractInvoiceFileUrl(inv.attachments),
        };
        for (const k of Array.isArray(inv.customs_nos) ? inv.customs_nos : []) pushInvoice(inputInvByCustoms, k, item);
        for (const k of Array.isArray(inv.contract_nos) ? inv.contract_nos : []) pushInvoice(inputInvByContract, k, item);
      }
    }

    let sumRebate = 0, okCount = 0, missCount = 0, invOkCount = 0;
    const rows = ferRows.map(r => {
      const invoiceNos = Array.isArray(r.invoice_nos) ? r.invoice_nos : [];
      const invoiceStatus = invoiceNos.length > 0 ? "已开票" : "未开票";
      const rebate = parseFloat(r.rebate_expected || 0) || 0;
      sumRebate += rebate;
      const linkedOrders = (r.order_nos || "").split(", ").map(s => s.trim()).filter(Boolean);
      const matchedOrder = linkedOrders.find(ono => declByOrder[ono]);
      const hasDecl = !!(matchedOrder || r.customs_no);
      if (hasDecl) okCount++; else missCount++;
      const noteParts = (r.note || "").split("|");
      const notePort = noteParts[0] || "";
      const noteHint = (noteParts[1] || "").trim();
      const looksLikeCompany = noteHint && /[A-Za-z一-龥]{3,}/.test(noteHint) && !/^\d{2}-\d{2}批$/.test(noteHint);
      const customerDisplay = r.customers || (looksLikeCompany ? noteHint : "—");
      const ferContracts = String(r.contract_no || "").split(/[\/,，;；\s]+/).filter(Boolean);
      const inputInvoices = [];
      const seenInputInvoices = new Set();
      const addInputInvoices = (list = []) => {
        for (const inv of list) {
          const key = inv.id || inv.invoice_no;
          if (key && seenInputInvoices.has(key)) continue;
          if (key) seenInputInvoices.add(key);
          inputInvoices.push({
            invoice_no: inv.invoice_no,
            seller_name: inv.seller_name,
            amount_incl_tax: inv.amount_incl_tax,
            file_url: inv.file_url || null,
          });
        }
      };
      addInputInvoices(inputInvByCustoms.get(r.customs_no));
      for (const c of ferContracts) addInputInvoices(inputInvByContract.get(c));
      const hasInputInv = inputInvoices.length > 0 || invByCustoms.has(r.customs_no) || ferContracts.some(c => invByContract.has(c));
      if (hasInputInv) invOkCount++;
      return {
        customs_no: r.customs_no,
        order_nos: r.order_nos || "—",
        customers: customerDisplay,
        port: notePort,
        export_date: r.export_date,
        month: r.export_date ? new Date(r.export_date).toISOString().slice(0, 7) : "—",
        fob_foreign: parseFloat(r.fob_foreign || 0),
        est_rebate: rebate,
        declaration_names: r.declaration_names || "—",
        invoice_status: invoiceStatus,
        invoice_nos: invoiceNos,
        materials_ok: hasDecl,
        input_invoice_ok: hasInputInv,
        input_invoices: inputInvoices,
        doc_ref: matchedOrder ? {
          order_no: matchedOrder,
          name: declByOrder[matchedOrder]?.name || "",
        } : null,
        factory_names: r.factory_names || "—",
        rebate_status: r.rebate_lifecycle_status || "未退税",
        note: r.note || "",
        declaration_name_invoices: Array.isArray(r.declaration_name_invoices) ? r.declaration_name_invoices : [],
        declaration_name_details: Array.isArray(r.declaration_name_details) ? r.declaration_name_details : [],
      };
    });

    return res.json({
      success: true, period: label, generated_at: new Date().toISOString(),
      summary: {
        total_orders: rows.length,
        est_rebate: Math.round(sumRebate * 100) / 100,
        materials_ok: okCount,
        materials_missing: missCount,
        input_inv_ok: invOkCount,
        input_inv_missing: rows.length - invOkCount,
        note: "预估退税=税局接收金额×退税率。精确额待进项票匹配(P2)。",
      },
      orders: rows,
    });
  } catch (e) {
    console.error("[tax-rebate]", e.message);
    return res.status(500).json({ error: "internal: " + e.message });
  }
}
