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

      // Optional direction filter — accepts canonical (AR/AP), legacy
      // Chinese (收款/付款), or "UNCLASSIFIED" for explicitly unset rows.
      // Codex P2 (round 3): AR must NOT silently include NULL/empty
      // direction rows; those are unclassified and may include AP/legacy.
      // Callers needing the unclassified bucket must request it explicitly.
      if (direction) {
        const dir = direction.toUpperCase();
        if (dir === "AR") {
          conds.push(`direction IN ('AR','收款','in')`);
        } else if (dir === "AP") {
          conds.push(`direction IN ('AP','付款','out')`);
        } else if (dir === "UNCLASSIFIED") {
          conds.push(`(direction IS NULL OR direction = '')`);
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

      // ── Summary totals — Codex P2 (round 4) ─────────────────────────
      // Earlier rounds aggregated from r.rows (the LIMITed page), so
      // companies with > limit rows had understated dashboard totals.
      // Now run a SEPARATE aggregate query against the FULL filtered set
      // (same WHERE clause, no LIMIT). One row per (currency, direction).
      //
      // Amount fallback (mirrors reconciliation.js):
      //   COALESCE(paid_amount, this_amount, raw->>'receivedAmount'::numeric, amount, 0)
      const summaryWhere = conds.length ? " WHERE " + conds.join(" AND ") : "";
      // Reuse params (no LIMIT placeholder for summary query)
      const summaryParams = params.slice(0, -1); // drop the LIMIT param appended later
      const summarySql = `
        SELECT
          COALESCE(NULLIF(currency,''), 'UNKNOWN') AS ccy,
          CASE
            WHEN direction IN ('AR','收款','in')  THEN 'AR'
            WHEN direction IN ('AP','付款','out') THEN 'AP'
            ELSE 'OTHER'
          END AS dc,
          COUNT(*) AS cnt,
          COALESCE(SUM(
            COALESCE(
              paid_amount,
              this_amount,
              -- raw is importer-controlled JSON; receivedAmount may be a
              -- formatted string ('1,234.00', '¥1234'). Codex round 7 P2:
              -- only cast when the trimmed/comma-stripped value is a
              -- plain number. Anything else → fall through to amount.
              CASE
                WHEN raw->>'receivedAmount' IS NULL THEN NULL
                WHEN regexp_replace(raw->>'receivedAmount', '[, ]', '', 'g') ~ '^-?\d+(\.\d+)?$'
                  THEN regexp_replace(raw->>'receivedAmount', '[, ]', '', 'g')::numeric
                ELSE NULL
              END,
              amount,
              0
            )
          ), 0)::numeric AS total,
          COUNT(*) FILTER (
            WHERE (contract_no IS NULL OR contract_no = '')
              AND (order_no    IS NULL OR order_no    = '')
          ) AS unmatched_in_bucket
        FROM finance_payments
        ${summaryWhere}
        GROUP BY 1, 2
      `;
      const sumRes = await pool.query(summarySql, summaryParams);

      const by_currency = {};
      let unmatched = 0;
      sumRes.rows.forEach(row => {
        const ccy = row.ccy.toUpperCase();
        if (!by_currency[ccy]) by_currency[ccy] = { ar: 0, ap: 0 };
        if (row.dc === "AR") by_currency[ccy].ar += parseFloat(row.total) || 0;
        else if (row.dc === "AP") by_currency[ccy].ap += parseFloat(row.total) || 0;
        unmatched += parseInt(row.unmatched_in_bucket, 10) || 0;
      });
      Object.keys(by_currency).forEach(c => {
        by_currency[c].ar = Math.round(by_currency[c].ar * 100) / 100;
        by_currency[c].ap = Math.round(by_currency[c].ap * 100) / 100;
      });

      return res.status(200).json({
        success:  true,
        data:     r.rows,
        // Backward-compat: legacy callers (pre-PR-#5) read `payments`.
        // Codex P2: keep the old key alongside `data` until all callers
        // migrate. Same array reference — no extra payload cost.
        payments: r.rows,
        count:    r.rowCount,
        summary: {
          by_currency, // canonical — { CNY: {ar, ap}, USD: {ar, ap}, ... }
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
        companyCode,
      } = req.body;

      if (!contractNo) return res.status(400).json({ error: "contractNo required" });

      // L3: companyCode 格式校验 (fail-closed)
      const CC_RE = /^(CN-[0-9]{4,}|BABI|OCEANBABY|FORTUNESANLYN|SANLYN)$/;
      if (companyCode && !CC_RE.test(companyCode)) {
        return res.status(422).json({ error: `companyCode '${companyCode}' 格式无效，必须是 CN-XXXXX 或已知常量` });
      }

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
        // UPDATE — only set fields that are provided.
        //
        // PATCH placeholder rule (Codex P1-1 fix):
        //   add(value, sqlFragment) does push-first then derives the placeholder
        //   from the post-push length. So vals[0] = $1, vals[1] = $2, ...
        //   The WHERE contract_no placeholder is the LAST one ($N).
        //
        // Manual proof (cases that previously failed):
        //   1. PATCH only slipUrl:
        //        vals=[slipUrl, contractNo]
        //        SET tt_slip_url = $1, updated_at = NOW()
        //        WHERE contract_no = $2  ✓
        //   2. PATCH slipUrl + paidAmount + bankRef:
        //        vals=[slipUrl, paidAmount, bankRef, contractNo]
        //        SET tt_slip_url=$1, paid_amount=$2, bank_ref=$3, updated_at=NOW()
        //        WHERE contract_no = $4  ✓
        //   3. PATCH only rawPatch (note/buyer/etc):
        //        vals=[jsonb, contractNo]
        //        SET raw = ... $1::jsonb, updated_at = NOW()
        //        WHERE contract_no = $2  ✓
        const sets = [];
        const vals = [];
        const add = (value, fragment) => {
          vals.push(value);
          sets.push(fragment.replace("$$", "$" + vals.length));
        };
        if (slipUrl)     add(slipUrl,            `tt_slip_url = $$`);
        // Codex round 8 P2: invoiceUrl ('https://...') and invoiceDate
        // ('2026-05-11') are plain strings, not JSON literals. The old
        // `$N::jsonb` cast would throw 22P02. Use to_jsonb($N::text) to
        // wrap the bound string in a JSON string value safely.
        if (invoiceUrl)  add(invoiceUrl,         `raw = jsonb_set(COALESCE(raw,'{}'), '{invoiceUrl}',  to_jsonb($$::text))`);
        if (invoiceDate) add(invoiceDate,        `raw = jsonb_set(COALESCE(raw,'{}'), '{invoiceDate}', to_jsonb($$::text))`);
        if (paidAmount != null) add(Number(paidAmount), `paid_amount = $$`);
        if (amount != null)     add(Number(amount),     `amount = $$`);
        if (bankRef)     add(bankRef,            `bank_ref = $$`);
        if (currency)    add(currency,           `currency = $$`);
        if (Object.keys(rawPatch).length > 0) {
          add(JSON.stringify(rawPatch),          `raw = COALESCE(raw,'{}') || $$::jsonb`);
        }
        sets.push("updated_at = NOW()");

        if (vals.length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }

        // WHERE binding is the final placeholder ($N+1 after all SET bindings)
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
