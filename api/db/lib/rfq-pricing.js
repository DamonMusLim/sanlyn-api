function cleanType(v) {
  return String(v || "40HQ").toUpperCase().replace("HC", "HQ");
}

function rateColumn(ct) {
  return cleanType(ct).includes("20") ? "gp20" : "hq40";
}

function median(nums) {
  const xs = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

async function ensureNotifications(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      type VARCHAR(32), level VARCHAR(12) DEFAULT 'info', title VARCHAR(200), body TEXT,
      payload JSONB, scope VARCHAR(24), scope_id VARCHAR(64), recipients TEXT[],
      recipient_roles TEXT[], channels TEXT[] DEFAULT ARRAY['inapp'],
      delivery_status JSONB DEFAULT '{}'::jsonb, read_by JSONB DEFAULT '{}'::jsonb,
      pinned_by TEXT[], archived_at TIMESTAMPTZ, related_op BIGINT,
      related_summary BIGINT, related_task VARCHAR(32), created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
}

export async function writeRfqNotification(pool, rfqId, title, body, payload = {}) {
  await ensureNotifications(pool);
  await pool.query(
    `INSERT INTO notifications
       (type, level, title, body, payload, scope, scope_id, recipient_roles, channels, delivery_status)
     VALUES ('rfq_loop', 'info', $1, $2, $3::jsonb, 'freight_rfq', $4,
             ARRAY['admin'], ARRAY['inapp'], '{"external":"none"}'::jsonb)`,
    [title, body, JSON.stringify({ rfq_id: rfqId, ...payload }), String(rfqId)]
  );
}

export async function priceRfq(pool, rfqId) {
  const { rows: rfqRows } = await pool.query(
    `SELECT id, pol, pod, ctnr_type, status FROM freight_rfqs WHERE id = $1 FOR UPDATE`,
    [rfqId]
  );
  if (!rfqRows.length) return { ok: false, error: "rfq_not_found" };
  const rfq = rfqRows[0];
  // 已成交/已作废的单绝不回写状态
  if (rfq.status === "accepted" || rfq.status === "void" || rfq.status === "awarded") {
    return { ok: true, status: rfq.status, skipped: "terminal_status" };
  }
  const ct = cleanType(rfq.ctnr_type);
  const col = rateColumn(ct);

  const { rows: quoteRows } = await pool.query(
    `SELECT forwarder_company_id, MIN(usd_rate)::numeric AS rate
       FROM freight_rfq_items
      WHERE rfq_id = $1
        AND submitted_at IS NOT NULL
        AND COALESCE(status,'quoted') = 'quoted'
        AND usd_rate IS NOT NULL AND usd_rate > 0
        AND forwarder_company_id IS NOT NULL
      GROUP BY forwarder_company_id`,
    [rfqId]
  );
  const rates = quoteRows.map(r => Number(r.rate)).filter(Number.isFinite);
  const lowest = rates.length ? Math.min(...rates) : null;

  // 不足3家 = 继续等报价：状态保持 open（催报只扫 open，改成 needs_review 会把催报环切断）
  if (rates.length < 3) {
    return { ok: true, status: "waiting", quotes: rates.length, need: 3 };
  }

  let reason = null;
  const sale = median(rates);
  if (sale <= lowest) reason = "中位数不高于最低采购价";

  if (!reason) {
    const { rows: histRows } = await pool.query(
      `SELECT ${col}::numeric AS rate
         FROM freight_rates
        WHERE COALESCE(source, '') <> 'rfq'
          AND lower(btrim(pol)) = lower(btrim($1))
          AND lower(btrim(pod)) = lower(btrim($2))
          AND ${col} IS NOT NULL
          AND COALESCE(sail_date, valid_from, created_at::date) >= CURRENT_DATE - INTERVAL '30 days'`,
      [rfq.pol, rfq.pod]
    );
    const hist = histRows.map(r => Number(r.rate)).filter(Number.isFinite);
    if (hist.length) {
      const base = median(hist);
      if (base > 0 && Math.abs(sale - base) / base > 0.3) {
        reason = "与近30天同航线中位价偏差超过30%";
      }
    }
  }

  if (reason) {
    await pool.query(
      `UPDATE freight_rfqs
          SET status = 'needs_review', needs_review_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [rfqId, reason]
    );
    await writeRfqNotification(pool, rfqId, "RFQ需人工复核", reason, { status: "needs_review" });
    return { ok: true, status: "needs_review", reason, quotes: rates.length };
  }

  const patch = {};
  patch[ct] = sale;
  await pool.query(
    `UPDATE freight_rfqs
        SET status = 'priced',
            client_rates_json = COALESCE(client_rates_json, '{}'::jsonb) || $2::jsonb,
            client_rate_usd = $3,
            markup_usd = $4,
            quote_published_at = NOW(),
            needs_review_reason = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [rfqId, JSON.stringify(patch), sale, sale - lowest]
  );
  await writeRfqNotification(pool, rfqId, "RFQ已自动定价", `${rfq.pol}→${rfq.pod} ${ct} USD ${sale}`, {
    status: "priced", client_rate_usd: sale, lowest_usd: lowest,
  });
  return { ok: true, status: "priced", client_rate_usd: sale, markup_usd: sale - lowest, quotes: rates.length };
}

export { cleanType, rateColumn, median };
