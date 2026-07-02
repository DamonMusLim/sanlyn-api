// api/db/rfq-requests.js
// freight_rfqs table CRUD — actual schema: id(uuid), order_id, pol, pod,
// ctnr_type, status, awarded_item_id, markup_usd, client_rate_usd, created_by, created_at

import { getPool, setCors } from "../db.js";
import { isInternalRole } from "../lib/viewmodel-adapter.js";

const ALLOWED_PATCH = ["pol","pod","ctnr_type","status","awarded_item_id",
                       "markup_usd","client_rate_usd","order_id","etd","route"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const pool = getPool();

  // ── GET ──
  if (req.method === "GET") {
    const { status, order_id, service_type, limit = 200 } = req.query;
    const internal = isInternalRole(req.user?.role);
    const companyId = req.user?.company_id || req.user?.companyId || null;
    const companyName = req.user?.company_name || req.user?.companyName || req.user?.company || null;
    const where = [];
    const vals = [internal, companyId, companyName];
    if (status) { where.push(`r.status = $${vals.length+1}`); vals.push(status); }
    if (order_id) { where.push(`r.order_id = $${vals.length+1}`); vals.push(order_id); }
    if (service_type) { where.push(`COALESCE(r.service_type,'ocean') = $${vals.length+1}`); vals.push(service_type); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT r.id, r.order_id, r.pol, r.pod, r.ctnr_type, r.status,
             r.awarded_item_id,
             r.created_by, r.created_at, r.updated_at, r.etd, r.route,
             r.shipping_plan_id, r.service_type,
             CASE WHEN $1::boolean THEN r.markup_usd ELSE NULL END AS markup_usd,
             CASE WHEN $1::boolean THEN r.client_rate_usd ELSE NULL END AS client_rate_usd,
             o.order_no,
             sp.container_qty AS ctnr_count,
             sp.gross_weight AS gross_weight_kg,
             sp.shipment_no AS plan_shipment_no,
             COALESCE(items.items, '[]'::json) AS items,
             (SELECT string_agg(t.label, ' / ')
                FROM (
                  SELECT (COALESCE(oi.product_name, '') || '×' || oi.qty_ctn || '箱') AS label
                    FROM order_line_items oi
                   WHERE oi.order_id = r.order_id
                   ORDER BY oi.sort_order NULLS LAST
                   LIMIT 3
                ) t
             ) AS product_summary
      FROM freight_rfqs r
      LEFT JOIN orders o ON o.id = r.order_id
      LEFT JOIN LATERAL (
        SELECT container_qty, gross_weight, shipment_no
          FROM shipping_plans
         WHERE order_id = r.order_id
         ORDER BY id DESC LIMIT 1
      ) sp ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(row_to_json(x) ORDER BY x.usd_rate ASC) AS items
          FROM (
            SELECT i.id, i.rfq_id, i.forwarder_co, i.vessel, i.voyage, i.etd,
                   i.usd_rate, i.port_charges_json, i.free_pol_days, i.free_pod_days,
                   i.dnd_usd, i.currency, i.selected, i.submitted_at,
                   i.container_type, i.carrier, i.customs_included, i.customs_fee
              FROM freight_rfq_items i
             WHERE i.rfq_id = r.id
               AND ($1::boolean
                 OR (($2::int IS NOT NULL AND i.forwarder_company_id = $2)
                   OR ($3::text IS NOT NULL AND i.forwarder_co = $3)))
          ) x
      ) items ON TRUE
      ${clause}
      ORDER BY r.created_at DESC
      LIMIT $${vals.length+1}`;
    vals.push(limit);
    const { rows } = await pool.query(sql, vals);
    return res.status(200).json({ success: true, data: rows, count: rows.length });
  }

  // ── POST action=sweep：出货计划缺成本 → 自动生成 open RFQ ──
  // 条件：成本为空 + 必要路线信息 + 未取消/未完成/未关闭
  // 防重：同 shipping_plan_id + service_type 已有未关闭 RFQ 则跳过。
  if (req.method === "POST" && (req.body || {}).action === "sweep") {
    const { rows: cands } = await pool.query(`
      SELECT sp.id, sp.shipment_no, sp.pol, sp.pod, sp.container_type, sp.etd
        FROM shipping_plans sp
       WHERE sp.freight_cost IS NULL
         AND sp.pol IS NOT NULL AND sp.pod IS NOT NULL
         AND COALESCE(sp.status,'') NOT IN ('cancelled','completed','closed')
         AND (sp.etd >= CURRENT_DATE OR sp.collab_status = 'collab_open' OR sp.created_at > now() - interval '21 days')
         AND NOT EXISTS (
           SELECT 1 FROM freight_rfqs r
            WHERE r.shipping_plan_id = sp.id
              AND COALESCE(r.service_type,'ocean') = 'ocean'
              AND r.status NOT IN ('closed','cancelled') )
       ORDER BY sp.etd NULLS LAST`);
    // 车队/报关/保险需求：对应成本为空 + 非自拖/自报（arrange_mode=self 排除）
    // 若同票海运报价已勾选含报关，报关由海运一口价覆盖，不再自动生成 customs RFQ，避免双算。
    const { rows: svcCands } = await pool.query(`
      SELECT sp.id, sp.shipment_no, sp.pol, sp.pod, sp.container_type, sp.etd,
             (sp.trucking_cost_total IS NULL) AS need_truck,
             (sp.customs_cost_total IS NULL AND NOT EXISTS (
                SELECT 1
                  FROM freight_rfqs r
                  JOIN freight_rfq_items i ON i.rfq_id = r.id
                 WHERE COALESCE(r.service_type,'ocean') = 'ocean'
                   AND i.customs_included IS TRUE
                   AND r.shipping_plan_id = sp.id
              )) AS need_customs,
             (sp.insurance_cost IS NULL) AS need_insurance
        FROM shipping_plans sp
       WHERE sp.pol IS NOT NULL
         AND COALESCE(sp.arrange_mode,'agent') <> 'self'
         AND COALESCE(sp.status,'') NOT IN ('cancelled','completed','closed')
         AND (sp.trucking_cost_total IS NULL OR sp.customs_cost_total IS NULL OR sp.insurance_cost IS NULL)
         AND (sp.etd >= CURRENT_DATE OR sp.collab_status = 'collab_open' OR sp.created_at > now() - interval '21 days')
       ORDER BY sp.etd NULLS LAST`);
    const created = [];
    const insertRfq = async (sp, svc) => {
      const ct = (sp.container_type || "40HQ").toUpperCase().replace("HC", "HQ");
      const route = svc === "ocean" ? `${sp.pol}→${sp.pod}`
        : svc === "truck" ? `装柜→${sp.pol}`
        : svc === "insurance" ? `${sp.pol} 货物投保` : `${sp.pol} 出口报关`;
      const { rows } = await pool.query(
        `INSERT INTO freight_rfqs (pol, pod, ctnr_type, status, etd, route,
           shipping_plan_id, service_type, created_by)
         SELECT $1,$2,$3,'open',$4,$5,$6,$7,$8
         WHERE NOT EXISTS (
           SELECT 1 FROM freight_rfqs r
            WHERE r.shipping_plan_id = $6 AND COALESCE(r.service_type,'ocean') = $7
              AND r.status NOT IN ('closed','cancelled'))
         RETURNING id, pol, pod, ctnr_type, etd, shipping_plan_id, service_type`,
        [sp.pol, sp.pod || null, ct, sp.etd || null, route,
         sp.id, svc, req.user?.username || "sweep"]
      );
      if (rows[0]) created.push(rows[0]);
    };
    for (const sp of cands) await insertRfq(sp, "ocean");
    for (const sp of svcCands) {
      if (sp.need_truck)   await insertRfq(sp, "truck");
      if (sp.need_customs) await insertRfq(sp, "customs");
      if (sp.need_insurance) await insertRfq(sp, "insurance");
    }
    return res.status(200).json({ success: true,
      scanned: cands.length + svcCands.length, created });
  }

  // ── POST ──
  if (req.method === "POST") {
    const { pol, pod, ctnr_type, status = "open", order_id, etd, route,
            markup_usd = 0, client_rate_usd, created_by } = req.body || {};
    if (!pol || !pod) return res.status(400).json({ error: "pol and pod required" });
    const { rows } = await pool.query(
      `INSERT INTO freight_rfqs (pol, pod, ctnr_type, status, order_id, etd, route,
         markup_usd, client_rate_usd, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [pol, pod, ctnr_type || "20GP", status, order_id || null, etd || null,
       route || null, markup_usd, client_rate_usd || null,
       created_by || req.user?.username || null]
    );
    return res.status(201).json({ success: true, data: rows[0] });
  }

  // ── PATCH ──
  if (req.method === "PATCH") {
    const { id, action, item_id, ...patch } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    // ── award action: atomically select winner, clear losers ──
    if (action === "award") {
      if (!item_id) return res.status(400).json({ error: "item_id required" });
      // Guard: item must have a submitted rate
      const { rows: itemCheck } = await pool.query(
        "SELECT id, usd_rate FROM freight_rfq_items WHERE id = $1 AND rfq_id = $2",
        [item_id, id]
      );
      if (!itemCheck.length) return res.status(404).json({ error: "Item not found in this RFQ" });
      if (!itemCheck[0].usd_rate) return res.status(422).json({ error: "该货代尚未提交报价" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Clear all selected flags for this rfq
        await client.query(
          "UPDATE freight_rfq_items SET selected = false WHERE rfq_id = $1",
          [id]
        );
        // Set winner
        await client.query(
          "UPDATE freight_rfq_items SET selected = true WHERE id = $1",
          [item_id]
        );
        // Update rfq
        const { rows } = await client.query(
          "UPDATE freight_rfqs SET awarded_item_id = $1, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *",
          [item_id, "awarded", id]
        );

        // ── 中标回写出货计划 ──
        // 全量留痕进 raw.rfq_award_<service>（含币种，绝不丢失语义）；
        // 成本列只在币种 = CNY 时回写（trucking/customs 列按 CNY 约定，ocean=freight_cost）。
        // USD 中标不写成本列（币种不匹配 = 不造数），人工换算后录。
        const rfqRow = rows[0];
        if (rfqRow && rfqRow.shipping_plan_id) {
          const { rows: itemFull } = await client.query(
            "SELECT forwarder_co, usd_rate, currency, vessel, etd FROM freight_rfq_items WHERE id = $1",
            [item_id]
          );
          const it = itemFull[0] || {};
          const svc = rfqRow.service_type || "ocean";
          const award = {
            rfq_id: id, item_id, service_type: svc,
            forwarder: it.forwarder_co || null,
            rate: it.usd_rate != null ? Number(it.usd_rate) : null,
            currency: it.currency || "USD",
            awarded_at: new Date().toISOString(),
            awarded_by: req.user?.username || null,
          };
          const rawPatch = {}; rawPatch["rfq_award_" + svc] = award;
          const sets = ["raw = COALESCE(raw,'{}'::jsonb) || $1::jsonb", "updated_at = now()"];
          const vals2 = [JSON.stringify(rawPatch)];
          const isCny = (it.currency || "USD") === "CNY" && it.usd_rate != null;
          if (svc === "truck") {
            if (isCny) { vals2.push(it.usd_rate); sets.push(`trucking_cost_total = $${vals2.length}`); }
            if (it.forwarder_co) { vals2.push(it.forwarder_co); sets.push(`trucking_company_cn = $${vals2.length}`); }
          } else if (svc === "customs") {
            if (isCny) { vals2.push(it.usd_rate); sets.push(`customs_cost_total = $${vals2.length}`); }
            if (it.forwarder_co) { vals2.push(it.forwarder_co); sets.push(`customs_cn = $${vals2.length}`); }
          } else if (svc === "ocean") {
            if (isCny) { vals2.push(it.usd_rate); sets.push(`freight_cost = $${vals2.length}`); }
            if (it.forwarder_co) { vals2.push(it.forwarder_co); sets.push(`forwarder_cn = $${vals2.length}`); }
          }
          vals2.push(rfqRow.shipping_plan_id);
          await client.query(
            `UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals2.length}`, vals2
          );
        }

        await client.query("COMMIT");
        return res.status(200).json({ success: true, data: rows[0], action: "awarded" });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    // ── generic field patch ──
    const keys = Object.keys(patch).filter(k => ALLOWED_PATCH.includes(k));
    if (!keys.length) return res.status(400).json({ error: "no valid fields" });
    const sets = keys.map((k, i) => `${k} = $${i+2}`).join(", ");
    const vals = [id, ...keys.map(k => patch[k])];
    const { rows } = await pool.query(
      `UPDATE freight_rfqs SET ${sets}, updated_at = NOW()
       WHERE id = $1 RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    return res.status(200).json({ success: true, data: rows[0] });
  }

  return res.status(405).json({ error: "method not allowed" });
}
