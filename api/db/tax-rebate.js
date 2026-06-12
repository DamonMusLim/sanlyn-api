// api/db/tax-rebate.js
// 退税板块 v2 — 以 finance_export_rebates 为唯一真值(税局接收才可见)
// GET /api/db/tax-rebate?list=months          → finance_export_rebates 有数据的月份
// GET /api/db/tax-rebate?year=2026&month=5     → 该月退税明细+汇总
// PATCH /api/db/tax-rebate { customs_no, status } → 改退税状态
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const REBATE_STATUSES = ["未退税", "待退税", "已申报", "已退税", "已到账"];

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin" && req.user?.role !== "finance") {
    return res.status(403).json({ error: "退税板块仅财务/管理员可见" });
  }
  const pool = getPool();

  try {
    // 自保证列存在
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rebate_status TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE finance_export_rebates ADD COLUMN IF NOT EXISTS rebate_lifecycle_status TEXT DEFAULT '未退税'`).catch(() => {});

    // ── PATCH: 改退税状态 ──
    if (req.method === "PATCH") {
      const { customs_no, order_no, status, before } = req.body || {};
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
        // also update orders
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
        // propagate to linked orders via contract_no
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

    // ── GET list=months: finance_export_rebates 有数据的月份 ──
    if (req.query.list === "months") {
      const r = await pool.query(`
        SELECT DISTINCT to_char(export_date, 'YYYY-MM') AS ym
        FROM finance_export_rebates
        WHERE export_date IS NOT NULL
        ORDER BY ym DESC LIMIT 36`);
      return res.json({ success: true, months: r.rows.map(x => x.ym).filter(Boolean) });
    }

    // ── GET list=status (kept for compat) ──
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

    // ── GET 月度明细 — 以 finance_export_rebates 为驱动表 ──
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

    // 主查询: finance_export_rebates + LEFT JOIN orders/OLI
    const ferR = isAll
      ? await pool.query(`
          SELECT
            fer.id, fer.customs_no, fer.export_date, fer.fob_foreign, fer.fob_cny,
            fer.rebate_rate, fer.rebate_expected, fer.invoice_nos,
            COALESCE(fer.rebate_lifecycle_status, '未退税') AS rebate_lifecycle_status,
            fer.note, fer.contract_no,
            STRING_AGG(DISTINCT o.order_no, ', ') AS order_nos,
            STRING_AGG(DISTINCT COALESCE(o.company_name_en, o.customer), ', ')
              FILTER (WHERE COALESCE(o.company_name_en, o.customer) IS NOT NULL) AS customers,
            STRING_AGG(DISTINCT oli.declaration_name, '、')
              FILTER (WHERE oli.declaration_name IS NOT NULL) AS declaration_names
          FROM finance_export_rebates fer
          LEFT JOIN orders o ON o.contract_no = fer.contract_no AND o.status != 'cancelled'
          LEFT JOIN order_line_items oli ON oli.order_id = o.id
          GROUP BY fer.id, fer.customs_no, fer.export_date, fer.fob_foreign, fer.fob_cny,
                   fer.rebate_rate, fer.rebate_expected, fer.invoice_nos,
                   fer.rebate_lifecycle_status, fer.note, fer.contract_no
          ORDER BY fer.export_date DESC NULLS LAST`)
      : await pool.query(`
          SELECT
            fer.id, fer.customs_no, fer.export_date, fer.fob_foreign, fer.fob_cny,
            fer.rebate_rate, fer.rebate_expected, fer.invoice_nos,
            COALESCE(fer.rebate_lifecycle_status, '未退税') AS rebate_lifecycle_status,
            fer.note, fer.contract_no,
            STRING_AGG(DISTINCT o.order_no, ', ') AS order_nos,
            STRING_AGG(DISTINCT COALESCE(o.company_name_en, o.customer), ', ')
              FILTER (WHERE COALESCE(o.company_name_en, o.customer) IS NOT NULL) AS customers,
            STRING_AGG(DISTINCT oli.declaration_name, '、')
              FILTER (WHERE oli.declaration_name IS NOT NULL) AS declaration_names
          FROM finance_export_rebates fer
          LEFT JOIN orders o ON o.contract_no = fer.contract_no AND o.status != 'cancelled'
          LEFT JOIN order_line_items oli ON oli.order_id = o.id
          WHERE fer.export_date >= $1 AND fer.export_date < $2
          GROUP BY fer.id, fer.customs_no, fer.export_date, fer.fob_foreign, fer.fob_cny,
                   fer.rebate_rate, fer.rebate_expected, fer.invoice_nos,
                   fer.rebate_lifecycle_status, fer.note, fer.contract_no
          ORDER BY fer.export_date DESC`,
          [start.toISOString(), end.toISOString()]);

    const ferRows = ferR.rows;
    if (!ferRows.length) {
      return res.json({ success: true, period: label, generated_at: new Date().toISOString(),
        summary: { total_orders: 0, est_rebate: 0, materials_ok: 0, materials_missing: 0 },
        orders: [] });
    }

    // 资料齐否: 报关单上传(doc_id = order_no)，同时取文件名用于显示
    const allOrderNos = [...new Set(ferRows.flatMap(r =>
      (r.order_nos || "").split(", ").map(s => s.trim()).filter(Boolean)))];
    // declByOrder: order_no → { name } (文件名，用于前端显示关联来源)
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

    // 进项票勾稽: finance_invoices_in 按 customs_nos / contract_nos 双通道关联(会计Excel同款 报关单✓/进项票✓)
    const invByCustoms = new Set(), invByContract = new Set();
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

    let sumRebate = 0, okCount = 0, missCount = 0, invOkCount = 0;
    const rows = ferRows.map(r => {
      const invoiceNos = Array.isArray(r.invoice_nos) ? r.invoice_nos : [];
      const invoiceStatus = invoiceNos.length > 0 ? "已开票" : "未开票";
      const rebate = parseFloat(r.rebate_expected || 0) || 0;
      sumRebate += rebate;
      const linkedOrders = (r.order_nos || "").split(", ").map(s => s.trim()).filter(Boolean);
      // 找到第一个有报关单上传的关联订单
      const matchedOrder = linkedOrders.find(ono => declByOrder[ono]);
      const hasDecl = !!matchedOrder;
      if (hasDecl) okCount++; else missCount++;
      // 从 note 解析发货港+客户提示: "东渡海关|PETSOME SDN BHD|税局接收成功"
      const noteParts = (r.note || "").split("|");
      const notePort = noteParts[0] || "";
      const noteHint = (noteParts[1] || "").trim();
      // 客户: 优先用 JOIN 到的真实公司名；
      // fallback 用 note 第二段，但必须像公司名（含字母，不是纯批次标记如"05-08批"）
      const looksLikeCompany = noteHint && /[A-Za-z一-龥]{3,}/.test(noteHint) && !/^\d{2}-\d{2}批$/.test(noteHint);
      const customerDisplay = r.customers || (looksLikeCompany ? noteHint : "—");
      const ferContracts = String(r.contract_no || "").split(/[\/,，;；\s]+/).filter(Boolean);
      const hasInputInv = invByCustoms.has(r.customs_no) || ferContracts.some(c => invByContract.has(c));
      if (hasInputInv) invOkCount++;
      return {
        customs_no: r.customs_no,
        order_nos: r.order_nos || "—",
        customers: customerDisplay,
        port: notePort,          // 发货港(海关): "东渡海关" / "青岛开发区"
        export_date: r.export_date,
        month: r.export_date ? new Date(r.export_date).toISOString().slice(0, 7) : "—",
        fob_foreign: parseFloat(r.fob_foreign || 0),
        est_rebate: rebate,
        declaration_names: r.declaration_names || "—",
        invoice_status: invoiceStatus,
        invoice_nos: invoiceNos,
        materials_ok: hasDecl,
        input_invoice_ok: hasInputInv,
        doc_ref: matchedOrder ? {
          order_no: matchedOrder,
          name: declByOrder[matchedOrder]?.name || "",
        } : null,
        rebate_status: r.rebate_lifecycle_status || "未退税",
        note: r.note || "",
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
