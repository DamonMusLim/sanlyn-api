// /api/so/trigger.js — SO 单触发协同分发
// POST /api/so/trigger { shipping_plan_id, triggered_by? }
// GET  /api/so/dispatch/:dispatch_job_id
// PATCH /api/so/loading-sheet  { loading_sheet_id, products?, loading? }
// POST  /api/so/loading-sheet/submit { loading_sheet_id }
// POST  /api/so/loading-sheet/revoke { loading_sheet_id }
// PATCH /api/so/trucking-confirm { token, confirmed_by_name, price_cny }
// PATCH /api/so/customs-acknowledge { dispatch_job_id }
import { getPool, setCors } from "../db/db.js";
import { requireAuth } from "../auth.js";
import crypto from "crypto";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const path = req.url?.split("?")[0] || "";

  // ── POST /api/so/trigger ─────────────────────────────────────────────────
  if (req.method === "POST" && path.endsWith("/trigger")) {
    if (!requireAuth(req, res)) return;
    const { shipping_plan_id, triggered_by } = req.body || {};
    if (!shipping_plan_id) return res.status(400).json({ error: "shipping_plan_id required" });

    try {
      // 1. 查 shipping_plan
      const planR = await pool.query(
        `SELECT id, so_no, shipment_no, booking_no, etd, eta, cargo_cutoff,
                vgm_cutoff, customs_cutoff, si_cutoff_date, doc_cutoff, port_open_date,
                container_type, container_qty, pol, pod, vessel, voyage,
                gross_weight_kg, total_cbm, total_cartons, forwarder_cn,
                shipping_status, source_system
         FROM shipping_plans WHERE id = $1`, [shipping_plan_id]);
      if (!planR.rowCount) return res.status(404).json({ error: "shipping_plan not found" });
      const plan = planR.rows[0];

      // 已触发过则返回现有 job
      const existingJob = await pool.query(
        "SELECT id FROM so_dispatch_jobs WHERE shipping_plan_id = $1", [shipping_plan_id]);
      if (existingJob.rowCount) {
        return res.json({ success: true, dispatch_job_id: existingJob.rows[0].id, reused: true });
      }

      // 2. 查关联 orders — 通过 order_nos[] 数组关联（主要方式）或 shipping_plan_id FK（新建单）
      const ordersR = await pool.query(
        `SELECT id, order_no, contract_no, customer_po, factory, factory_company_id,
                trade_terms, container_type, delivery_date, destination, customer,
                total_qty, total_cbm, gross_weight, net_weight, total_amount, currency
         FROM orders
         WHERE (shipping_plan_id = $1
                OR (order_no = ANY(
                      SELECT unnest(order_nos) FROM shipping_plans WHERE id = $1
                    ))
               )
           AND deleted_at IS NULL`, [shipping_plan_id]);
      const orders = ordersR.rows;

      // 3. 查 order_line_items → 计算 completeness_score
      let completenessSnapshot = { hs_ok: 0, decl_ok: 0, nw_ok: 0, total_lines: 0 };
      let completenessScore = 0;
      if (orders.length > 0) {
        const orderIds = orders.map(o => o.id);
        const itemsR = await pool.query(
          `SELECT sku, hs_code, declaration_name, nw_ctn
           FROM order_line_items WHERE order_id = ANY($1::int[])`, [orderIds]);
        const items = itemsR.rows;
        completenessSnapshot.total_lines = items.length;
        completenessSnapshot.hs_ok     = items.filter(i => i.hs_code).length;
        completenessSnapshot.decl_ok   = items.filter(i => i.declaration_name).length;
        completenessSnapshot.nw_ok     = items.filter(i => i.nw_ctn && Number(i.nw_ctn) > 0).length;
        if (items.length > 0) {
          completenessScore = Math.round(
            (completenessSnapshot.hs_ok + completenessSnapshot.decl_ok + completenessSnapshot.nw_ok)
            / (items.length * 3) * 100
          );
        }
      }

      // 4. 查工厂公司信息
      let factoryCompany = null;
      const factoryRef = orders[0]?.factory || orders[0]?.factory_company_id;
      if (factoryRef) {
        const compR = orders[0]?.factory_company_id
          ? await pool.query("SELECT id, code, name_cn, address, contact_name, contact_phone, province FROM companies WHERE id = $1", [orders[0].factory_company_id])
          : await pool.query("SELECT id, code, name_cn, address, contact_name, contact_phone, province FROM companies WHERE code = $1 AND type IN ('factory','external_factory') LIMIT 1", [factoryRef]);
        if (compR.rowCount) factoryCompany = compR.rows[0];
      }

      // 5. 查匹配 trucking_route
      let truckingVendor = null;
      let truckingRoute = null;
      if (factoryCompany) {
        const containerType = plan.container_type || orders[0]?.container_type;
        const routeR = await pool.query(
          `SELECT r._id, r.vendor_id, r.factory_name, r.pickup_city, r.pol_terminal,
                  r.distance_km, r.rates, r.tax_included,
                  v.vendor_cn, v.currency
           FROM trucking_routes r
           JOIN trucking_vendors v ON v._id = r.vendor_id
           WHERE r.factory_company_id = $1
             AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
           ORDER BY r.valid_to DESC NULLS LAST
           LIMIT 1`, [factoryCompany.id]);
        if (routeR.rowCount) {
          truckingRoute = routeR.rows[0];
          const baseRates = truckingRoute.rates || {};
          // 取匹配柜型的基准价
          const rateKey = containerType === "40HQ" ? "40HQ-heavy" : (containerType || "40HQ-heavy");
          truckingRoute._base_price = baseRates[rateKey]?.cost ?? null;
          truckingVendor = { vendor_cn: truckingRoute.vendor_cn };
        }
      }

      // 6. UPSERT loading_collab_sheets
      let loadingSheetId = null;
      if (orders.length > 0) {
        const existSheet = await pool.query(
          "SELECT id FROM loading_collab_sheets WHERE shipping_plan_id = $1 LIMIT 1", [shipping_plan_id]);
        if (existSheet.rowCount) {
          loadingSheetId = existSheet.rows[0].id;
        } else {
          const o = orders[0];
          const sheetR = await pool.query(
            `INSERT INTO loading_collab_sheets
               (order_id, order_no, contract_no, factory_code, shipping_plan_id,
                status, trade_terms, customer_code, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'assigned',$6,$7,now(),now())
             RETURNING id`,
            [o.id, o.order_no, o.contract_no,
             factoryCompany?.code || o.factory,
             shipping_plan_id, o.trade_terms, o.customer]);
          loadingSheetId = sheetR.rows[0].id;
        }
      }

      // 7. INSERT so_dispatch_jobs
      const jobR = await pool.query(
        `INSERT INTO so_dispatch_jobs
           (shipping_plan_id, loading_sheet_id, triggered_by, triggered_at)
         VALUES ($1,$2,$3,now()) RETURNING id`,
        [shipping_plan_id, loadingSheetId, triggered_by || null]);
      const dispatchJobId = jobR.rows[0].id;

      // 8. INSERT so_trucking_assignments
      let truckingAssignmentId = null;
      if (truckingRoute) {
        const token = crypto.randomBytes(32).toString("hex");
        const tokenExpires = new Date(Date.now() + 72 * 3600 * 1000);
        const taR = await pool.query(
          `INSERT INTO so_trucking_assignments
             (dispatch_job_id, vendor_id, route_id, price_cny, tax_included,
              confirm_token, token_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [dispatchJobId, truckingRoute.vendor_id, truckingRoute._id,
           truckingRoute._base_price, truckingRoute.tax_included !== false,
           token, tokenExpires]);
        truckingAssignmentId = taR.rows[0].id;
        // 更新 trucking_status = notified
        await pool.query(
          "UPDATE so_dispatch_jobs SET trucking_status='notified', updated_at=now() WHERE id=$1",
          [dispatchJobId]);
      }

      // 9. INSERT so_customs_notifications (立刻通知，Q3=A)
      const cnR = await pool.query(
        `INSERT INTO so_customs_notifications
           (dispatch_job_id, completeness_snapshot, completeness_score, notified_at)
         VALUES ($1,$2,$3,now()) RETURNING id`,
        [dispatchJobId, JSON.stringify(completenessSnapshot), completenessScore]);
      const customsNotifId = cnR.rows[0].id;
      await pool.query(
        "UPDATE so_dispatch_jobs SET customs_status='notified', updated_at=now() WHERE id=$1",
        [dispatchJobId]);

      // 10. 更新 shipping_plans.collab_status
      await pool.query(
        "UPDATE shipping_plans SET collab_status='collab_open', updated_at=now() WHERE id=$1",
        [shipping_plan_id]);

      return res.status(201).json({
        success: true,
        dispatch_job_id: dispatchJobId,
        loading_sheet_id: loadingSheetId,
        trucking_assignment_id: truckingAssignmentId,
        customs_notification_id: customsNotifId,
        completeness_score: completenessScore,
        completeness_snapshot: completenessSnapshot,
        trucking_matched: !!truckingRoute,
        trucking_vendor: truckingVendor?.vendor_cn || null,
      });
    } catch (e) {
      console.error("[so/trigger]", e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── GET /api/so/dispatch/:id ─────────────────────────────────────────────
  if (req.method === "GET" && path.includes("/dispatch/")) {
    const dispatchJobId = path.split("/dispatch/")[1]?.split("?")[0];
    if (!dispatchJobId) return res.status(400).json({ error: "dispatch_job_id required" });
    try {
      const jobR = await pool.query("SELECT * FROM so_dispatch_jobs WHERE id=$1", [dispatchJobId]);
      if (!jobR.rowCount) return res.status(404).json({ error: "not found" });
      const job = jobR.rows[0];

      const [planR, ordersR, taR, cnR, sheetR] = await Promise.all([
        pool.query(
          `SELECT id, so_no, shipment_no, booking_no, bl_no, vessel, voyage,
                  etd, eta, cargo_cutoff, vgm_cutoff, customs_cutoff,
                  si_cutoff_date, doc_cutoff, port_open_date,
                  container_type, container_qty, pol, pod,
                  gross_weight_kg, total_cbm, total_cartons,
                  forwarder_cn, source_system
           FROM shipping_plans WHERE id=$1`, [job.shipping_plan_id]),
        pool.query(
          `SELECT o.id, o.order_no, o.contract_no, o.customer_po, o.destination,
                  o.trade_terms, o.total_qty, o.net_weight, o.gross_weight,
                  o.total_cbm, o.total_amount, o.currency,
                  o.factory, o.factory_company_id,
                  c.name_cn AS factory_name_cn, c.address AS factory_address,
                  c.contact_name, c.contact_phone, c.province AS factory_province
           FROM orders o
           LEFT JOIN companies c ON c.id = o.factory_company_id::int
           WHERE (o.shipping_plan_id=$1
                  OR o.order_no = ANY(
                       SELECT unnest(order_nos) FROM shipping_plans WHERE id=$1
                     ))
             AND o.deleted_at IS NULL`, [job.shipping_plan_id]),
        pool.query(
          `SELECT ta.id, ta.vendor_id, ta.route_id,
                  ta.price_cny, ta.price_diff, ta.tax_included,
                  ta.confirmed_at, ta.confirmed_by_name,
                  v.vendor_cn, v.currency AS vendor_currency,
                  r.pol_terminal, r.pickup_city, r.distance_km, r.rates
           FROM so_trucking_assignments ta
           LEFT JOIN trucking_vendors v ON v._id = ta.vendor_id
           LEFT JOIN trucking_routes r ON r._id = ta.route_id
           WHERE ta.dispatch_job_id=$1`, [dispatchJobId]),
        pool.query(
          "SELECT * FROM so_customs_notifications WHERE dispatch_job_id=$1", [dispatchJobId]),
        job.loading_sheet_id
          ? pool.query("SELECT * FROM loading_collab_sheets WHERE id=$1", [job.loading_sheet_id])
          : Promise.resolve({ rows: [] }),
      ]);

      // 附带 order_line_items
      const orderIds = ordersR.rows.map(o => o.id);
      const itemsR = orderIds.length
        ? await pool.query(
            `SELECT id, order_id, sku, product_name, brand, bg_bx, qty_ctn,
                    nw_ctn, gw_ctn, cbm_ctn, size,
                    hs_code, declaration_name, bl_description,
                    vat_rate, tax_rebate_rate, unit_price
             FROM order_line_items WHERE order_id = ANY($1::int[])
             ORDER BY sort_order ASC NULLS LAST`, [orderIds])
        : { rows: [] };

      // 组装 orders + items
      const itemsByOrder = {};
      for (const item of itemsR.rows) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }
      const ordersWithItems = ordersR.rows.map(o => ({
        ...o,
        line_items: itemsByOrder[o.id] || [],
      }));

      return res.json({
        success: true,
        dispatch_job: job,
        shipping_plan: planR.rows[0] || null,
        orders: ordersWithItems,
        trucking_assignment: taR.rows[0] || null,
        customs_notification: cnR.rows[0] || null,
        loading_sheet: sheetR.rows[0] || null,
      });
    } catch (e) {
      console.error("[so/dispatch GET]", e);
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PATCH /api/so/loading-sheet ──────────────────────────────────────────
  if (req.method === "PATCH" && path.endsWith("/loading-sheet")) {
    const { loading_sheet_id, products, loading } = req.body || {};
    if (!loading_sheet_id) return res.status(400).json({ error: "loading_sheet_id required" });
    try {
      const sheetR = await pool.query(
        "SELECT id, status, shipping_plan_id FROM loading_collab_sheets WHERE id=$1", [loading_sheet_id]);
      if (!sheetR.rowCount) return res.status(404).json({ error: "sheet not found" });
      const sheet = sheetR.rows[0];
      if (sheet.status === "submitted") {
        // Q1: 只有 Sanlyn 内部 (requireAuth) 可在报关前修改
        if (!requireAuth(req, res, true)) {
          return res.status(403).json({ error: "sheet submitted, only Sanlyn staff can modify" });
        }
      }

      // 校验 products — sku 必须在 order_line_items 中，只允许改件重尺
      if (products && Array.isArray(products)) {
        for (const p of products) {
          if (p.nw_ctn != null && (isNaN(+p.nw_ctn) || +p.nw_ctn <= 0 || +p.nw_ctn > 2000)) {
            return res.status(422).json({ error: `nw_ctn 超范围: ${p.sku}` });
          }
          if (p.cbm_ctn != null && (isNaN(+p.cbm_ctn) || +p.cbm_ctn <= 0 || +p.cbm_ctn > 5)) {
            return res.status(422).json({ error: `cbm_ctn 超范围: ${p.sku}` });
          }
        }
      }

      const sets = [], vals = [];
      if (products !== undefined) { vals.push(JSON.stringify(products)); sets.push(`products=$${vals.length}::jsonb`); }
      if (loading !== undefined)  { vals.push(JSON.stringify(loading));  sets.push(`loading=$${vals.length}::jsonb`);  }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      sets.push("updated_at=now()");
      if (sheet.status === "assigned") {
        sets.push("status='in_progress'");
      }
      vals.push(loading_sheet_id);
      const r = await pool.query(
        `UPDATE loading_collab_sheets SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);

      // 如果 loading 有内容，更新 factory_status → filling
      await pool.query(
        `UPDATE so_dispatch_jobs SET factory_status='filling', updated_at=now()
         WHERE loading_sheet_id=$1 AND factory_status='pending'`, [loading_sheet_id]);

      // 重新计算 completeness_score（件重尺更新后）
      if (products) {
        const jobR = await pool.query(
          "SELECT id FROM so_dispatch_jobs WHERE loading_sheet_id=$1", [loading_sheet_id]);
        if (jobR.rowCount) {
          const jid = jobR.rows[0].id;
          const planIdR = await pool.query(
            "SELECT shipping_plan_id FROM so_dispatch_jobs WHERE id=$1", [jid]);
          const planId = planIdR.rows[0].shipping_plan_id;
          const orderIdsR = await pool.query(
            "SELECT id FROM orders WHERE shipping_plan_id=$1 AND deleted_at IS NULL", [planId]);
          const oIds = orderIdsR.rows.map(o => o.id);
          if (oIds.length) {
            const itemsR = await pool.query(
              "SELECT hs_code, declaration_name, nw_ctn FROM order_line_items WHERE order_id=ANY($1::int[])", [oIds]);
            const items = itemsR.rows;
            const snap = {
              total_lines: items.length,
              hs_ok:   items.filter(i => i.hs_code).length,
              decl_ok: items.filter(i => i.declaration_name).length,
              nw_ok:   items.filter(i => i.nw_ctn && Number(i.nw_ctn) > 0).length,
            };
            const score = items.length
              ? Math.round((snap.hs_ok + snap.decl_ok + snap.nw_ok) / (items.length * 3) * 100)
              : 0;
            await pool.query(
              `UPDATE so_customs_notifications
               SET completeness_snapshot=$1::jsonb, completeness_score=$2
               WHERE dispatch_job_id=$3`, [JSON.stringify(snap), score, jid]);
          }
        }
      }

      return res.json({ success: true, data: r.rows[0] });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST /api/so/loading-sheet/submit ────────────────────────────────────
  if (req.method === "POST" && path.endsWith("/loading-sheet/submit")) {
    const { loading_sheet_id } = req.body || {};
    if (!loading_sheet_id) return res.status(400).json({ error: "loading_sheet_id required" });
    try {
      await pool.query(
        `UPDATE loading_collab_sheets
         SET status='submitted', submitted_at=now(), updated_at=now()
         WHERE id=$1`, [loading_sheet_id]);
      await pool.query(
        `UPDATE so_dispatch_jobs SET factory_status='submitted', updated_at=now()
         WHERE loading_sheet_id=$1`, [loading_sheet_id]);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST /api/so/loading-sheet/revoke (Q1: 撤回，报关前) ─────────────────
  if (req.method === "POST" && path.endsWith("/loading-sheet/revoke")) {
    const { loading_sheet_id, reason } = req.body || {};
    if (!loading_sheet_id) return res.status(400).json({ error: "loading_sheet_id required" });
    try {
      // 检查报关是否已提交
      const jobR = await pool.query(
        "SELECT id, customs_status FROM so_dispatch_jobs WHERE loading_sheet_id=$1", [loading_sheet_id]);
      if (jobR.rowCount) {
        const customs_status = jobR.rows[0].customs_status;
        if (customs_status === "ready") {
          return res.status(403).json({ error: "报关已提交，无法撤回件重尺" });
        }
      }
      await pool.query(
        `UPDATE loading_collab_sheets
         SET status='filling', revision_reason=$1, updated_at=now()
         WHERE id=$2`, [reason || null, loading_sheet_id]);
      if (jobR.rowCount) {
        await pool.query(
          "UPDATE so_dispatch_jobs SET factory_status='filling', updated_at=now() WHERE id=$1",
          [jobR.rows[0].id]);
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PATCH /api/so/trucking-confirm ───────────────────────────────────────
  if (req.method === "PATCH" && path.endsWith("/trucking-confirm")) {
    const { token, confirmed_by_name, price_cny } = req.body || {};
    if (!token) return res.status(400).json({ error: "token required" });
    try {
      const taR = await pool.query(
        `SELECT ta.id, ta.dispatch_job_id, ta.price_cny AS base_price,
                ta.token_expires_at, ta.confirmed_at
         FROM so_trucking_assignments ta
         WHERE ta.confirm_token=$1`, [token]);
      if (!taR.rowCount) return res.status(404).json({ error: "token not found" });
      const ta = taR.rows[0];
      if (ta.confirmed_at) return res.json({ success: true, already_confirmed: true });
      if (new Date(ta.token_expires_at) < new Date()) {
        return res.status(403).json({ error: "确认链接已过期（72h），请联系 Sanlyn 重新发送" });
      }

      const confirmedPrice = price_cny != null ? Number(price_cny) : Number(ta.base_price);
      const priceDiff = ta.base_price != null ? confirmedPrice - Number(ta.base_price) : null;
      const diffPct   = ta.base_price != null && Number(ta.base_price) > 0
        ? (priceDiff / Number(ta.base_price)) : null;

      // Q2: 差异 > 5% → price_flagged + wechat push
      const status = diffPct != null && diffPct > 0.05 ? "price_flagged" : "confirmed";

      await pool.query(
        `UPDATE so_trucking_assignments
         SET confirmed_at=now(), confirmed_by_name=$1,
             price_cny=$2, price_diff=$3
         WHERE id=$4`,
        [confirmed_by_name || null, confirmedPrice, priceDiff, ta.id]);
      await pool.query(
        `UPDATE so_dispatch_jobs SET trucking_status=$1, updated_at=now() WHERE id=$2`,
        [status, ta.dispatch_job_id]);

      if (status === "price_flagged") {
        // 异步推送微信告警（不阻塞响应）
        import("child_process").then(({ execFile }) => {
          execFile("/Users/mac/bin/wechat-push",
            [`⚠ 车队报价差异：确认价 ¥${confirmedPrice}，比基准高 ¥${priceDiff?.toFixed(0)}（${(diffPct*100).toFixed(1)}%），请在协同表核实`],
            { timeout: 8000 }, () => {});
        }).catch(() => {});
      }

      return res.json({ success: true, status, price_diff: priceDiff });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── PATCH /api/so/customs-acknowledge ────────────────────────────────────
  if (req.method === "PATCH" && path.endsWith("/customs-acknowledge")) {
    const { dispatch_job_id } = req.body || {};
    if (!dispatch_job_id) return res.status(400).json({ error: "dispatch_job_id required" });
    try {
      await pool.query(
        "UPDATE so_customs_notifications SET broker_acknowledged_at=now() WHERE dispatch_job_id=$1",
        [dispatch_job_id]);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
}
