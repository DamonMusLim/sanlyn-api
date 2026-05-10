// api/db/finance_payments.js — PATCH payment records, GET list
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();

  // ── GET /api/db/finance_payments ─────────────────────────────
  if (req.method === "GET") {
    try {
      let { company_code, company_codes, direction, status, limit = 500 } = req.query;
      // ── Tenant scoping (fail-closed) ──
      // Non-admin users can ONLY see their own company's payment records.
      if (req.user && req.user.role !== "admin") {
        const userCodes = req.user.companyCodes
          || (req.user.companyCode ? [req.user.companyCode] : null);
        if (!userCodes || userCodes.length === 0) {
          return res.status(403).json({ error: "Account scope missing — please log out and log in again." });
        }
        company_codes = JSON.stringify(userCodes);
        company_code  = undefined;
      }

      // SELECT with field aliases so the frontend receives consistent keys:
      //   payment_no   = _id  (natural surrogate for display)
      //   payment_type = pay_type
      //   direction_canonical = normalised AR/AP label for UI
      let query = `
        SELECT *,
          _id                                          AS payment_no,
          COALESCE(pay_type, type)                     AS payment_type,
          CASE
            WHEN direction IN ('AR','收款','in') THEN 'AR'
            WHEN direction IN ('AP','付款','out') THEN 'AP'
            ELSE COALESCE(direction, '')
          END                                          AS direction_canonical
        FROM finance_payments
      `;
      let params = [], conds = [];

      if (company_codes) {
        let codes; try { codes = JSON.parse(company_codes); } catch { codes = company_codes.split(","); }
        if (codes.length > 0) {
          const ph = codes.map(c => { params.push(c); return "$" + params.length; });
          conds.push(`(raw->>'companyCode' IN (${ph.join(",")}) OR customer_en ILIKE ANY(ARRAY[${ph.map(p => p + "||'%'").join(",")}]))`);
        }
      } else if (company_code) {
        params.push(company_code);
        conds.push(`raw->>'companyCode' = $${params.length}`);
      }

      // Optional direction filter — accepts canonical (AR/AP) or legacy Chinese
      if (direction) {
        const dir = direction.toUpperCase();
        if (dir === "AR") {
          conds.push(`(direction IN ('AR','收款','in') OR direction IS NULL OR direction = '')`);
        } else if (dir === "AP") {
          conds.push(`direction IN ('AP','付款','out')`);
        } else {
          params.push(direction);
          conds.push(`direction = $${params.length}`);
        }
      }

      if (status) { params.push(status); conds.push(`status = $${params.length}`); }

      if (conds.length) query += " WHERE " + conds.join(" AND ");
      query += ` ORDER BY COALESCE(payment_date, paid_date, created_at) DESC LIMIT $${params.length + 1}`;
      params.push(Number(limit));

      const r = await pool.query(query, params);

      // ── Summary totals (AR / AP split) ────────────────────────
      let total_ar = 0, total_ap = 0, unmatched = 0;
      r.rows.forEach(row => {
        const amt = parseFloat(row.amount) || 0;
        const dc  = row.direction_canonical;
        if (dc === "AR") total_ar += amt;
        else if (dc === "AP") total_ap += amt;
        if (!row.contract_no && !row.order_no) unmatched++;
      });

      return res.status(200).json({
        success: true,
        data:    r.rows,
        count:   r.rowCount,
        summary: {
          total_ar:   Math.round(total_ar  * 100) / 100,
          total_ap:   Math.round(total_ap  * 100) / 100,
          unmatched,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH /api/db/finance_payments ───────────────────────────
  if (req.method === "PATCH") {
    try {
      const {
        contractNo, slipUrl, invoiceUrl, invoiceDate,
        amount, paidAmount, bankRef, currency, direction,
        contracts, buyer, shipperCompany, note,
      } = req.body;

      if (!contractNo) return res.status(400).json({ error: "contractNo required" });

      // Check if row exists
      const existing = await pool.query(
        "SELECT id FROM finance_payments WHERE contract_no = $1 LIMIT 1",
        [contractNo]
      );

      const rawPatch = {};
      if (contracts)      rawPatch.contracts      = contracts;
      if (buyer)          rawPatch.buyer           = buyer;
      if (shipperCompany) rawPatch.shipperCompany  = shipperCompany;
      if (note)           rawPatch.note            = note;

      if (existing.rows.length > 0) {
        // UPDATE — only set fields that are provided
        const sets = ["updated_at = NOW()"];
        const vals = [];
        const p = () => "$" + (vals.length + 1);
        if (slipUrl)     { vals.push(slipUrl);     sets.push(`tt_slip_url = ${p()}`); }
        if (invoiceUrl)  { vals.push(invoiceUrl);  sets.push(`raw = jsonb_set(COALESCE(raw,'{}'), '{invoiceUrl}', ${p()}::jsonb)`); }
        if (invoiceDate) { vals.push(invoiceDate); sets.push(`raw = jsonb_set(COALESCE(raw,'{}'), '{invoiceDate}', ${p()}::jsonb)`); }
        if (paidAmount != null) { vals.push(Number(paidAmount)); sets.push(`paid_amount = ${p()}`); }
        if (amount != null)     { vals.push(Number(amount));     sets.push(`amount = ${p()}`); }
        if (bankRef)     { vals.push(bankRef);     sets.push(`bank_ref = ${p()}`); }
        if (currency)    { vals.push(currency);    sets.push(`currency = ${p()}`); }
        if (Object.keys(rawPatch).length > 0) {
          vals.push(JSON.stringify(rawPatch));
          sets.push(`raw = COALESCE(raw,'{}') || ${p()}::jsonb`);
        }
        vals.push(contractNo);
        const r = await pool.query(
          `UPDATE finance_payments SET ${sets.join(", ")} WHERE contract_no = $${vals.length} RETURNING id`,
          vals
        );
        return res.status(200).json({ success: true, id: r.rows[0]?.id, action: "updated" });

      } else {
        // INSERT new row
        const rawData = { ...rawPatch };
        if (invoiceUrl)  rawData.invoiceUrl  = invoiceUrl;
        if (invoiceDate) rawData.invoiceDate = invoiceDate;

        const r = await pool.query(
          `INSERT INTO finance_payments
            (_id, contract_no, direction, currency, amount, paid_amount, bank_ref, tt_slip_url, raw, created_at, updated_at)
           VALUES
            ($1,  $2,          $3,        $4,       $5,     $6,          $7,       $8,          $9,  NOW(),       NOW())
           RETURNING id`,
          [
            `fp-${contractNo}-${Date.now()}`,
            contractNo,
            direction || "收款",
            currency  || "USD",
            amount    != null ? Number(amount) : null,
            paidAmount != null ? Number(paidAmount) : null,
            bankRef   || null,
            slipUrl   || null,
            JSON.stringify(rawData),
          ]
        );
        return res.status(200).json({ success: true, id: r.rows[0]?.id, action: "created" });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
