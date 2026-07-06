// booking-collab.js — 协同托书   PAGE_VERSION v1.2.0 · 2026-06-23 — 预览豁免+is_preview/preview_godview 标志(给前端预览身份横幅)
// Mounted at /api/db/booking-collab
//
// Endpoints:
//   GET  /validate          token验证 + 返回完整数据包
//   POST /send-factory-link Sanlyn内部 → 生成工厂链接
//   POST /send-customer-link Sanlyn内部 → 生成客户链接
//   POST /factory-submit    工厂提交（token鉴权，body.token）
//   POST /customer-submit   客户提交（token鉴权，body.token）
//   GET  /sailings          获取班次（query.token 鉴权）
//   POST /sailings          Sanlyn内部添加班次
//   DELETE /sailings/:id    Sanlyn内部删除班次

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getPool, setCors } from "../db.js";
import { requireAuth, generateToken } from "../auth.js";
import { registerBookingCollabView, derivePlanFactories } from "./booking-collab-view.js";

const APP_BASE = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
function genRaw() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars
}

// ── GET /validate?token=<raw> ──────────────────────────────────
async function handleCustomsDocStatus(req, res, pool) {
  if (!requireAuth(req, res)) return;

  const { plan_id, contract_no } = req.query || {};
  if (!plan_id && !contract_no) {
    return res.status(400).json({ ok: false, error: "plan_id or contract_no required" });
  }

  const vals = [];
  const where = [];
  if (plan_id) {
    vals.push(String(plan_id));
    where.push(`(sp._id = $${vals.length} OR sp.id::text = $${vals.length})`);
  }
  if (contract_no) {
    vals.push(String(contract_no));
    where.push(`o.contract_no = $${vals.length}`);
  }

  const { rows } = await pool.query(`
    SELECT sp.id,
           sp.customs_arrange,
           min(o.order_no) AS doc_id,
           min(o.contract_no) AS contract_no,
           count(DISTINCT o.contract_no) FILTER (WHERE o.contract_no IS NOT NULL AND o.contract_no <> '') AS contract_count,
           bool_or(du.doc_type IN ('customs_decl','customs_declaration')) AS uploaded,
           max(CASE WHEN du.doc_type IN ('customs_decl','customs_declaration')
                    THEN COALESCE(du.stamped_url, du.url) END) AS customs_url
      FROM shipping_plans sp
      LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      LEFT JOIN document_uploads du ON du.contract_no = o.contract_no
     WHERE ${where.join(" AND ")}
     GROUP BY sp.id, sp.customs_arrange
     LIMIT 1`,
    vals
  );

  if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });

  const row = rows[0];
  return res.json({
    ok: true,
    show: row.customs_arrange !== "self",
    uploaded: !!row.uploaded,
    customs_url: row.customs_url || null,
    need_manual: Number(row.contract_count || 0) > 1,
    doc_id: row.doc_id || null,
    contract_no: row.contract_no || contract_no || null,
  });
}

async function handleValidate(req, res, pool) {
  const raw = req.query && req.query.token;
  if (!raw || raw.length < 16)
    return res.status(400).json({ valid: false, error: "token 缺失" });

  const hash = rawToHash(raw);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta, expires_at
       FROM magic_links
      WHERE token_hash = $1
        AND recipient_role IN ('factory_booking','customer_booking','trucking_booking','broker_booking','supplier_portal')
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!rows.length)
    return res.json({ valid: false, error: "链接无效或已过期" });

  const { recipient_role: role, meta: rawMeta } = rows[0];
  const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta) || {};
  const factoryScope = meta.factory_scope || null;
  const portalScope = role === "supplier_portal"
    ? { segments: meta.segments || ["ocean","truck","customs"], company_label: meta.company_label || null }
    : null;
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId)
    return res.json({ valid: false, error: "链接数据异常 — 缺少 shipment_id" });

  // Fetch plan + orders
  const planRes = await pool.query(
    `SELECT sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta,
            sp.container_type, sp.container_qty, sp.collab_status,
            sp.total_cartons, sp.gross_weight_kg, sp.total_cbm, sp.freight_term,
            sp.raw->'customer_item_notes' AS customer_item_notes,
            sp.raw->'factory_cargo' AS factory_cargo,
            sp.raw->'factory_attrs' AS factory_attrs,
            sp.raw->'customer_amend' AS customer_amend,
            sp.trucking_arrange, sp.customs_arrange,
            sp.so_no, sp.bl_no, sp.cargo_cutoff, sp.carrier_code, sp.vessel, sp.voyage,
            sp.freight_sale_usd, sp.freight_term AS plan_freight_term,
            sp.release_type,
            (sp.source_system = 'freight_agency' OR sp.raw ? 'legs' OR sp.raw ? 'transfer') AS is_transfer,
            sp.raw->'cost_lines' AS _cost_lines_raw,
            (SELECT jsonb_agg(x->>'container_no') FROM jsonb_array_elements(COALESCE(sp.raw->'containers','[]'::jsonb)) x) AS containers_order,
            sp.raw->'fe_cert' AS fe_cert,
            sp.raw->'factory_entry' AS factory_entry,
            EXISTS(SELECT 1 FROM orders dg WHERE dg.shipping_plan_id = sp.id AND dg.export_mode='daigou') AS is_daigou,
            jsonb_build_object('terminal', sp.raw->>'terminal', 'ship_agent', sp.raw->>'ship_agent',
              'terminal_tel', sp.raw->>'terminal_tel', 'vgm_cutoff', sp.raw->>'vgm_cutoff',
              'so_source', sp.raw->>'so_source') || COALESCE(sp.raw->'so_extra','{}'::jsonb) AS so_info,
            sp.raw->'collab_uploads' AS collab_uploads,
            sp.raw->'factory_loading_done' AS factory_loading_done,
            sp.trucking_detail,
            sp.issuing_company,
            sp.customer AS customer_name,
            sp.customer_en,
            sp.factory_submitted, sp.factory_cargo_ready, sp.factory_container_type,
            sp.factory_cargo_type, sp.factory_remarks, sp.factory_submitted_at,
            sp.customer_submitted, sp.customer_selected_sailing, sp.customer_reference_no,
            sp.customer_remarks, sp.customer_submitted_at,
            sp.raw->'factory_bill_versions' AS factory_bill_versions,
            sp.raw->>'factory_bill_current_version' AS factory_bill_current_version,
            sp.raw->>'finance_bill_sent_at' AS finance_bill_sent_at,
            sp.raw->>'finance_bill_sent_by' AS finance_bill_sent_by,
            sp.raw->>'factory_bill_confirmed_at' AS factory_bill_confirmed_at,
            sp.raw->>'factory_bill_confirmed_by' AS factory_bill_confirmed_by,
            sp.raw->>'prebill_status' AS prebill_status,
            sp.raw->>'prebill_confirmed_at' AS prebill_confirmed_at,
            sp.raw->'pricing_decisions' AS pricing_decisions,
            COALESCE(
              json_agg(
                json_build_object(
                  'order_no', o.order_no,
                  'factory',  o.factory,
                  'export_mode', o.export_mode,
                  'total_qty', o.total_qty,
                  'gross_weight', o.gross_weight,
                  'items', (
                    SELECT COALESCE(json_agg(json_build_object(
                      'oli_id',      oli.id,
                      'sku',         oli.sku,
                      'description', oli.declaration_name,
                      'hs_code',     oli.hs_code,
                      'ctns',        oli.qty_ctn,
                      -- 行总毛重 = 单箱GW×箱数（gw_ctn 是每箱，直接给会差一个数量级）
                      'gw_kgs',      ROUND((COALESCE(oli.gw_ctn,0) * COALESCE(oli.qty_ctn,0))::numeric, 1),
                      'nw_kgs',      ROUND((COALESCE(oli.nw_ctn,0) * COALESCE(oli.qty_ctn,0))::numeric, 1),
                      'cbm',         ROUND((COALESCE(oli.cbm_ctn,0) * COALESCE(oli.qty_ctn,0))::numeric, 3),
                      'declare_amount', ROUND((COALESCE(NULLIF(oli.declare_amount_per_box,0), oli.unit_price, 0) * COALESCE(oli.qty_ctn,0))::numeric, 2),
                      'barcode',     oli.barcode,
                      'product_name', COALESCE(NULLIF(oli.product_name,''), oli.declaration_name),
                      'size',        oli.size,
                      'unit_price',  oli.unit_price,
                      'amount',      oli.subtotal
                    )), '[]'::json)
                    FROM order_line_items oli WHERE oli.order_id = o.id
                  )
                )
              ) FILTER (WHERE o.id IS NOT NULL),
              '[]'::json
            ) AS orders
       FROM shipping_plans sp
       LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      WHERE sp.id = $1
      GROUP BY sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta, sp.so_no, sp.bl_no, sp.cargo_cutoff, sp.carrier_code, sp.vessel, sp.voyage, sp.freight_sale_usd, sp.release_type, sp.source_system,
               sp.container_type, sp.container_qty, sp.collab_status,
               sp.total_cartons, sp.gross_weight_kg, sp.total_cbm, sp.freight_term,
               sp.raw, sp.trucking_detail, sp.issuing_company, sp.trucking_arrange, sp.customs_arrange, sp.customer, sp.customer_en,
               sp.factory_submitted, sp.factory_cargo_ready, sp.factory_container_type,
               sp.factory_cargo_type, sp.factory_remarks, sp.factory_submitted_at,
               sp.customer_submitted, sp.customer_selected_sailing, sp.customer_reference_no,
               sp.customer_remarks, sp.customer_submitted_at`,
    [planId]
  );
  if (!planRes.rows.length)
    return res.json({ valid: false, error: "找不到出货计划" });

  const sailingsRes = await pool.query(
    `SELECT id, carrier, vessel, voyage, etd, eta, cutoff_date, rate_usd, currency, is_recommended
       FROM plan_sailings
      WHERE shipping_plan_id = $1
      ORDER BY etd ASC`,
    [planId]
  );

  // 柜/车队真值实时关联：container_bookings 是柜数据 SSOT，trucking_detail 缺时自动派生
  const cbRaw = await pool.query(
    `SELECT cb.container_no, cb.seal_no, cb.container_type, cb.tare_weight_kg, cb.cargo_weight_kg, cb.vgm_weight_kg,
            NULLIF(cb.truck_plate,'') AS plate, NULLIF(cb.trailer_plate,'') AS trailer_plate,
            cb.driver_name, cb.driver_phone, cb.driver_id_no, cb.pickup_time,
            NULLIF(cb.loading_address,'') AS loading_address, NULLIF(cb.loading_contact,'') AS loading_contact,
            NULLIF(cb.declaration_cargo_name,'') AS decl_name,
            o.order_no, o.total_qty AS cartons, o.gross_weight AS order_gw
       FROM container_bookings cb
       LEFT JOIN orders o ON o.contract_no = cb.contract_no AND o.shipping_plan_id = cb.shipping_plan_id
      WHERE cb.shipping_plan_id = $1 ORDER BY cb.container_no, cb.id`, [planId]);
  // 按柜聚合：拼柜多合同 -> cargo 多行
  const cbMap = new Map();
  for (const r of cbRaw.rows) {
    const cur = cbMap.get(r.container_no) || { container_no: r.container_no, cargo: [] };
    for (const k of ['seal_no','container_type','tare_weight_kg','cargo_weight_kg','vgm_weight_kg','plate','trailer_plate','driver_name','driver_phone','driver_id_no','pickup_time','loading_address','loading_contact'])
      if (r[k] != null && cur[k] == null) cur[k] = r[k];
    if (r.decl_name || r.order_no)
      cur.cargo.push({ name: r.decl_name || null, order_no: r.order_no || null,
        cartons: r.cartons != null ? Number(r.cartons) : null,
        gw_kg: r.cargo_weight_kg != null ? Number(r.cargo_weight_kg) : (r.order_gw != null ? Number(r.order_gw) : null) });
    cbMap.set(r.container_no, cur);
  }
  const cbRes = { rows: [...cbMap.values()] };

  let factoryProfileAddress = null;
  if (role === "factory_booking" && meta.preview !== true && factoryScope && factoryScope.label) {
    const { rows: fpRows } = await pool.query(
      `SELECT id AS company_id, code, name_cn, address
         FROM companies
        WHERE name_cn = $1 AND type = 'factory'
        ORDER BY id
        LIMIT 2`,
      [String(factoryScope.label)]
    );
    if (fpRows.length === 1) factoryProfileAddress = fpRows[0];
  }

  return res.json({
    valid: true,
    role,
    is_preview: meta.preview === true,                                   // 内部预览 token（master-preview-token 生成）
    preview_godview: meta.preview === true && !(factoryScope && factoryScope.label), // 无 scope 的全貌预览
    factory_progress: await (async (roleX) => {
      // 分厂确认进度：有 scoped 链接才有意义（拼柜/分柜）
      const { rows: fl } = await pool.query(
        `SELECT DISTINCT meta->'factory_scope'->>'label' AS label FROM magic_links
          WHERE recipient_role = 'factory_booking'
            AND (meta->>'shipment_id')::int = $1
            AND meta->'factory_scope' IS NOT NULL AND revoked_at IS NULL`, [planId]);
      if (!fl.length) return null;
      const { rows: sub } = await pool.query(
        `SELECT raw->'factory_submits' AS fs FROM shipping_plans WHERE id = $1`, [planId]);
      const fs = (sub[0] && sub[0].fs) || {};
      const labels = fl.map(r => r.label);
      const done = labels.filter(l => fs[l]);
      if (roleX === "customer_booking")
        return { total: labels.length, submitted: done.length };  // 客户不见工厂实名（上游=出单公司）
      return { total: labels.length, submitted: done.length,
               done_labels: done, pending_labels: labels.filter(l => !fs[l]) };
    })(role),
    booking_sheet: (() => {
      const sheet = { ...planRes.rows[0], sailings: sailingsRes.rows };
      sheet.containers_live = cbRes.rows;
      // ── containers_detail：稳定 seq=1..N 柜槽（前端渲染/皮重/司机/地址读它）──
      const toNumOrNull = v => (v === undefined || v === null || v === "" || Number.isNaN(Number(v))) ? null : Number(v);
      const vehicleRows = (sheet.trucking_detail && Array.isArray(sheet.trucking_detail.vehicles)) ? sheet.trucking_detail.vehicles : [];
      const uploads = Array.isArray(sheet.collab_uploads)
        ? sheet.collab_uploads
        : ((sheet.raw && Array.isArray(sheet.raw.collab_uploads)) ? sheet.raw.collab_uploads : []);
      const slotQty = parseInt(sheet.container_qty, 10);
      const slotCount = slotQty > 0 ? slotQty : Math.max(sheet.containers_live.length, vehicleRows.length, 0);
      const uploadSeq = u => {
        const direct = parseInt(u && (u.container_seq || u.seq || u.containerSeq), 10);
        if (direct > 0) return direct;
        const s = String((u && u.filename) || "");
        const m = s.match(/(?:seq|柜|container|cntr)[^\d]{0,8}(\d+)/i) || s.match(/(?:^|[^\d])#?(\d+)(?:柜|号柜)/);
        return m ? parseInt(m[1], 10) : 1; // 老上传无 seq，先挂 seq1，输出保留 container_seq 供后续精确归柜
      };
      const uploadPurpose = u => {
        const p = String((u && (u.purpose || u.type || u.category)) || "");
        const fn = String((u && u.filename) || "");
        const txt = `${p} ${fn}`;
        return { driver: /司机|driver/i.test(txt), plate: /车牌|plate/i.test(txt) };
      };
      const photoFor = (u, purpose, seq) => ({ ...u, purpose, container_seq: seq });
      // 装柜资料（装箱图/视频/磅单）按柜归集 — 返回 stored 引用，前端用 token 拼 /file?type=upload 显示
      const kindOf = u => {
        const p = String((u && (u.purpose || u.type || u.category)) || "");
        const fn = String((u && u.filename) || "");
        const txt = `${p} ${fn}`;
        if (/装柜视频|video|\.(mp4|mov|avi)/i.test(txt)) return "video";
        if (/磅单|过磅|weigh|\.(pdf|xlsx?|docx?)/i.test(txt)) return "doc";
        return "image"; // 默认装箱图
      };
      const pickupFor = seq => {
        const out = { pickup_photos: [], pickup_videos: [], pickup_docs: [] };
        uploads.forEach(u => {
          if (!u || uploadSeq(u) !== seq) return;
          const pp = uploadPurpose(u);
          if (pp.driver || pp.plate) return; // 司机/车牌图归 driver_photos，不进装柜格
          const ref = { stored: u.stored || null, filename: u.filename || "", mime: u.mime || null };
          if (!ref.stored) return;
          const k = kindOf(u);
          if (k === "video") out.pickup_videos.push(ref);
          else if (k === "doc") out.pickup_docs.push(ref);
          else out.pickup_photos.push(ref);
        });
        return out;
      };
      const doneState = seq => {
        const fd = sheet.factory_loading_done;
        if (!fd || typeof fd !== "object") return { loading_done: false, loading_done_at: null };
        const pickTime = v => (v && typeof v === "object")
          ? (v.at || v.done_at || v.loading_done_at || v.confirmed_at || v.time || null)
          : null;
        const direct = Array.isArray(fd)
          ? fd.find(x => Number(x && (x.seq || x.container_seq)) === seq)
          : (fd[seq] || fd[`seq${seq}`] || fd[`container_${seq}`]);
        if (direct) return { loading_done: true, loading_done_at: pickTime(direct) };
        if (!Array.isArray(fd)) {
          for (const v of Object.values(fd)) {
            if (!v || typeof v !== "object") continue;
            const dseqs = Array.isArray(v.seqs) ? v.seqs : (Array.isArray(v.container_seqs) ? v.container_seqs : []);
            if (dseqs.map(Number).includes(seq)) return { loading_done: true, loading_done_at: pickTime(v) };
          }
          if (factoryScope && factoryScope.label && fd[factoryScope.label] && (factoryScope.seqs || []).map(Number).includes(seq))
            return { loading_done: true, loading_done_at: pickTime(fd[factoryScope.label]) };
        }
        return { loading_done: false, loading_done_at: null };
      };
      // 柜→工厂(按柜内货物所属订单的工厂),供分厂token按厂名过滤containers_detail(无seqs时)
      const _ordFac = {}; (Array.isArray(sheet.orders) ? sheet.orders : []).forEach(o => { if (o && o.order_no) _ordFac[o.order_no] = o.factory || null; });
      const factoryOfSeq = lv => { const cg = Array.isArray(lv && lv.cargo) ? lv.cargo : []; for (const g of cg) { const f = g && _ordFac[g.order_no]; if (f) return f; } return null; };
      sheet.containers_detail = Array.from({ length: slotCount }, (_, i) => {
        const seq = i + 1;
        const live = sheet.containers_live[i] || {};
        const veh = vehicleRows[i] || {};
        const driverPhotos = [];
        const platePhotos = [];
        uploads.forEach(u => {
          if (!u || uploadSeq(u) !== seq) return;
          const p = uploadPurpose(u);
          if (p.driver) driverPhotos.push(photoFor(u, "driver", seq));
          if (p.plate) platePhotos.push(photoFor(u, "plate", seq));
        });
        return {
          seq,
          factory: factoryOfSeq(live),
          container_no: live.container_no || "",
          seal_no: live.seal_no || veh.seal_no || null,
          container_type: live.container_type || sheet.container_type || null,
          tare_weight_kg: toNumOrNull(live.tare_weight_kg != null ? live.tare_weight_kg : veh.tare_kg),
          cargo_weight_kg: toNumOrNull(live.cargo_weight_kg != null ? live.cargo_weight_kg : veh.weigh_kg),
          vgm_weight_kg: toNumOrNull(live.vgm_weight_kg),
          driver_name: live.driver_name || veh.driver || null,
          driver_phone: live.driver_phone || veh.driver_phone || null,
          driver_id_no: live.driver_id_no || veh.driver_id_no || null,
          plate: live.plate || live.trailer_plate || veh.plate || veh.trailer_plate || null,
          loading_address: live.loading_address || veh.loading_address || (factoryProfileAddress && factoryProfileAddress.address) || null,
          loading_contact: live.loading_contact || veh.loading_contact || null,
          driver_photos: driverPhotos,
          plate_photos: platePhotos,
          ...pickupFor(seq),
          ...doneState(seq),
        };
      });
      // 价格：只有客户能看，且只给卖价——cost 一律不出 API
      const costLines = Array.isArray(sheet._cost_lines_raw) ? sheet._cost_lines_raw : [];
      delete sheet._cost_lines_raw;
      if (role === "customer_booking") {
        const saleLines = costLines
          .filter(l => l && l.sale !== undefined && l.sale !== null && String(l.sale) !== "" && l.name !== "海运费")
          .map(l => ({ name: l.name, sale: Number(l.sale) || 0, currency: l.currency || "CNY" }));
        sheet.pricing = {
          freight_sale_usd: sheet.freight_sale_usd != null ? Number(sheet.freight_sale_usd) : null,
          port_charges_total: saleLines.length ? saleLines.reduce((s, l) => s + l.sale, 0) : null,
          port_charges_lines: saleLines,
        };
      }
      delete sheet.freight_sale_usd;
      if (!(sheet.trucking_detail && Array.isArray(sheet.trucking_detail.vehicles) && sheet.trucking_detail.vehicles.length)) {
        const vehs = cbRes.rows.filter(r => r.plate || r.trailer_plate || r.driver_phone).map(r => ({
          plate: r.plate || r.trailer_plate || "", trailer_plate: r.trailer_plate || "",
          driver: r.driver_name || "", driver_phone: r.driver_phone || "", driver_id_no: r.driver_id_no || "",
          pickup_time: r.pickup_time || "", cntr: r.container_no, seal_no: r.seal_no || "",
          tare_kg: r.tare_weight_kg != null ? Number(r.tare_weight_kg) : null,
          loading_address: r.loading_address || "", loading_contact: r.loading_contact || "",
          loading_time: r.loading_time || "", cargo: r.cargo || [] }));
        if (vehs.length) sheet.trucking_detail = { ...(sheet.trucking_detail || {}), vehicles: vehs, source: "container_bookings" };
      }
      if (role === "customer_booking") {
        // 客户只见 ×1.02 卖价：申报金额(×1.13)/工厂价 一律裁掉，fail-closed
        (sheet.orders || []).forEach(o => (o.items || []).forEach(it => { delete it.declare_amount; }));
        ((sheet.trucking_detail && sheet.trucking_detail.vehicles) || []).forEach(v => { delete v.driver_phone; delete v.driver_id_no; });
        sheet.containers_live.forEach(cx => { delete cx.driver_phone; });
        (sheet.containers_detail || []).forEach(cx => { delete cx.driver_phone; });
      }
      // need-to-know 裁剪：航班运价(rate_usd=客户卖价)只给客户端
      if (role !== "customer_booking") sheet.sailings = [];
      if (role === "trucking_booking") {
        delete sheet.customer_name; delete sheet.customer_en;
        delete sheet.pod; delete sheet.customer_selected_sailing;
      }
      // 🔓 内部预览(preview:true)且未限定工厂 = Sanlyn 本人全貌预览，跳过工厂裁剪/fail-close；
      // 真正发给工厂的 7 天链接不带 preview，照常受租户隔离铁律约束(防跳单)。
      const _adminPreview = meta.preview === true && !(factoryScope && factoryScope.label);
      if (role === "factory_booking" && !_adminPreview) {
        delete sheet.customer_name; delete sheet.customer_en;   // 工厂只见下游 issuing_company
        delete sheet.customer_selected_sailing;
        // 🔒 防跳单租户隔离：scoped 才返回本厂数据；无 scope = fail-closed（绝不返回任何工厂货物）
        if (factoryScope && factoryScope.label) {
          const lab = String(factoryScope.label);
          const seqs = new Set((factoryScope.seqs || []).map(Number).filter(Boolean));
          const matchFac = f => f && (String(f).includes(lab) || lab.includes(String(f)));
          // 1) 订单：只本厂（互不可见对方品名/订单号）
          if (Array.isArray(sheet.orders)) sheet.orders = sheet.orders.filter(o => o && matchFac(o.factory));
          const myOrderNos = new Set((sheet.orders || []).map(o => o && o.order_no).filter(Boolean));
          // 2) factory_cargo（可编辑货物申报层）：只本厂 label
          if (Array.isArray(sheet.factory_cargo))
            sheet.factory_cargo = sheet.factory_cargo.filter(x => !x.factory_label || x.factory_label === lab);
          // 3) factory_entry（入厂要求）：只本厂
          if (sheet.factory_entry && typeof sheet.factory_entry === "object" && !Array.isArray(sheet.factory_entry))
            sheet.factory_entry = sheet.factory_entry[lab] ? { [lab]: sheet.factory_entry[lab] } : {};
          // 4) containers_live：只本厂负责的柜（按 seq 顺序 或 柜内含本厂订单号）
          if (Array.isArray(sheet.containers_live))
            sheet.containers_live = sheet.containers_live.filter((c, i) =>
              (seqs.size ? seqs.has(i + 1) : false) ||
              (Array.isArray(c.cargo) && c.cargo.some(g => g && myOrderNos.has(g.order_no))));
          // 5) 别厂订单号也是跳单线索：柜内 cargo 只留本厂行
          (sheet.containers_live || []).forEach(c => {
            if (Array.isArray(c.cargo) && myOrderNos.size) c.cargo = c.cargo.filter(g => g && myOrderNos.has(g.order_no));
          });
          // 6) containers_detail（车队/柜号/封号/皮重）：只本厂负责的 seq
          if (Array.isArray(sheet.containers_detail))
            sheet.containers_detail = sheet.containers_detail
              .filter(c => c && (seqs.size ? seqs.has(Number(c.seq)) : matchFac(c.factory)));
          else sheet.containers_detail = [];
          // 7) factory_loading_done：只本厂 label 的装货完毕状态
          if (sheet.factory_loading_done && typeof sheet.factory_loading_done === "object")
            sheet.factory_loading_done = sheet.factory_loading_done[lab] ? { [lab]: sheet.factory_loading_done[lab] } : {};
        } else {
          // ⛔ fail-closed：未限定工厂范围的链接绝不返回任何货物/订单/柜
          sheet.orders = []; sheet.factory_cargo = []; sheet.factory_entry = {};
          sheet.containers_live = []; sheet.containers_detail = []; sheet.factory_loading_done = {}; sheet.scope_missing = true;
        }
      }
      // supplier_portal 居间人/承包段：上游供应商(工厂/车队/报关)不得见下游客户。
      // 仅货代居间人(含 ocean 段) 与 出口商(field_profile=upstream_downstream) 可见。
      if (role === "supplier_portal") {
        const psegs = (portalScope && portalScope.segments) || [];
        const fprof = meta.field_profile || null;
        const seesCustomer = psegs.includes("ocean") || fprof === "upstream_downstream";
        if (!seesCustomer) { delete sheet.customer_name; delete sheet.customer_en; }
      }
      return sheet;
    })(),
    ...(factoryProfileAddress ? { factory_profile_address: factoryProfileAddress } : {}),
    factory_scope: factoryScope,
    portal_scope: portalScope,
  });
}

// ── POST /send-factory-link ────────────────────────────────────
async function handleSendFactoryLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, factory_label, container_seqs } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });
  // 多工厂分柜：factory_label=工厂名/代号, container_seqs=[1,2] 该厂负责的柜
  const scope = (factory_label && Array.isArray(container_seqs) && container_seqs.length)
    ? { label: String(factory_label).slice(0, 60),
        seqs: container_seqs.map(n => parseInt(n, 10)).filter(n => n > 0).slice(0, 50) }
    : null;

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;

  // Revoke：无 scope 撤全部；有 scope 只撤同一工厂的旧链接（多厂互不影响）
  if (scope) {
    await pool.query(
      `UPDATE magic_links SET revoked_at = NOW()
        WHERE recipient_role = 'factory_booking'
          AND (meta->>'shipment_id')::int = $1
          AND meta->'factory_scope'->>'label' = $2
          AND revoked_at IS NULL`,
      [numericId, scope.label]
    );
  } else {
    // 只撤无 scope 的普通链接；分厂链接（拼柜/分柜）不受普通重发影响
    await pool.query(
      `UPDATE magic_links SET revoked_at = NOW()
        WHERE recipient_role = 'factory_booking'
          AND (meta->>'shipment_id')::int = $1
          AND meta->'factory_scope' IS NULL
          AND revoked_at IS NULL`,
      [numericId]
    );
  }

  const raw = genRaw();
  const hash = rawToHash(raw);
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'factory_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id,
                            factory_scope: scope || undefined })]
  );
  await pool.query(
    `UPDATE shipping_plans SET factory_token = $1, collab_status = 'collab_open' WHERE id = $2`,
    [hash, numericId]
  );

  const link = `${APP_BASE}/public/collab-factory.html?token=${raw}`;
  return res.json({ ok: true, magic_link: link });
}

// ── POST /send-customer-link ───────────────────────────────────
async function handleSendCustomerLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;

  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'customer_booking'
        AND (meta->>'shipment_id')::int = $1
        AND revoked_at IS NULL`,
    [numericId]
  );

  const raw = genRaw();
  const hash = rawToHash(raw);
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'customer_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id })]
  );
  await pool.query(
    `UPDATE shipping_plans SET customer_token = $1 WHERE id = $2`,
    [hash, numericId]
  );

  const link = `${APP_BASE}/public/collab-customer.html?token=${raw}`;
  return res.json({ ok: true, magic_link: link });
}

// ── POST /set-factory-bill (Sanlyn内部) ───────────────────────
async function handleSetFactoryBill(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, amount_cny, pdf_url, note, sent_by } = req.body || {};
  if (!plan_id) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  if (amount_cny === undefined || amount_cny === null || amount_cny === "")
    return res.status(400).json({ ok: false, error: "amount_cny 必填" });

  const amount = Number(amount_cny);
  if (!Number.isFinite(amount))
    return res.status(400).json({ ok: false, error: "amount_cny 无效" });

  const planRow = await pool.query(
    `SELECT id, raw->>'factory_bill_current_version' AS factory_bill_current_version
       FROM shipping_plans
      WHERE _id = $1 OR id::text = $1
      LIMIT 1`,
    [String(plan_id)]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const numericId = planRow.rows[0].id;
  const currentVersion = parseInt(planRow.rows[0].factory_bill_current_version || "0", 10) || 0;
  const newVersion = currentVersion + 1;
  const billVersion = {
    version: newVersion,
    amount_cny: amount,
    pdf_url: pdf_url || null,
    note: note || null,
    sent_by: sent_by || null,
    sent_at: new Date().toISOString(),
  };

  await pool.query(
    `UPDATE shipping_plans SET raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object(
       'factory_bill_versions', COALESCE(raw->'factory_bill_versions','[]'::jsonb) || jsonb_build_array($1::jsonb),
       'factory_bill_current_version', $2::text,
       'finance_bill_sent_at', to_char(now(),'YYYY-MM-DD HH24:MI'),
       'finance_bill_sent_by', $3::text
     ), updated_at = now()
     WHERE id = $4`,
    [JSON.stringify(billVersion), String(newVersion), sent_by || null, numericId]
  );

  await emitBillTask(pool, numericId, newVersion, amount);
  return res.json({ ok: true, version: newVersion });
}

// ── POST /confirm-factory-bill (工厂 token) ───────────────────
async function handleConfirmFactoryBill(req, res, pool) {
  const { token, version } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'factory_booking'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!rows.length)
    return res.status(403).json({ ok: false, error: "链接无效或已过期" });

  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(500).json({ ok: false, error: "链接数据异常" });

  const billRes = await pool.query(
    `SELECT raw->>'factory_bill_current_version' AS factory_bill_current_version,
            raw->'factory_bill_versions' AS factory_bill_versions
       FROM shipping_plans
      WHERE id = $1
      LIMIT 1`,
    [planId]
  );
  if (!billRes.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const currentVersion = parseInt(billRes.rows[0].factory_bill_current_version || "0", 10) || 0;
  const confirmVersion = parseInt(version || currentVersion, 10);
  if (!confirmVersion) return res.status(400).json({ ok: false, error: "无可确认账单版本" });

  const versions = Array.isArray(billRes.rows[0].factory_bill_versions)
    ? billRes.rows[0].factory_bill_versions
    : [];
  const idx = versions.findIndex(v => parseInt(v && v.version, 10) === confirmVersion);
  if (idx < 0) return res.status(404).json({ ok: false, error: "找不到账单版本" });

  const confirmedAt = new Date().toISOString();
  const nextVersions = versions.map((v, i) => i === idx
    ? { ...v, confirmed_at: confirmedAt, confirmed_by: "factory" }
    : v);

  await pool.query(
    `UPDATE shipping_plans
        SET raw = jsonb_set(COALESCE(raw,'{}'::jsonb), '{factory_bill_versions}', $1::jsonb, true) ||
                  jsonb_build_object(
                    'factory_bill_confirmed_at', to_char(now(),'YYYY-MM-DD HH24:MI'),
                    'factory_bill_confirmed_by', 'factory'
                  ),
            updated_at = now()
      WHERE id = $2`,
    [JSON.stringify(nextVersions), planId]
  );

  await pool.query(
    `UPDATE tasks
        SET status = 'done', updated_at = NOW()
      WHERE raw->>'plan_id' = $1
        AND task_type = '账单确认'
        AND status <> 'done'`,
    [String(planId)]
  );

  return res.json({ ok: true });
}

// 工厂"选择订单"候选：fail-closed 只返回本 plan 已挂 ∪ 同客户未挂(confirmed/ready)，scoped 再按工厂过滤
async function loadFactoryOrderCandidates(pool, planId, fScope) {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_no, o.contract_no, o.customer, o.factory,
            o.total_qty AS cartons, COUNT(oli.id)::int AS item_count
       FROM shipping_plans sp
       JOIN orders o ON (
              o.shipping_plan_id = sp.id
              OR (
                o.shipping_plan_id IS NULL
                AND LOWER(COALESCE(o.status,'')) IN ('confirmed','ready')
                AND (
                  (BTRIM(COALESCE(sp.customer,'')) <> ''
                    AND LOWER(BTRIM(COALESCE(o.customer,''))) = LOWER(BTRIM(sp.customer)))
                  OR (BTRIM(COALESCE(sp.customer_en,'')) <> ''
                    AND LOWER(BTRIM(COALESCE(o.customer,''))) = LOWER(BTRIM(sp.customer_en)))
                )
              )
            )
       LEFT JOIN order_line_items oli ON oli.order_id = o.id
      WHERE sp.id = $1
      GROUP BY sp.id, o.id, o.order_no, o.contract_no, o.customer, o.factory, o.total_qty, o.shipping_plan_id
      ORDER BY (o.shipping_plan_id = sp.id) DESC, o.id DESC
      LIMIT 300`,
    [planId]
  );
  const lab = fScope && fScope.label ? String(fScope.label) : "";
  const matchFac = f => f && (String(f).includes(lab) || lab.includes(String(f)));
  const filtered = lab ? rows.filter(o => o && matchFac(o.factory)) : rows;
  return filtered.map(o => ({
    id: o.id,
    order_no: o.order_no || null,
    contract_no: o.contract_no || null,
    customer: o.customer || null,
    factory: o.factory || null,
    cartons: o.cartons != null ? Number(o.cartons) : null,
    item_count: Number(o.item_count || 0),
  }));
}

function normOrderNo(v) {
  return String(v || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// ── POST /factory-submit ──────────────────────────────────────
async function handleFactorySubmit(req, res, pool) {
  const { token, cargo_ready_date, container_type, cargo_type, remarks } = req.body || {};
  // 工厂自填分柜明细（订单没挂/明细缺失时）：raw.factory_cargo 留痕，绝不覆盖订单真值
  let factoryCargo = Array.isArray(req.body.containers) ? req.body.containers : null;
  if (factoryCargo) {
    factoryCargo = factoryCargo.slice(0, 200).map(function (x) {
      return {
        container_seq: parseInt(x.container_seq, 10) || 1,
        oli_id: x.oli_id ? parseInt(x.oli_id, 10) : null,
        cargo_name: String(x.cargo_name || "").slice(0, 200) || null,
        hs_code: String(x.hs_code || "").slice(0, 20) || null,
        pkg_qty: x.pkg_qty != null && x.pkg_qty !== "" ? Number(x.pkg_qty) : null,
        nw_kg: x.nw_kg != null && x.nw_kg !== "" ? Number(x.nw_kg) : null,
        gw_kg: x.gw_kg != null && x.gw_kg !== "" ? Number(x.gw_kg) : null,
        cbm_m3: x.cbm_m3 != null && x.cbm_m3 !== "" ? Number(x.cbm_m3) : null,
        // 价格铁律（2026-06-11 Damon）：工厂必须注明含税/未含税+点数；含税价=报关价；客户价=未含税×1.02
        ...(function () {
          const pr = x.price != null && x.price !== "" ? Number(x.price) : null;
          if (pr == null) return {};
          const pts = x.tax_points != null && x.tax_points !== "" ? Number(x.tax_points) : 11; // 工厂开票点数默认11(可自填)
          const taxed = x.price_type === "taxed";
          const untaxed = taxed ? +(pr / (1 + pts / 100)).toFixed(4) : pr;
          const invoicePrice = taxed ? pr : +(pr * (1 + pts / 100)).toFixed(4); // 工厂开票价=未含税×(1+点数)
          const qty = x.pkg_qty != null ? Number(x.pkg_qty) : null;
          return { price: pr, price_type: taxed ? "taxed" : "untaxed", tax_points: pts,
                   price_untaxed: untaxed,
                   invoice_price: invoicePrice,                              // 给工厂看的开票价(1.11档)
                   customs_price: +(untaxed * 1.13).toFixed(4),              // 报关价=未含税×1.13(固定)
                   customer_price: +(untaxed * 1.02).toFixed(4),             // 客户价=未含税×1.02
                   line_total_untaxed: qty ? +(untaxed * qty).toFixed(2) : null };
        })(),
      };
    }).filter(function (x) { return x.cargo_name || x.pkg_qty != null; });
    if (!factoryCargo.length) factoryCargo = null;
  }
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'factory_booking'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!rows.length)
    return res.status(403).json({ ok: false, error: "链接无效或已过期" });

  const role = rows[0].recipient_role;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  const fScope = meta.factory_scope || null;

  // 工厂"选择订单"候选（token scope 内，只读，不含金额）
  if (req.body && req.body.action === "list-orders") {
    const orders = await loadFactoryOrderCandidates(pool, planId, fScope);
    return res.json({ ok: true, orders: orders.map(o => ({
      order_no: o.order_no,
      contract_no: o.contract_no,
      customer: o.customer,
      factory: o.factory,
      cartons: o.cartons,
      item_count: o.item_count,
    })) });
  }

  // 工厂永久档案地址纠错：只能用工厂专属 token 推导本厂 companies 行，二次确认后写主数据并留痕。
  if (req.body && req.body.action === "update-factory-address") {
    if (role !== "factory_booking" || meta.preview === true || !(fScope && fScope.label))
      return res.status(403).json({ ok: false, error: "需工厂专属链接" });
    if (!planId)
      return res.status(400).json({ ok: false, error: "链接数据异常 — 缺少 shipment_id" });
    if (req.body.confirm !== true)
      return res.status(400).json({ ok: false, error: "需二次确认" });
    const newAddress = String(req.body.address || "").trim();
    if (!newAddress || newAddress.length > 200)
      return res.status(400).json({ ok: false, error: "地址不能为空且不能超过200字" });
    const label = String(fScope.label);
    const { rows: comps } = await pool.query(
      `SELECT id, name_cn, address
         FROM companies
        WHERE name_cn = $1 AND type = 'factory'
        ORDER BY id
        LIMIT 2`,
      [label]
    );
    if (!comps.length) return res.status(404).json({ ok: false, error: "未找到本厂档案" });
    if (comps.length > 1) return res.status(409).json({ ok: false, error: "档案不唯一，请联系 Sanlyn" });
    const company = comps[0];
    const audit = {
      at: new Date().toISOString(),
      factory_label: label,
      company_id: company.id,
      old: company.address || "",
      new: newAddress,
      source: "factory_portal",
      token_role: role,
    };
    await pool.query(
      `UPDATE companies SET address = $1, updated_at = now() WHERE id = $2`,
      [newAddress, company.id]
    );
    await pool.query(
      `UPDATE shipping_plans
          SET raw = jsonb_set(
            COALESCE(raw, '{}'::jsonb),
            '{factory_address_changes}',
            COALESCE(raw->'factory_address_changes', '[]'::jsonb) || jsonb_build_array($1::jsonb),
            true
          ),
          updated_at = now()
        WHERE id = $2`,
      [JSON.stringify(audit), planId]
    );
    return res.json({ ok: true, address: newAddress });
  }

  // 工厂关联订单（"选择订单"按钮 → factory_booking token 可用）
  if (req.body && req.body.action === "link-order") {
    const rawNo = String(req.body.order_no || req.body.contract_no || "").trim();
    if (!rawNo) return res.status(400).json({ ok: false, error: "order_no 必填" });
    const normNo = normOrderNo(rawNo);
    const candidates = await loadFactoryOrderCandidates(pool, planId, fScope);
    const ords = candidates.filter(o => normOrderNo(o.contract_no) === normNo || normOrderNo(o.order_no) === normNo);
    if (!ords.length)
      return res.status(403).json({ ok: false, error: "订单不在本链接可选范围内" });
    const addNo = (ords[0] && (ords[0].contract_no || ords[0].order_no)) || rawNo;
    const { rows: planRows } = await pool.query(
      "SELECT order_contract_nos FROM shipping_plans WHERE id = $1 LIMIT 1", [planId]);
    const rawVal = planRows[0] && planRows[0].order_contract_nos;
    const wasJson = typeof rawVal === "string" && rawVal.trim().startsWith("[");
    const parseNos = (v) => {
      if (Array.isArray(v)) return v;
      const s = String(v || "").trim(); if (!s) return [];
      if (s.startsWith("[")) { try { return JSON.parse(s); } catch (_) { return [s]; } }
      return s.split(",").map(x => x.trim());
    };
    const nos = [...new Set([...parseNos(rawVal), addNo].filter(Boolean))];
    // 保持原存储格式（JSON 数组 vs 逗号串），避免破坏订单解析
    const store = wasJson ? JSON.stringify(nos) : nos.join(",");
    await pool.query(
      "UPDATE shipping_plans SET order_contract_nos = $1, updated_at = now() WHERE id = $2",
      [store, planId]);
    if (ords.length)
      await pool.query("UPDATE orders SET shipping_plan_id = $1 WHERE id = ANY($2::int[])",
        [planId, ords.map(o => o.id)]);
    return res.json({ ok: true, order_no: addNo, linked: ords.length, order_contract_nos: nos });
  }

  // 绑单柜行写回订单主表 OLI（关联铁律：工厂补的就是订单明细，不进侧表死数据）
  if (factoryCargo) {
    const wbOrders = new Set();
    for (const ln of factoryCargo) {
      if (!ln.oli_id) continue;
      try {
        const { rows: wb } = await pool.query(
          `UPDATE order_line_items SET
             nw_ctn  = COALESCE(NULLIF(nw_ctn,0),  CASE WHEN $1::numeric > 0 AND $4::numeric > 0 THEN ROUND(($1/$4)::numeric, 4) END),
             gw_ctn  = COALESCE(NULLIF(gw_ctn,0),  CASE WHEN $2::numeric > 0 AND $4::numeric > 0 THEN ROUND(($2/$4)::numeric, 4) END),
             cbm_ctn = COALESCE(NULLIF(cbm_ctn,0), CASE WHEN $3::numeric > 0 AND $4::numeric > 0 THEN ROUND(($3/$4)::numeric, 6) END),
             factory_price = COALESCE(factory_price, $5),
             updated_at = now()
           WHERE id = $6 RETURNING order_id`,
          [ln.nw_kg, ln.gw_kg, ln.cbm_m3, ln.pkg_qty, ln.price_untaxed || null, ln.oli_id]);
        if (wb.length) wbOrders.add(wb[0].order_id);
      } catch (e) { console.error('[oli-writeback]', e.message); }
    }
  }

  // 工厂装柜过磅：container_weights=[{seq,weigh_kg}] → raw.factory_weights 留痕 + 柜表货重只填空
  if (Array.isArray(req.body.container_weights) && req.body.container_weights.length) {
    const fw = {};
    for (const w of req.body.container_weights) {
      const sq = parseInt(w.seq, 10), kg = Number(w.weigh_kg);
      if (!sq || !kg) continue;
      fw[sq] = { kg, at: new Date().toISOString().slice(0, 16).replace("T", " ") };
    }
    if (Object.keys(fw).length) {
      const { rows: pr2 } = await pool.query(
        `SELECT raw->'containers' AS cards FROM shipping_plans WHERE id = $1`, [planId]);
      const cards = (pr2[0] && pr2[0].cards) || [];
      for (const [sq, w] of Object.entries(fw)) {
        const cn = cards[Number(sq) - 1] && cards[Number(sq) - 1].container_no;
        if (cn) {
          await pool.query(
            `UPDATE container_bookings SET cargo_weight_kg = COALESCE(cargo_weight_kg, $1), updated_at = now()
              WHERE shipping_plan_id = $2 AND container_no = $3`, [w.kg, planId, cn]).catch(() => {});
          // NW/GW 自动归整：该柜绑定订单的明细行 GW 缺失 → 过磅货重按箱数比例分摊；金额绝不动
          try {
            const { rows: bound } = await pool.query(
              `SELECT o.id AS oid FROM container_bookings cb JOIN orders o ON o.contract_no = cb.contract_no
                WHERE cb.shipping_plan_id = $1 AND cb.container_no = $2 AND cb.contract_no IS NOT NULL`, [planId, cn]);
            for (const b of bound) {
              const { rows: st } = await pool.query(
                `SELECT SUM(qty_ctn) FILTER (WHERE COALESCE(gw_ctn,0)=0) AS q_miss,
                        SUM(COALESCE(gw_ctn,0)*qty_ctn) AS gw_known
                   FROM order_line_items WHERE order_id = $1`, [b.oid]);
              const qMiss = Number(st[0].q_miss || 0), gwKnown = Number(st[0].gw_known || 0);
              const remain = w.kg - gwKnown;
              if (qMiss > 0 && remain > 0) {
                const per = +(remain / qMiss).toFixed(4);
                await pool.query(
                  `UPDATE order_line_items SET gw_ctn = $1, cbm_source = COALESCE(cbm_source,'') || ' gw:weigh-derived'
                    WHERE order_id = $2 AND COALESCE(gw_ctn,0)=0`, [per, b.oid]);
              }
            }
          } catch (e) { console.error('[weigh-normalize]', e.message); }
        }
      }
      await pool.query(
        `UPDATE shipping_plans SET raw = COALESCE(raw,'{}'::jsonb) ||
           jsonb_build_object('factory_weights', COALESCE(raw->'factory_weights','{}'::jsonb) || $1::jsonb)
         WHERE id = $2`, [JSON.stringify(fw), planId]);
    }
  }

  // 入厂要求登记（工厂固定属性：联系人/电话/要求/考试链接）——票级留痕 + 工厂档案永久复用
  if (req.body && req.body.entry_req && typeof req.body.entry_req === "object") {
    const er = req.body.entry_req;
    const clean = {
      contact: String(er.contact || "").slice(0, 40) || null,
      phone: String(er.phone || "").slice(0, 20) || null,
      note: String(er.note || "").slice(0, 300) || null,
      exam_url: String(er.exam_url || "").slice(0, 300) || null,
      label: (fScope && fScope.label) || String(er.label || "").slice(0, 60) || "default",
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
    };
    await pool.query(
      `UPDATE shipping_plans SET raw = COALESCE(raw,'{}'::jsonb) ||
         jsonb_build_object('factory_entry',
           COALESCE(raw->'factory_entry','{}'::jsonb) || jsonb_build_object($1::text, $2::jsonb))
       WHERE id = $3`, [clean.label, JSON.stringify(clean), planId]);
    // 工厂档案固定（customers 表按名匹配，填一次以后票自动带出）
    try {
      await pool.query(
        `UPDATE customers SET raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('entry_req', $1::jsonb)
          WHERE portal_role = 'factory' AND (name_cn ILIKE '%'||$2||'%' OR $2 ILIKE '%'||name_cn||'%')`,
        [JSON.stringify(clean), clean.label]);
    } catch (e) {}
    if (!req.body.partial && !req.body.cargo_ready_date && !req.body.containers)
      return res.json({ ok: true, entry_req: clean });
  }

  // 选了即存：条款/拖报委托 partial 保存（不标记已提交、不动货物）
  if (req.body && req.body.partial === true) {
    await pool.query(
      `UPDATE shipping_plans SET
         freight_term     = COALESCE($1, freight_term),
         trucking_arrange = COALESCE($2, trucking_arrange),
         customs_arrange  = COALESCE($3, customs_arrange),
         updated_at = now()
       WHERE id = $4`,
      [req.body.freight_term || null, req.body.trucking_arrange || null, req.body.customs_arrange || null, planId]);
    const { rows: cur } = await pool.query(
      `SELECT freight_term, trucking_arrange, customs_arrange FROM shipping_plans WHERE id = $1`, [planId]);
    return res.json({ ok: true, partial: true, ...cur[0] });
  }

  // 多工厂：scope 模式下 factory_cargo 只替换本厂柜段，保留他厂
  if (fScope && factoryCargo) {
    const seqs = new Set(fScope.seqs || []);
    const bad = factoryCargo.find(x => !seqs.has(x.container_seq));
    if (bad) return res.status(403).json({ ok: false, error: `柜 ${bad.container_seq} 不在贵厂负责范围（${[...seqs].join(",")}）` });
    const { rows: cur } = await pool.query(
      `SELECT raw->'factory_cargo' AS fc FROM shipping_plans WHERE id = $1`, [planId]);
    const existing = Array.isArray(cur[0] && cur[0].fc) ? cur[0].fc : [];
    // 按厂标合并：删本厂旧行，保留他厂（含拼柜同柜号的他厂行）
    factoryCargo = existing.filter(x => x.factory_label !== fScope.label)
      .concat(factoryCargo.map(x => ({ ...x, factory_label: fScope.label })));
  } else if (fScope && !factoryCargo) {
    // scope 厂没交明细也不能清掉别人的
  }
  let myLabel = fScope ? fScope.label : "_single";
  if (!fScope) {
    // 无scope提交:单厂票归真实厂名,杜绝"_single"幽灵工厂(2026-07-03)
    const { rows: facR } = await pool.query(
      `SELECT DISTINCT factory FROM orders WHERE shipping_plan_id=$1 AND factory IS NOT NULL AND factory<>''`, [planId]);
    if (facR.length === 1 && facR[0].factory) myLabel = facR[0].factory;
  }
  const submitRec = JSON.stringify({ [myLabel]: {
    cargo_ready: cargo_ready_date || null, at: new Date().toISOString() } });

  // 拼柜/分柜：整票货好 = 各厂最晚（含本次）；单厂沿用本次值
  let effectiveReady = cargo_ready_date || null;
  if (fScope) {
    const { rows: subCur } = await pool.query(
      `SELECT raw->'factory_submits' AS fs FROM shipping_plans WHERE id = $1`, [planId]);
    const fs = (subCur[0] && subCur[0].fs) || {};
    fs[myLabel] = { cargo_ready: cargo_ready_date || null };
    const dates = Object.values(fs).map(x => x && x.cargo_ready).filter(Boolean).sort();
    effectiveReady = dates.length ? dates[dates.length - 1] : null;
  }

  const updRes = await pool.query(
    `UPDATE shipping_plans SET
       factory_submitted      = true,
       factory_cargo_ready    = $1,
       factory_container_type = $2,
       factory_cargo_type     = $3,
       factory_remarks        = $4,
       factory_submitted_at   = NOW(),
       freight_term      = COALESCE($7, freight_term),      -- 三方可改(2026-06-11纠正)
       trucking_arrange  = COALESCE($8, trucking_arrange),
       customs_arrange   = COALESCE($9, customs_arrange),
       raw = COALESCE(raw,'{}'::jsonb)
             || CASE WHEN $6::jsonb IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('factory_cargo', $6::jsonb) END
             || CASE WHEN $10::jsonb IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('factory_attrs', $10::jsonb) END
             || CASE WHEN $11::jsonb IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('factory_submits',
                  COALESCE(raw->'factory_submits','{}'::jsonb) || $11::jsonb) END
     WHERE id = $5
     RETURNING freight_term, trucking_arrange, customs_arrange, factory_cargo_ready`,
    [effectiveReady, container_type || null, cargo_type || null, remarks || null, planId,
     factoryCargo ? JSON.stringify(factoryCargo) : null,
     ["FOB","EXW","FCA","CIF","DDP","CNF"].includes(req.body.freight_term) ? req.body.freight_term : null,
     ["agent","babi","factory","self"].includes(req.body.trucking_arrange) ? req.body.trucking_arrange : null,
     ["agent","babi","factory","self"].includes(req.body.customs_arrange) ? req.body.customs_arrange : null,
     (req.body.attrs && typeof req.body.attrs === "object" && !Array.isArray(req.body.attrs))
       ? JSON.stringify({
           battery: req.body.attrs.battery === "yes" ? "yes" : "no",
           wood_packaging: req.body.attrs.wood_packaging === "yes" ? "yes" : "no",
           fumigation: ["yes","no"].includes(req.body.attrs.fumigation) ? req.body.attrs.fumigation : null,
         }) : null,
     submitRec]
  );

  // Insert into collab hub queue
  const planRow = await pool.query(
    `SELECT shipment_no, customer FROM shipping_plans WHERE id = $1`, [planId]
  );
  const planInfo = planRow.rows[0] || {};
  await pool.query(
    `INSERT INTO booking_collab_sheets
       (shipping_plan_id, order_no, contract_no, owner_company_code,
        submitter_role, factory_remarks, status, submitted_at)
     VALUES ($1,$2,$3,$4,'factory_booking',$5,'submitted',NOW())`,
    [planId, planInfo.shipment_no || null, planInfo.shipment_no || null,
     'SANLYN', remarks || null]
  ).catch(() => {}); // non-blocking

  const fin = (updRes.rows && updRes.rows[0]) || {};
  return res.json({ ok: true,
    freight_term: fin.freight_term || null,
    trucking_arrange: fin.trucking_arrange || null,
    customs_arrange: fin.customs_arrange || null,
    factory_cargo_ready: fin.factory_cargo_ready || null });
}

// ── POST /customer-submit ─────────────────────────────────────
async function handleCustomerSubmit(req, res, pool) {
  const { token, selected_sailing, reference_no, remarks } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });
  if (!selected_sailing || typeof selected_sailing !== "object")
    return res.status(400).json({ ok: false, error: "selected_sailing 必填" });

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'customer_booking'
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!rows.length)
    return res.status(403).json({ ok: false, error: "链接无效或已过期" });

  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);

  await pool.query(
    `UPDATE shipping_plans SET
       customer_submitted        = true,
       customer_selected_sailing = $1,
       customer_reference_no     = $2,
       customer_remarks          = $3,
       customer_submitted_at     = NOW(),
       vessel                    = $4,
       voyage                    = $5,
       etd                       = $6,
       freight_term = COALESCE($8, freight_term),  -- 三方可改
       -- 已确认过再提交 = 改单：计数+留痕（船司改单费以账单为准）
       raw = CASE WHEN customer_submitted = true THEN
               COALESCE(raw,'{}'::jsonb) || jsonb_build_object('customer_amend',
                 jsonb_build_object(
                   'count', COALESCE((raw->'customer_amend'->>'count')::int, 0) + 1,
                   'last_at', to_char(now(), 'YYYY-MM-DD HH24:MI'),
                   'last_vessel', $4::text))
             ELSE raw END
     WHERE id = $7`,
    [
      JSON.stringify(selected_sailing),
      reference_no || null,
      remarks       || null,
      selected_sailing.vessel || null,
      selected_sailing.voyage || null,
      selected_sailing.etd    || null,
      planId,
      ["FOB","EXW","FCA","CIF","DDP","CNF"].includes((req.body||{}).freight_term) ? req.body.freight_term : null,
    ]
  );

  // Insert into collab hub queue
  const planRow2 = await pool.query(
    `SELECT shipment_no, customer FROM shipping_plans WHERE id = $1`, [planId]
  );
  const planInfo2 = planRow2.rows[0] || {};
  await pool.query(
    `INSERT INTO booking_collab_sheets
       (shipping_plan_id, order_no, contract_no, owner_company_code,
        submitter_role, customer_remarks, vessel, etd, status, submitted_at)
     VALUES ($1,$2,$3,$4,'customer_booking',$5,$6,$7,'submitted',NOW())`,
    [planId, planInfo2.shipment_no || null, planInfo2.shipment_no || null,
     'SANLYN', remarks || null,
     selected_sailing.vessel || null,
     selected_sailing.etd    || null]
  ).catch(() => {}); // non-blocking

  return res.json({ ok: true });
}

// ── GET /sailings?token=<raw> ─────────────────────────────────
async function handleGetSailings(req, res, pool) {
  const raw = req.query && req.query.token;
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });

  const hash = rawToHash(raw);
  const { rows: lnk } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role IN ('factory_booking','customer_booking')
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!lnk.length) return res.status(403).json({ ok: false, error: "链接无效" });

  const meta = (typeof lnk[0].meta === "string" ? JSON.parse(lnk[0].meta) : lnk[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);

  const { rows } = await pool.query(
    `SELECT id, carrier, vessel, voyage, etd, eta, cutoff_date, rate_usd, currency, is_recommended
       FROM plan_sailings
      WHERE shipping_plan_id = $1
      ORDER BY etd ASC`,
    [planId]
  );
  return res.json({ ok: true, rows });
}

// ── POST /sailings (Sanlyn内部) ───────────────────────────────
async function handlePostSailing(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, freight_quote_id, carrier, vessel, voyage,
          etd, eta, cutoff_date, rate_usd, currency, is_recommended } = req.body || {};
  if (!plan_id || !carrier || !etd)
    return res.status(400).json({ ok: false, error: "plan_id / carrier / etd 必填" });

  // Accept either integer id or varchar _id
  let numericId;
  if (/^\d+$/.test(String(plan_id))) {
    numericId = parseInt(plan_id, 10);
  } else {
    const r = await pool.query(`SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
    numericId = r.rows[0].id;
  }

  const r = await pool.query(
    `INSERT INTO plan_sailings
       (shipping_plan_id, freight_quote_id, carrier, vessel, voyage,
        etd, eta, cutoff_date, rate_usd, currency, is_recommended)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [numericId, freight_quote_id || null, carrier, vessel || null, voyage || null,
     etd, eta || null, cutoff_date || null, rate_usd || null, currency || "USD", is_recommended || false]
  );
  return res.json({ ok: true, id: r.rows[0].id });
}

// ── GET /plan/:id  (Sanlyn内部 JWT) ──────────────────────────
async function handleGetPlan(req, res, pool, planId) {
  if (!requireAuth(req, res)) return;
  const numId = parseInt(planId, 10);
  if (!numId) return res.status(400).json({ ok: false, error: "无效 plan id" });

  const planRes = await pool.query(
    `SELECT sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta,
            sp.vessel, sp.voyage, sp.container_type, sp.collab_status,
            sp.customer AS customer_name, sp.customer_en,
            sp.factory_submitted, sp.factory_cargo_ready, sp.factory_container_type,
            sp.factory_cargo_type, sp.factory_remarks, sp.factory_submitted_at,
            sp.customer_submitted, sp.customer_selected_sailing, sp.customer_reference_no,
            sp.customer_remarks, sp.customer_submitted_at,
            sp.raw->'factory_bill_versions' AS factory_bill_versions,
            sp.raw->>'factory_bill_current_version' AS factory_bill_current_version,
            sp.raw->>'finance_bill_sent_at' AS finance_bill_sent_at,
            sp.raw->>'finance_bill_sent_by' AS finance_bill_sent_by,
            sp.raw->>'factory_bill_confirmed_at' AS factory_bill_confirmed_at,
            sp.raw->>'factory_bill_confirmed_by' AS factory_bill_confirmed_by,
            sp.raw->>'prebill_status' AS prebill_status,
            sp.raw->>'prebill_confirmed_at' AS prebill_confirmed_at,
            sp.raw->'pricing_decisions' AS pricing_decisions,
            COALESCE(
              json_agg(
                json_build_object(
                  'order_no', o.order_no,
                  'items', (
                    SELECT COALESCE(json_agg(json_build_object(
                      'sku', oli.sku, 'description', oli.declaration_name,
                      'hs_code', oli.hs_code, 'ctns', oli.qty_ctn, 'gw_kgs', oli.gw_ctn
                    )), '[]'::json)
                    FROM order_line_items oli WHERE oli.order_id = o.id
                  )
                )
              ) FILTER (WHERE o.id IS NOT NULL), '[]'::json
            ) AS orders
       FROM shipping_plans sp
       LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      WHERE sp.id = $1
      GROUP BY sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta,
               sp.vessel, sp.voyage, sp.container_type, sp.collab_status,
               sp.customer, sp.customer_en,
               sp.factory_submitted, sp.factory_cargo_ready, sp.factory_container_type,
               sp.factory_cargo_type, sp.factory_remarks, sp.factory_submitted_at,
               sp.customer_submitted, sp.customer_selected_sailing, sp.customer_reference_no,
               sp.customer_remarks, sp.customer_submitted_at`,
    [numId]
  );
  if (!planRes.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const sailingsRes = await pool.query(
    `SELECT id, carrier, vessel, voyage, etd, eta, cutoff_date, rate_usd, currency, is_recommended
       FROM plan_sailings WHERE shipping_plan_id = $1 ORDER BY etd ASC`,
    [numId]
  );
  return res.json({ ok: true, booking_sheet: { ...planRes.rows[0], sailings: sailingsRes.rows } });
}

// ── PATCH /plan/:id (Sanlyn内部 JWT) — 直接改字段 ────────────
async function handlePatchPlan(req, res, pool, planId) {
  if (!requireAuth(req, res)) return;
  const numId = parseInt(planId, 10);
  if (!numId) return res.status(400).json({ ok: false, error: "无效 plan id" });

  const allowed = ["collab_status","vessel","voyage","etd","eta","container_type",
                   "factory_cargo_ready","factory_container_type","factory_cargo_type","factory_remarks"];
  const sets = [], vals = [];
  const body = req.body || {};
  for (const k of allowed) {
    if (k in body) { vals.push(body[k]); sets.push(`${k} = $${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: "没有可更新的字段" });
  vals.push(numId);
  await pool.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
}

// ── DELETE /sailings/:id (Sanlyn内部) ────────────────────────
async function handleDeleteSailing(req, res, pool, sailingId) {
  if (!requireAuth(req, res)) return;
  if (!sailingId) return res.status(400).json({ ok: false, error: "sailing id 必填" });
  await pool.query(`DELETE FROM plan_sailings WHERE id = $1`, [sailingId]);
  return res.json({ ok: true });
}


// ── GET /plans-list?q=... (Sanlyn内部 JWT) ───────────────────
async function handlePlansList(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const q = (req.query && req.query.q) || "";
  const { rows } = await pool.query(
    `SELECT sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod,
            sp.etd, sp.customer, sp.customer_en, sp.vessel, sp.voyage,
            sp.collab_status, sp.container_type, sp.factory_cargo_ready,
            COUNT(o.id) AS order_count
       FROM shipping_plans sp
       LEFT JOIN orders o ON o.shipping_plan_id = sp.id
      WHERE ($1 = ''
          OR sp.shipment_no ILIKE '%' || $1 || '%'
          OR sp.customer    ILIKE '%' || $1 || '%'
          OR sp.customer_en ILIKE '%' || $1 || '%')
      GROUP BY sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod,
               sp.etd, sp.customer, sp.customer_en, sp.vessel, sp.voyage,
               sp.collab_status, sp.container_type, sp.factory_cargo_ready
      ORDER BY sp.id DESC
      LIMIT 15`,
    [q]
  );
  return res.json({ ok: true, plans: rows });
}

// ── Main handler ──────────────────────────────────────────────
// ── POST /send-trucking-link | /send-broker-link ──────────────
// 车队/报关行单任务链接。自拖自报时由客户转发给他们自己的车队/报关行。
async function handleSendRoleLink(req, res, pool, role) {
  if (!requireAuth(req, res)) return;
  const { plan_id } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;
  const recipientRole = role + "_booking";

  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = $1
        AND (meta->>'shipment_id')::int = $2
        AND revoked_at IS NULL`,
    [recipientRole, numericId]
  );

  const raw = genRaw();
  const hash = rawToHash(raw);
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, recipientRole, JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id })]
  );

  const page = role === "trucking" ? "collab-trucking.html" : "collab-broker.html";
  const link = `${APP_BASE}/public/${page}?token=${raw}`;
  return res.json({ ok: true, magic_link: link });
}

// ── POST /customer-notes ──────────────────────────────────────
// 客户对货物行的备注（同步给船司/Sanlyn 报关）。自动保存，无需提交。
async function handleCustomerNotes(req, res, pool) {
  const { token, notes, freight_term, fe_request } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });
  if (req.body.prebill_status === 'confirmed') {
    const hashPb = rawToHash(token);
    const { rows: mlPb } = await pool.query(
      `SELECT meta FROM magic_links WHERE token_hash=$1 AND recipient_role='customer_booking'
       AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`, [hashPb]);
    if (!mlPb.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
    const pidPb = parseInt((typeof mlPb[0].meta==='string'?JSON.parse(mlPb[0].meta):mlPb[0].meta).shipment_id,10);
    await pool.query(
      `UPDATE shipping_plans SET raw = COALESCE(raw,'{}') || jsonb_build_object(
         'prebill_status','confirmed',
         'prebill_confirmed_at', to_char(now(),'YYYY-MM-DD HH24:MI')
       ) WHERE id = $1`, [pidPb]);
    return res.json({ ok: true });
  }
  // FE 东南亚原产地证申请：费率走 local_charges 标准（FE_CERT_SERVICE），邮费到付自费
  if (fe_request !== undefined && fe_request !== null) {
    const hashF = rawToHash(token);
    const { rows: mlF } = await pool.query(
      `SELECT meta FROM magic_links WHERE token_hash=$1 AND recipient_role='customer_booking'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`, [hashF]);
    if (!mlF.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
    const pidF = parseInt((typeof mlF[0].meta === "string" ? JSON.parse(mlF[0].meta) : mlF[0].meta).shipment_id, 10);
    // 代购单必办，不允许取消
    const { rows: dg } = await pool.query(
      `SELECT 1 FROM orders WHERE shipping_plan_id=$1 AND export_mode='daigou' LIMIT 1`, [pidF]);
    if (dg.length && fe_request === false)
      return res.status(400).json({ ok: false, error: "代购单 FE 产地证为必办项，不可取消" });
    const { rows: std } = await pool.query(
      `SELECT amount, currency, notes FROM local_charges WHERE charge_code='FE_CERT_SERVICE' LIMIT 1`);
    if (!std.length) return res.status(500).json({ ok: false, error: "FE 收费标准未配置（local_charges FE_CERT_SERVICE）" });
    const unitFee = Number(std[0].amount), cur = std[0].currency || "CNY";
    // 按行勾选：lines = { "<barcode或sku>": true } → 证数 = 勾中行所属工厂数（按工厂拆报关单=拆证）
    const feLines = (req.body.fe_lines && typeof req.body.fe_lines === "object") ? req.body.fe_lines : null;
    let certCount = 1;
    if (feLines && fe_request) {
      const keys = Object.keys(feLines).filter(k => feLines[k]);
      if (!keys.length) return res.status(400).json({ ok: false, error: "请至少勾选一行商品" });
      const { rows: fc } = await pool.query(
        `SELECT COUNT(DISTINCT o.factory) AS n FROM order_line_items oli
           JOIN orders o ON o.id = oli.order_id
          WHERE o.shipping_plan_id = $1 AND (oli.barcode = ANY($2) OR oli.sku = ANY($2))`, [pidF, keys]);
      certCount = Math.max(1, Number(fc[0].n) || 1);
    }
    const fee = unitFee * (fe_request ? certCount : 0);
    const feObj = fe_request
      ? { requested: true, fee, unit_fee: unitFee, cert_count: certCount, currency: cur,
          lines: feLines || null, postage: "快递到付·客户自费", by: "customer",
          at: new Date().toISOString().slice(0, 16).replace("T", " ") }
      : { requested: false, by: "customer", at: new Date().toISOString().slice(0, 16).replace("T", " ") };
    // cost_lines 维护：申请=加 FE 行（卖价=标准价），取消=移除该行；只动 FE 行不碰其他
    await pool.query(
      `UPDATE shipping_plans SET raw = jsonb_set(
         COALESCE(raw,'{}'::jsonb) || jsonb_build_object('fe_cert', $1::jsonb),
         '{cost_lines}',
         (SELECT COALESCE(jsonb_agg(l), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(raw->'cost_lines','[]'::jsonb)) l
           WHERE l->>'name' <> 'FE原产地证费')
         || CASE WHEN $2::boolean THEN jsonb_build_array(jsonb_build_object(
              'name','FE原产地证费','cost','','sale',$3::numeric,'currency',$4::text,'remark',$6::text))
            ELSE '[]'::jsonb END),
         updated_at = now()
       WHERE id = $5`,
      [JSON.stringify(feObj), !!fe_request, fee, cur, pidF,
       (feObj.cert_count > 1 ? `${feObj.cert_count}份证 × ${unitFee} · ` : "") + "邮费快递到付·客户自费"]);
    return res.json({ ok: true, fe_cert: feObj });
  }
  // 三方可改条款：客户改了就写 + 留痕（谁/何时/旧→新）
  if (freight_term && (!notes || !Object.keys(notes).length)) {
    const hash0 = rawToHash(token);
    const { rows: ml0 } = await pool.query(
      `SELECT meta FROM magic_links WHERE token_hash=$1 AND recipient_role='customer_booking'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`, [hash0]);
    if (!ml0.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
    const pid0 = parseInt((typeof ml0[0].meta === "string" ? JSON.parse(ml0[0].meta) : ml0[0].meta).shipment_id, 10);
    const tt = String(freight_term).slice(0, 10).toUpperCase();
    await pool.query(
      `UPDATE shipping_plans SET freight_term = $1,
         raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('term_log',
           COALESCE(raw->'term_log','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'by','customer','from',freight_term,'to',$1::text,'at',to_char(now(),'YYYY-MM-DD HH24:MI')))),
         updated_at = now()
       WHERE id = $2`, [tt, pid0]);
    return res.json({ ok: true, freight_term: tt });
  }
  if (!notes || typeof notes !== "object" || Array.isArray(notes))
    return res.status(400).json({ ok: false, error: "notes 必须是 {sku: 备注} 对象" });

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role = 'customer_booking'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [hash]
  );
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(500).json({ ok: false, error: "链接数据异常" });

  // 只收字符串、限长，键数限 50（防滥写）
  const clean = {};
  for (const [k, v] of Object.entries(notes).slice(0, 50)) {
    clean[String(k).slice(0, 64)] = String(v == null ? "" : v).slice(0, 500);
  }
  const ft = ["FOB","EXW","FCA","CIF","DDP","CNF"].includes(req.body.freight_term)
    ? req.body.freight_term : null;
  const { rows: upd } = await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw,'{}'::jsonb) ||
                  jsonb_build_object('customer_item_notes',
                    COALESCE(raw->'customer_item_notes','{}'::jsonb) || $1::jsonb),
            freight_term = COALESCE($3, freight_term),  -- 三方可改
            updated_at = now()
      WHERE id = $2
      RETURNING freight_term`,
    [JSON.stringify(clean), planId, ft]
  );
      // 客户写了改品名/HS备注 → 提醒 Sanlyn（有备注必有人看）
    try {
      const noteTxt = Object.entries(notes).filter(([k, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
      if (noteTxt) {
        const { rows: pn } = await pool.query(`SELECT shipment_no FROM shipping_plans WHERE id = $1`, [planId]);
        fetch("https://ntfy.sh/sanlyn-damon-alert", { method: "POST",
          headers: { Title: encodeURIComponent(`客户备注 ${(pn[0]||{}).shipment_no||""}`), Priority: "default" },
          body: `客户在协同页写了备注（可能要求改品名/HS）：\n${noteTxt.slice(0,500)}` }).catch(() => {});
      }
    } catch (e) {}
return res.json({ ok: true, freight_term: upd[0] ? upd[0].freight_term : null });
}

// ── POST /trucking-submit ─────────────────────────────────────
// 车队回填：车牌/司机/电话/提箱时间 → shipping_plans.trucking_detail (jsonb merge)
async function handleTruckingSubmit(req, res, pool) {
  const { token, plate, driver, driver_phone, pickup_time, remarks } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });
  // 多车数组优先；兼容旧平铺字段
  let vehicles = Array.isArray(req.body.vehicles) ? req.body.vehicles : null;
  if (vehicles) {
    vehicles = vehicles
      .map((v, i) => ({
        seq: i + 1,
        plate: String(v.plate || "").trim() || null,
        driver: String(v.driver || "").trim() || null,
        driver_phone: String(v.driver_phone || "").trim() || null,
        pickup_time: v.pickup_time || null,
        loading_time: v.loading_time || null,
        cntr: String(v.cntr || "").trim().toUpperCase() || null,
        seal_no: String(v.seal_no || "").trim().toUpperCase() || null,
        trailer_plate: String(v.trailer_plate || "").trim() || null,
        driver_id_no: String(v.driver_id_no || "").trim() || null,
        weigh_kg: (v.weigh_kg !== undefined && v.weigh_kg !== null && v.weigh_kg !== "") ? Number(v.weigh_kg) : null,
      }))
      .filter(v => v.plate || v.driver_phone);
    if (!vehicles.length)
      return res.status(400).json({ ok: false, error: "至少一辆车需填车牌或司机电话" });
  } else if (!plate && !driver_phone) {
    return res.status(400).json({ ok: false, error: "车牌或司机电话至少填一项" });
  }

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role IN ('trucking_booking','supplier_portal')
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [hash]
  );
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  if (rows[0].recipient_role === 'supplier_portal' &&
      !(meta.segments || []).includes('truck'))
    return res.status(403).json({ ok: false, error: "贵司端口未承包车队段" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(500).json({ ok: false, error: "链接数据异常" });

  // 过磅重→柜表（真值写回；箱封号只填空防覆盖）
  // 失败/柜号不匹配 → cb_warnings 红标留痕，绝不静默吞掉
  const cbWarnings = [];
  if (vehicles) {
    for (const v of vehicles) {
      if (!v.cntr) continue;
      try {
        const r = await pool.query(
          `UPDATE container_bookings SET
             vgm_weight_kg = COALESCE($1, vgm_weight_kg),
             seal_no = COALESCE(NULLIF(seal_no,''), $2),
             truck_plate = COALESCE(NULLIF(truck_plate,''), $3),
             trailer_plate = COALESCE(NULLIF(trailer_plate,''), $6),
             driver_name = COALESCE(NULLIF(driver_name,''), $7),
             driver_phone = COALESCE(NULLIF(driver_phone,''), $8),
             pickup_time = COALESCE(pickup_time, $9::timestamptz),
             updated_at = now()
           WHERE shipping_plan_id = $4 AND container_no = $5`,
          [v.weigh_kg, v.seal_no, v.plate, planId, v.cntr,
           v.trailer_plate, v.driver, v.driver_phone, v.pickup_time || null]);
        if (r.rowCount === 0)
          cbWarnings.push({ cntr: v.cntr, reason: "柜号在本票订舱柜表无匹配，未回写，请核对柜号" });
      } catch (e) {
        console.error("[trucking-cb-writeback]", v.cntr, e.message);
        cbWarnings.push({ cntr: v.cntr, reason: "柜表回写失败: " + e.message });
      }
    }
  } else if (plate || driver_phone) {
    // 单车平铺路径：该票恰好一柜时回写那一柜；多柜无柜号 → 红标不盲写
    try {
      const { rows: cbs } = await pool.query(
        `SELECT id, container_no FROM container_bookings WHERE shipping_plan_id = $1`, [planId]);
      if (cbs.length === 1) {
        await pool.query(
          `UPDATE container_bookings SET
             truck_plate = COALESCE(NULLIF(truck_plate,''), $1),
             driver_name = COALESCE(NULLIF(driver_name,''), $2),
             driver_phone = COALESCE(NULLIF(driver_phone,''), $3),
             pickup_time = COALESCE(pickup_time, $4::timestamptz),
             updated_at = now()
           WHERE id = $5`,
          [plate || null, driver || null, driver_phone || null, pickup_time || null, cbs[0].id]);
      } else if (cbs.length > 1) {
        cbWarnings.push({ cntr: null, reason: "本票多柜但提交未带柜号，柜表未回写，请按柜逐一填报" });
      }
    } catch (e) {
      console.error("[trucking-cb-writeback:single]", e.message);
      cbWarnings.push({ cntr: null, reason: "柜表回写失败: " + e.message });
    }
  }

  const detail = vehicles
    ? { vehicles, remarks: remarks || null,
        submitted_at: new Date().toISOString(), source: "trucking_booking_link" }
    : { plate: plate || null, driver: driver || null,
        driver_phone: driver_phone || null, pickup_time: pickup_time || null,
        remarks: remarks || null, submitted_at: new Date().toISOString(),
        source: "trucking_booking_link" };
  detail.cb_warnings = cbWarnings.length ? cbWarnings : null;
  await pool.query(
    `UPDATE shipping_plans
        SET trucking_detail = COALESCE(trucking_detail, '{}'::jsonb) || $1::jsonb,
            updated_at = now()
      WHERE id = $2`,
    [JSON.stringify(detail), planId]
  );
  return res.json({ ok: true, cb_warnings: cbWarnings });
}

// ── POST /broker-submit ───────────────────────────────────────
// 报关行确认接单：确认 + 备注/缺资料 → shipping_plans.raw.broker_ack
async function handleBrokerSubmit(req, res, pool) {
  const { token, confirmed, remarks, missing_docs } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });

  const hash = rawToHash(token);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role IN ('broker_booking','supplier_portal')
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [hash]
  );
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  if (rows[0].recipient_role === 'supplier_portal' &&
      !(meta.segments || []).includes('customs'))
    return res.status(403).json({ ok: false, error: "贵司端口未承包报关段" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(500).json({ ok: false, error: "链接数据异常" });

  const ack = { broker_ack: {
    confirmed: confirmed !== false, remarks: remarks || null,
    missing_docs: missing_docs || null, submitted_at: new Date().toISOString(),
  }};
  await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw, '{}'::jsonb) || $1::jsonb, updated_at = now()
      WHERE id = $2`,
    [JSON.stringify(ack), planId]
  );
  return res.json({ ok: true });
}

// ── POST /send-portal-link — 供应链端口（一司一链接，多段合一）──
// segments: ['ocean','truck','customs'] 子集；自拖自报票默认只给 ocean
async function handleSendPortalLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, segments, company_label } = req.body || {};
  if (!plan_id)
    return res.status(400).json({ ok: false, error: "plan_id 必填 (shipping_plans._id)" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;
  const segs = (Array.isArray(segments) ? segments : ["ocean", "truck", "customs"])
    .filter(s => ["ocean", "truck", "customs"].includes(s));
  if (!segs.length) return res.status(400).json({ ok: false, error: "segments 至少一段" });

  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1 AND revoked_at IS NULL
        AND COALESCE(meta->>'company_label','') = COALESCE($2,'')`,
    [numericId, company_label || ""]);

  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'supplier_portal', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({ shipment_id: numericId, plan_business_id: plan_id,
      segments: segs, company_label: String(company_label || "").slice(0, 60) || undefined })]);

  return res.json({ ok: true, segments: segs,
    magic_link: `${APP_BASE}/public/collab-portal.html?token=${raw}` });
}

// ── 角色 token 解析（车队/报关行 文件口共用）──────────────
async function resolveRoleToken(pool, raw, roles) {
  if (!raw || raw.length < 16) return null;
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1 AND recipient_role = ANY($2)
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw), roles]
  );
  if (!rows.length) return null;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return null;
  return { role: rows[0].recipient_role, planId, segments: meta.segments || null, meta };
}

// ── GET /file?token=&type=so|cd&ref= — 文档下载代理 ─────────
// magic token 换内部 JWT，服务端转发 documents 渲染，JWT 不出服务器。
// 车队只能拿 SO（托书）；报关行 SO + CD（报关底稿，ref 必须是本票挂的订单号）。
const FILE_TYPES_BY_ROLE = { trucking_booking: ["so"], broker_booking: ["so", "pack", "customs_decl"], customer_booking: ["pack"],
  factory_booking: ["upload"],
  supplier_portal: ["so", "cd", "pack", "nondg", "telex", "transfer", "upload", "customs_decl"] };
async function handleFileProxy(req, res, pool) {
  const { token: raw, type, ref, aud } = req.query || {};
  const auth = await resolveRoleToken(pool, raw, ["trucking_booking", "broker_booking", "supplier_portal", "customer_booking", "factory_booking"]);
  if (!auth) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const allowed = FILE_TYPES_BY_ROLE[auth.role] || [];
  if (!allowed.includes(type)) return res.status(403).json({ ok: false, error: "无权下载该类型" });

  let docId;
  // 非危声明/电放保函：shipping-plan-pdf 端点（关联字段=计划 id）
  if (type === "nondg" || type === "telex" || type === "transfer" || type === "customs_decl") {
    const jwtX = generateToken({ id: 0, username: "collab-doc-proxy", role: "logistics" });
    const urlX = `http://127.0.0.1:9000/api/db/shipping-plan-pdf?id=${auth.planId}&type=${type}&token=${encodeURIComponent(jwtX)}`;
    try {
      const up = await fetch(urlX);
      res.status(up.status);
      const ct = up.headers.get("content-type"); if (ct) res.setHeader("Content-Type", ct);
      return res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) { return res.status(502).json({ ok: false, error: "文档服务不可用" }); }
  }
  // 回传/上传文件下载（MSDS/检疫等）：stored 名必须在本票 collab_uploads 清单内（防越权拉文件）
  if (type === "upload") {
    const { rows: upl } = await pool.query(
      `SELECT raw->'collab_uploads' AS u FROM shipping_plans WHERE id = $1`, [auth.planId]);
    const list = (upl[0] && upl[0].u) || [];
    const hit = Array.isArray(list) ? list.find(x => x && x.stored === String(ref || "")) : null;
    if (!hit) return res.status(403).json({ ok: false, error: "文件不属于本票" });
    const fp = path.join(UPLOAD_DIR, String(auth.planId), hit.stored);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: "文件不存在" });
    res.setHeader("Content-Type", hit.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(hit.filename)}`);
    return res.end(fs.readFileSync(fp));
  }
  let extraQ = "";
  if (type === "so") {
    docId = auth.planId; // 计划级文档按 id 精确解析
  } else if (type === "pack") {
    // 报关资料/客户资料合并版：id=首单 + ids=本票全部订单（与管理端同一关联，绝不只合一单）
    const { rows: ords } = await pool.query(
      `SELECT order_no FROM orders WHERE shipping_plan_id = $1 AND order_no IS NOT NULL ORDER BY order_no`, [auth.planId]);
    if (!ords.length) return res.status(404).json({ ok: false, error: "本票无订单" });
    docId = ords[0].order_no;
    extraQ = `&ids=${encodeURIComponent(ords.map(o => o.order_no).join(","))}&style=v2&audience=customer` +
             (aud === "customs" ? "&customs=1" : "");
  } else {
    // CD 按订单号；必须属于本票（防横向拉别票资料）
    const { rows } = await pool.query(
      `SELECT 1 FROM orders o JOIN shipping_plans sp ON sp.id = $1
        WHERE o.shipping_plan_id = sp.id AND o.order_no = $2 LIMIT 1`,
      [auth.planId, String(ref || "")]
    );
    if (!rows.length) return res.status(403).json({ ok: false, error: "订单不属于本票" });
    docId = String(ref);
  }
  const jwt = generateToken({ id: 0, username: "collab-doc-proxy", role: "logistics" });
  const audQ = (type !== "pack" && (aud === "customs" || aud === "customer")) ? `&audience=${aud}` : "";
  const url = `http://127.0.0.1:9000/api/db/documents?type=${type}&id=${encodeURIComponent(docId)}&token=${encodeURIComponent(jwt)}${audQ}${extraQ || ""}`;
  try {
    const up = await fetch(url);
    res.status(up.status);
    const ct = up.headers.get("content-type"); if (ct) res.setHeader("Content-Type", ct);
    const cd = up.headers.get("content-disposition"); if (cd) res.setHeader("Content-Disposition", cd);
    const buf = Buffer.from(await up.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    return res.status(502).json({ ok: false, error: "文档服务不可用" });
  }
}

// ── POST /upload — 车队传装柜照/磅单，报关行传报关单回执 ────
// base64 JSON（≤8MB），存 /opt/sanlyn-uploads/collab/<planId>/，raw.collab_uploads 留痕
const UPLOAD_DIR = "/opt/sanlyn-uploads/collab";
// ── 全员提交后总量一致性闸：不一致 → ntfy 警报（Damon 规则：提交完还不平=必须有人看） ──
async function alertIfTotalsMismatch(pool, planId) {
  try {
    const { rows } = await pool.query(
      `SELECT sp.shipment_no, sp.bl_no, sp.total_cartons, sp.gross_weight_kg, sp.total_cbm,
              sp.factory_submitted, sp.customer_submitted,
              (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(sp.raw->'collab_uploads','[]'::jsonb)) u
                WHERE u->>'role' = 'broker') AS broker_uploads,
              SUM(o.total_qty) AS o_qty, SUM(o.gross_weight) AS o_gw, SUM(o.net_weight) AS o_nw,
              (SELECT ROUND(SUM(COALESCE(oli.gw_ctn,0)*COALESCE(oli.qty_ctn,0))::numeric,1)
                 FROM order_line_items oli JOIN orders oo ON oo.id = oli.order_id
                WHERE oo.shipping_plan_id = sp.id) AS oli_gw
         FROM shipping_plans sp LEFT JOIN orders o ON o.shipping_plan_id = sp.id
        WHERE sp.id = $1 GROUP BY sp.id`, [planId]);
    if (!rows.length) return;
    const r = rows[0];
    if (!(r.factory_submitted && r.customer_submitted && Number(r.broker_uploads) > 0)) return; // 没全交不吵
    const issues = [];
    const near = (a, b) => a == null || b == null || Math.abs(Number(a) - Number(b)) <= Math.max(1, Number(b) * 0.001);
    if (r.o_qty != null && r.total_cartons != null && !near(r.o_qty, r.total_cartons))
      issues.push(`箱数 orders=${r.o_qty} vs 计划=${r.total_cartons}`);
    if (r.o_gw != null && r.gross_weight_kg != null && !near(r.o_gw, r.gross_weight_kg))
      issues.push(`毛重 orders=${r.o_gw} vs 计划=${r.gross_weight_kg}`);
    if (r.oli_gw != null && r.o_gw != null && Number(r.oli_gw) > 0 && !near(r.oli_gw, r.o_gw))
      issues.push(`毛重 明细Σ=${r.oli_gw} vs orders=${r.o_gw}`);
    if (r.o_qty == null || r.o_gw == null) issues.push("订单总量字段缺失（空白单未填）");
    // 单柜 CBM 红线：申报超 76 易被查验（2026-06-12 Damon）
    try {
      const { rows: cv } = await pool.query(
        `SELECT cb.container_no, ROUND(SUM(oli.cbm_ctn*oli.qty_ctn)::numeric,2) AS cbm
           FROM container_bookings cb
           JOIN orders o ON o.contract_no = cb.contract_no
           JOIN order_line_items oli ON oli.order_id = o.id
          WHERE cb.shipping_plan_id = $1 GROUP BY cb.container_no`, [planId]);
      for (const v of cv) if (Number(v.cbm) > 76)
        issues.push(`${v.container_no} 申报CBM ${v.cbm} 超76红线（易查验）`);
    } catch (e) {}
    // 过磅交叉核对：货重+皮重 vs VGM磅重，差>2% 必有一边错
    try {
      const { rows: wb } = await pool.query(
        `SELECT container_no, cargo_weight_kg, tare_weight_kg, vgm_weight_kg FROM container_bookings
          WHERE shipping_plan_id = $1 AND cargo_weight_kg IS NOT NULL AND vgm_weight_kg IS NOT NULL`, [planId]);
      for (const w of wb) {
        const calc = Number(w.cargo_weight_kg) + Number(w.tare_weight_kg || 0);
        if (Math.abs(calc - Number(w.vgm_weight_kg)) > Number(w.vgm_weight_kg) * 0.02)
          issues.push(`${w.container_no} 过磅不符：货重+皮重=${calc} vs 车队磅=${w.vgm_weight_kg}`);
      }
    } catch (e) {}
    if (!issues.length) return;
    await fetch("https://ntfy.sh/sanlyn-damon-alert", { method: "POST",
      headers: { Title: encodeURIComponent(`报关硬规则未过 ${r.shipment_no || ""}`), Priority: "high" },
      body: `${r.shipment_no} / BL ${r.bl_no || "-"} 三方全部提交但总量不一致：\n` + issues.join("\n") }).catch(() => {});
  } catch (e) { console.error("[totals-alert]", e.message); }
}

async function handleCollabUpload(req, res, pool) {
  const { token: raw, filename, mime, data_base64 } = req.body || {};
  const auth = await resolveRoleToken(pool, raw, ["trucking_booking", "broker_booking", "supplier_portal", "factory_booking", "customer_booking"]);
  if (!auth) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  if (!filename || !data_base64) return res.status(400).json({ ok: false, error: "filename / data_base64 必填" });
  const purpose = String((req.body && req.body.purpose) || "").slice(0, 40) || null;
  const seqRaw = parseInt(req.body && req.body.container_seq, 10);
  const containerSeq = seqRaw > 0 ? seqRaw : null;
  const fScope = auth.role === "factory_booking" && auth.meta ? auth.meta.factory_scope : null;
  const scopeSeqs = fScope && Array.isArray(fScope.seqs) ? fScope.seqs.map(Number).filter(Boolean) : [];
  if (containerSeq && scopeSeqs.length && !scopeSeqs.includes(containerSeq))
    return res.status(403).json({ ok: false, error: "无权上传该柜文件" });

  let buf;
  try { buf = Buffer.from(String(data_base64).replace(/^data:[^,]*,/, ""), "base64"); }
  catch (e) { return res.status(400).json({ ok: false, error: "base64 解析失败" }); }
  if (!buf.length || buf.length > 8 * 1024 * 1024)
    return res.status(413).json({ ok: false, error: "文件需在 8MB 以内" });

  const safe = String(filename).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 80) || "file";
  const dir = path.join(UPLOAD_DIR, String(auth.planId));
  fs.mkdirSync(dir, { recursive: true });
  const fname = Date.now() + "_" + auth.role.replace("_booking", "") + "_" + safe;
  fs.writeFileSync(path.join(dir, fname), buf);

  const rec = {
    role: auth.role.replace("_booking", ""), filename: safe, stored: fname,
    mime: String(mime || "").slice(0, 60) || null, size: buf.length,
    uploaded_at: new Date().toISOString(),
  };
  if (purpose) rec.purpose = purpose;
  if (containerSeq) rec.container_seq = containerSeq;
  await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw,'{}'::jsonb) ||
                  jsonb_build_object('collab_uploads',
                    COALESCE(raw->'collab_uploads','[]'::jsonb) || $1::jsonb),
            updated_at = now()
      WHERE id = $2`,
    [JSON.stringify([rec]), auth.planId]
  );
  if (rec.role === "broker") alertIfTotalsMismatch(pool, auth.planId); // 异步，不阻塞响应
  return res.json({ ok: true, file: rec });
}

// ── GET /contacts?plan_id=<_id> — 四方联系人解析（内部用）─────
// 客户/工厂/车队/报关行：有真实手机/邮箱就返回；客户在 customers 注册过
// (phone_e164) 标 registered=true（她的手机号可直接登录主站）。
async function handleGetContacts(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });

  const planRow = await pool.query(
    `SELECT id, customer, customer_en, contract_no, order_contract_nos,
            customs_broker_id, customs_broker_cn, customs_cn,
            trucking_company_id, trucking_company_cn, trucking_cn
       FROM shipping_plans WHERE _id = $1 LIMIT 1`, [planId]
  );
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const p = planRow.rows[0];

  const out = { customer: null, factory: null, trucking: null, broker: null };

  // 客户 → customers 表（注册用户：phone_e164 即主站登录号）
  const custName = p.customer_en || p.customer;
  if (custName) {
    const r = await pool.query(
      `SELECT name, contact_name, contact_phone, contact_email, phone_e164, phone_verified
         FROM customers
        WHERE name ILIKE $1 OR name_en ILIKE $1 OR name_cn ILIKE $1
        LIMIT 1`, [custName.trim()]
    );
    const c = r.rows[0];
    if (c) out.customer = {
      name: COALESCE(c.name_cn, c.name_en), contact: c.contact_name || null,
      phone: c.phone_e164 || c.contact_phone || null,
      email: c.contact_email || null,
      registered: !!c.phone_e164,
    };
  }

  // 工厂 → 经 contract_no 找 orders.factory → companies
  const contracts = String(p.order_contract_nos || p.contract_no || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (contracts.length) {
    const r = await pool.query(
      `SELECT o.factory, c.contact_name, c.contact_phone
         FROM orders o
         LEFT JOIN companies c ON (c.name_en = o.factory OR c.name_cn = o.factory)
        WHERE o.contract_no = ANY($1) AND o.factory IS NOT NULL
        LIMIT 1`, [contracts]
    );
    const f = r.rows[0];
    if (f) out.factory = {
      name: f.factory, contact: f.contact_name || null,
      phone: f.contact_phone || null, email: null, registered: false,
    };
  }

  // 车队 / 报关行 → companies by id（内部固定供应商）
  for (const [key, id, fallbackName] of [
    ["trucking", p.trucking_company_id, p.trucking_company_cn || p.trucking_cn],
    ["broker",   p.customs_broker_id,   p.customs_broker_cn   || p.customs_cn],
  ]) {
    let row = null;
    if (id) {
      const r = await pool.query(
        `SELECT name, name_cn, contact_name, contact_phone FROM companies WHERE id = $1 LIMIT 1`, [id]);
      row = r.rows[0];
    } else if (fallbackName) {
      const r = await pool.query(
        `SELECT name, name_cn, contact_name, contact_phone FROM companies
          WHERE name_cn = $1 OR name = $1 LIMIT 1`, [fallbackName]);
      row = r.rows[0];
    }
    if (row) out[key] = {
      name: row.name_cn || row.name, contact: row.contact_name || null,
      phone: row.contact_phone || null, email: null, registered: false,
    };
    else if (fallbackName) out[key] = { name: fallbackName, contact: null, phone: null, email: null, registered: false };
  }

  return res.json({ ok: true, contacts: out });
}

async function emitBillTask(pool, planId, version, amountCny) {
  try {
    const { rows } = await pool.query(
      `SELECT _id, shipment_no FROM shipping_plans WHERE id = $1 LIMIT 1`, [planId]);
    if (!rows.length) return;
    const { _id, shipment_no } = rows[0];
    const taskId = 't-bill-' + Date.now().toString(36);
    await pool.query(
      `INSERT INTO tasks (id, title, task_type, level, status, risk_level, raw, created_at, updated_at)
       VALUES ($1, $2, '账单确认', 'logi', 'open', 'mid', $3::jsonb, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [taskId,
       `待确认账单 · ${shipment_no || _id} · CNY ${Number(amountCny).toLocaleString()}`,
       JSON.stringify({ plan_id: String(planId), plan_business_id: _id, version, amount_cny: amountCny })
      ]
    );
  } catch (e) {
    console.error('[emitBillTask]', e.message);
  }
}


// ── GET /plan-factories?plan_id=<_id> ── 弹窗分厂行：哪些厂、各管几柜
async function handlePlanFactories(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planRef = String((req.query && req.query.plan_id) || "");
  if (!planRef) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const { rows: pr } = await pool.query(
    `SELECT id, container_type, container_qty, raw FROM shipping_plans WHERE _id = $1 OR id::text = $1`, [planRef]);
  if (!pr.length) return res.status(404).json({ ok: false, error: "找不到计划" });
  const plan = pr[0];
  const raw = plan.raw || {};
  const fs = raw.factory_submits || {};
  const map = new Map();
  const put = (label, patch = {}) => {
    if (!label) return;
    const cur = map.get(label) || { label, seqs: [], qty: null, note: null };
    map.set(label, { ...cur, ...patch,
      seqs: (cur.seqs && cur.seqs.length) ? cur.seqs : (patch.seqs || []),
      qty: cur.qty || patch.qty || null, note: cur.note || patch.note || null });
  };
  // 1) 录单/人工写的分厂分配（最权威）
  for (const f of (Array.isArray(raw.factories_alloc) ? raw.factories_alloc : []))
    put(f.label, { seqs: f.seqs || [], qty: f.qty || (f.seqs || []).length || null, note: f.note });
  // 2) 已发的分柜链接 scope
  const { rows: ml } = await pool.query(
    `SELECT DISTINCT meta->'factory_scope' AS scope FROM magic_links
      WHERE recipient_role='factory_booking' AND (meta->>'shipment_id')::int = $1
        AND meta->'factory_scope' IS NOT NULL AND revoked_at IS NULL`, [plan.id]);
  for (const r of ml) { const s = r.scope || {}; put(s.label, { seqs: s.seqs || [] }); }
  // 3) 计划阶段记录的工厂名（无柜分配）
  for (const name of (Array.isArray(raw.factories) ? raw.factories : [])) put(name, {});
  // 4) 已提交的厂标
  for (const label of Object.keys(fs)) put(label, {});
  let factories = [...map.values()].map(f => ({ ...f,
    qty: f.qty || (f.seqs || []).length || null, submitted: !!fs[f.label] }));
  if (!factories.length) factories = await derivePlanFactories(pool, plan.id);
  return res.json({ ok: true, container_type: plan.container_type,
    container_qty: plan.container_qty, factories });
}

// ── GET /supply-chain-options?plan_id=xxx ────────────────────────────────────
// Returns company lists by type (forwarders/trucking/brokers/factories/customers)
// for the CollabLinkPopup dropdowns.
async function handleSupplyChainOptions(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const byType = async (type) => {
    const r = await pool.query(
      `SELECT id, name_cn, COALESCE(name_en, name_cn) AS name, code
         FROM companies
        WHERE type = $1 AND (active IS NULL OR active = true)
          AND merged_into_code IS NULL
        ORDER BY name_cn NULLS LAST LIMIT 120`,
      [type]
    );
    return r.rows;
  };
  // 2026-07-06 根治: "货代"(中间人/intermediary,如上海洋宝宝)公司类型是 sanlyn_entity 不是 forwarder,
  // 之前intermediary选择器复用forwarders列表(只查type=forwarder)导致洋宝宝这类中间人永远选不到。
  const byTypeIn = async (types) => {
    const r = await pool.query(
      `SELECT id, name_cn, COALESCE(name_en, name_cn) AS name, code
         FROM companies
        WHERE type = ANY($1::text[]) AND (active IS NULL OR active = true)
          AND merged_into_code IS NULL
        ORDER BY name_cn NULLS LAST LIMIT 120`,
      [types]
    );
    return r.rows;
  };
  const [forwarders, trucking, brokers, factories, customers, intermediaries] = await Promise.all([
    byType("forwarder"),
    byType("trucking"),
    byType("customs_broker"),
    byType("factory"),
    byType("customer"),
    byTypeIn(["forwarder", "sanlyn_entity"]),
  ]);
  return res.json({ ok: true, companies: { forwarders, trucking, brokers, factories, customers, intermediaries } });
}

// ── GET /party-defaults ──────────────────────────────────────────────────────
// Returns per-party default company from collab_party_defaults.
async function handlePartyDefaults(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const r = await pool.query(
    `SELECT party_type, company_id, company_cn FROM collab_party_defaults ORDER BY updated_at DESC`
  );
  const defaults = {};
  for (const row of r.rows) {
    if (!defaults[row.party_type]) {
      defaults[row.party_type] = { id: row.company_id, cn: row.company_cn };
    }
  }
  return res.json({ ok: true, defaults });
}

// ── POST /set-party-default ──────────────────────────────────────────────────
// Upsert a default party company into collab_party_defaults.
async function handleSetPartyDefault(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { party_type, company_id, company_cn } = req.body || {};
  if (!party_type || !company_id) return res.status(400).json({ ok: false, error: "party_type/company_id 必填" });
  await pool.query(
    `INSERT INTO collab_party_defaults (party_type, company_id, company_cn, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (party_type) DO UPDATE
       SET company_id = EXCLUDED.company_id,
           company_cn = EXCLUDED.company_cn,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
    [party_type, company_id, company_cn || "", req.user && req.user.username ? req.user.username : "admin"]
  );
  return res.json({ ok: true });
}

function normBillCode(v) { return String(v || "").trim(); }
function uniqBillVals(arr) { return [...new Set(arr.map(normBillCode).filter(Boolean))]; }
function noBillSummary(direction) {
  return {
    status: "no_bill", label: "无账单", tone: "gray",
    line_count: 0, total: 0, confirmed_at: null,
    paid_status: "unpaid", reconciled: false, direction,
  };
}
function billHasCollabPending(row) {
  const pending = row && row.collab_pending;
  if (!pending) return false;
  if (typeof pending === "string") return pending.trim() !== "" && pending.trim() !== "{}";
  if (typeof pending === "object") return Object.keys(pending).length > 0;
  return true;
}
function partyBillSummary(rows, direction) {
  const totalField = direction === "receivable" ? "sale_amount" : "amount";
  const statusField = direction === "receivable" ? "ar_status" : "ap_status";
  const amountRows = rows.filter(r => Number(r[totalField] || 0) > 0);
  const lineCount = amountRows.length;
  if (!lineCount) return noBillSummary(direction);

  const total = amountRows.reduce((sum, r) => sum + Number(r[totalField] || 0), 0);
  const confirmed = amountRows.filter(r => r.confirmed_at && !billHasCollabPending(r)).length;
  const reconciledCount = amountRows.filter(r => r.reconciled === true).length;
  const paidCount = amountRows.filter(r => String(r[statusField] || "").toLowerCase() === "paid").length;
  const rawStatuses = uniqBillVals(amountRows.map(r => String(r[statusField] || "unpaid").toLowerCase() || "unpaid"));
  const paidStatus = paidCount === lineCount ? "paid" : paidCount > 0 ? "partial" : (rawStatuses.length === 1 ? rawStatuses[0] : "partial");

  let status;
  let label;
  let tone;
  if (paidCount === lineCount) {
    status = direction === "receivable" ? "received" : "paid";
    label = direction === "receivable" ? "已收款" : "已付款";
    tone = "green";
  } else if (confirmed < lineCount) {
    status = "pending_confirm";
    label = confirmed > 0 ? `${confirmed}/${lineCount}已确认` : "待确认";
    tone = "yellow";
  } else if (reconciledCount === lineCount) {
    status = "reconciled";
    label = "已核对";
    tone = "green";
  } else {
    status = "confirmed";
    label = "对方已确认";
    tone = "yellow";
  }

  return {
    status, label, tone,
    line_count: lineCount,
    total,
    confirmed_at: amountRows.map(r => r.confirmed_at).filter(Boolean).sort().at(-1) || null,
    paid_status: paidStatus,
    reconciled: lineCount > 0 && reconciledCount === lineCount,
    direction,
  };
}
function partyKeyFromFactoryLabel(label) {
  const s = String(label || "").trim();
  return s ? `factory_${s}` : "factory";
}
function companyCodeMatches(a, b) {
  return normBillCode(a) && normBillCode(a) === normBillCode(b);
}

// ── GET /party-billing-status?plan_id=xxx ───────────────────────────────────
// Read-only billing badges from active_freight_supplier_bills; shipping_plans.party_billing is ignored.
async function handlePartyBillingStatus(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const spColR = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'shipping_plans'`);
  const spCols = new Set(spColR.rows.map(row => row.column_name));
  const spCol = (name) => spCols.has(name) ? `sp.${name}` : `NULL`;
  const companyJoin = (alias, col) => spCols.has(col) ? `LEFT JOIN companies ${alias} ON ${alias}.id = sp.${col}` : `LEFT JOIN companies ${alias} ON false`;
  const r = await pool.query(
    `SELECT sp.id, sp._id, sp.bl_no, sp.hbl_no,
            ${spCol("forwarder_company_id")} AS forwarder_company_id,
            ${spCol("trucking_company_id")} AS trucking_company_id,
            ${spCol("customs_broker_id")} AS customs_broker_id,
            ${spCol("customer_company_id")} AS customer_company_id,
            ${spCol("intermediary_company_id")} AS intermediary_company_id,
            ${spCol("exporter_company_id")} AS exporter_company_id,
            cf.code AS forwarder_code, ct.code AS trucking_code, cb.code AS broker_code,
            cc.code AS customer_code, ci.code AS intermediary_code, ce.code AS exporter_code,
            COALESCE(ce.name_cn, ce.name_en) AS exporter_name
       FROM shipping_plans sp
       ${companyJoin("cf", "forwarder_company_id")}
       ${companyJoin("ct", "trucking_company_id")}
       ${companyJoin("cb", "customs_broker_id")}
       ${companyJoin("cc", "customer_company_id")}
       ${companyJoin("ci", "intermediary_company_id")}
       ${companyJoin("ce", "exporter_company_id")}
      WHERE sp._id = $1 OR sp.id::text = $1
      LIMIT 1`, [String(planId)]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const plan = r.rows[0];
  const blNo = plan.bl_no || plan.hbl_no;
  if (!blNo) return res.json({ ok: true, party_billing: {} });

  const fsbColR = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'freight_supplier_bills'`);
  const fsbCols = new Set(fsbColR.rows.map(row => row.column_name));
  const optional = (name, fallback = "NULL") => fsbCols.has(name) ? `b.${name}` : `${fallback} AS ${name}`;
  const bills = await pool.query(
    `SELECT b.id, b.bl_no, b.cost_category, b.amount, b.sale_amount,
            b.supplier_company_code, b.payer_company_code,
            b.confirmed_at, b.reconciled, b.ap_status, b.ap_paid_amount, b.ar_status, b.ar_paid_amount,
            ${optional("rebill_to_type")}, ${optional("rebill_to_name")}, ${optional("rebill_to_code")},
            b.raw->'collab_pending' AS collab_pending
       FROM active_freight_supplier_bills b
      WHERE b.bl_no = $1
      ORDER BY b.id`, [blNo]);
  const rows = bills.rows;

  const factoryCodeR = await pool.query(
    `SELECT DISTINCT
            COALESCE(c_id.code, NULLIF(o.factory_code, ''), c_name.code) AS code,
            COALESCE(c_id.name_cn, c_id.name_en, c_name.name_cn, c_name.name_en, o.factory) AS label
       FROM orders o
       LEFT JOIN companies c_id ON c_id.id = o.factory_company_id
       LEFT JOIN companies c_name ON c_name.name_cn = o.factory OR c_name.name_en = o.factory
      WHERE o.shipping_plan_id = $1`, [plan.id]);
  const factoryCodes = factoryCodeR.rows.map(row => ({ code: normBillCode(row.code), label: String(row.label || "").trim() })).filter(row => row.code || row.label);
  let factoryRows = [];
  try {
    factoryRows = await derivePlanFactories(pool, plan.id);
  } catch (_) {
    factoryRows = [];
  }
  const supplierRows = (code) => rows.filter(row => code && companyCodeMatches(row.supplier_company_code, code) && Number(row.amount || 0) > 0);
  const payerRows = (code) => rows.filter(row => code && companyCodeMatches(row.payer_company_code, code) && Number(row.sale_amount || 0) > 0);
  const factorySupplierCodes = uniqBillVals(factoryCodes.map(row => row.code));
  const party_billing = {
    factory: partyBillSummary(rows.filter(row => factorySupplierCodes.includes(normBillCode(row.supplier_company_code)) && Number(row.amount || 0) > 0), "payable"),
    ocean: partyBillSummary(supplierRows(plan.forwarder_code), "payable"),
    trucking: partyBillSummary(supplierRows(plan.trucking_code), "payable"),
    broker: partyBillSummary(supplierRows(plan.broker_code), "payable"),
    intermediary: partyBillSummary(supplierRows(plan.intermediary_code), "payable"),
    customer: partyBillSummary(payerRows(plan.customer_code), "receivable"),
    exporter: noBillSummary("receivable"),
  };

  for (const f of factoryRows) {
    const label = String(f.label || "").trim();
    const hit = factoryCodes.find(row => row.label === label) || factoryCodes.find(row => label && row.label && (row.label.includes(label) || label.includes(row.label)));
    party_billing[partyKeyFromFactoryLabel(label)] = partyBillSummary(hit && hit.code ? supplierRows(hit.code) : [], "payable");
  }

  if (plan.exporter_code) {
    const exporterName = String(plan.exporter_name || "").trim();
    const exporterRows = payerRows(plan.exporter_code).filter(row =>
      companyCodeMatches(row.rebill_to_code, plan.exporter_code) ||
      (exporterName && String(row.rebill_to_name || "").includes(exporterName)) ||
      String(row.rebill_to_type || "").toLowerCase() === "exporter"
    );
    party_billing.exporter = partyBillSummary(exporterRows, "receivable");
  }

  return res.json({ ok: true, party_billing });
}

// ── POST /set-party-billing ─────────────────────────────────────────────────
async function handleSetPartyBilling(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, party, billed, paid } = req.body || {};
  const allowed = new Set(["factory", "ocean", "customer", "trucking", "broker", "intermediary", "exporter"]);
  if (!plan_id || !party) return res.status(400).json({ ok: false, error: "plan_id/party 必填" });
  if (!allowed.has(party)) return res.status(400).json({ ok: false, error: "party 无效" });

  const r = await pool.query(
    `SELECT id, COALESCE(party_billing, '{}'::jsonb) AS party_billing
       FROM shipping_plans
      WHERE _id = $1 OR id::text = $1
      LIMIT 1`, [String(plan_id)]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });

  const partyBilling = (typeof r.rows[0].party_billing === "string"
    ? JSON.parse(r.rows[0].party_billing)
    : r.rows[0].party_billing) || {};
  partyBilling[party] = {
    billed: !!billed,
    paid: !!paid,
    amount: null,
    source: "manual",
    updated_at: new Date().toISOString(),
    updated_by: req.user && req.user.username ? req.user.username : "admin",
  };
  await pool.query(
    `UPDATE shipping_plans
        SET party_billing = $2::jsonb
      WHERE id = $1`,
    [r.rows[0].id, JSON.stringify(partyBilling)]
  );
  return res.json({ ok: true, party_billing: partyBilling });
}

// ── GET /collab-messages?plan_id=xxx ─────────────────────────────────────────
// Returns message threads grouped by party from collab_party_messages.
async function handleCollabMessages(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`, [planId]);
  if (!planRow.rows.length) return res.json({ ok: true, threads: {} });
  const numId = planRow.rows[0].id;
  const r = await pool.query(
    `SELECT id, party, direction, body, author, created_at
       FROM collab_party_messages
      WHERE shipping_plan_id = $1
      ORDER BY created_at ASC`, [numId]);
  const threads = {};
  for (const m of r.rows) {
    if (!threads[m.party]) threads[m.party] = [];
    threads[m.party].push({ id: m.id, direction: m.direction || "sanlyn", body: m.body, author: m.author, created_at: m.created_at });
  }
  return res.json({ ok: true, threads });
}

// ── POST /collab-message ─────────────────────────────────────────────────────
// Send a message to a party (direction="sanlyn" = outbound from us).
async function handlePostCollabMessage(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, party, from: dir, body: msgBody } = req.body || {};
  if (!plan_id || !party || !msgBody) return res.status(400).json({ ok: false, error: "plan_id/party/body 必填" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numId = planRow.rows[0].id;
  await pool.query(
    `INSERT INTO collab_party_messages (shipping_plan_id, party, direction, body, author, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [numId, party, dir || "sanlyn", msgBody, dir || "sanlyn"]);
  return res.json({ ok: true });
}

// ── GET /shipment-orders?plan_id=xxx ─────────────────────────────────────────
// Returns orders currently in this plan + unassigned candidates for same customer.
async function handleShipmentOrders(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const planId = req.query && req.query.plan_id;
  if (!planId) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  const planRow = await pool.query(
    `SELECT id, _id, customer, customer_en, pol, pod, raw FROM shipping_plans WHERE _id = $1 OR id::text = $1 LIMIT 1`,
    [planId]);
  if (!planRow.rows.length) return res.json({ ok: true, current: [], candidates: [], plan: null });
  const plan = planRow.rows[0];
  const raw = (typeof plan.raw === "string" ? JSON.parse(plan.raw) : plan.raw) || {};

  // current: orders with shipping_plan_id pointing here
  const curR = await pool.query(
    `SELECT o.id, o.order_no, o.factory, o.customer, o.company_code,
            o.trade_terms, o.issuing_company,
            COALESCE(o.company_name_en, o.company_name_cn, o.customer, o.company_code, '') AS customer_label,
            COALESCE((SELECT SUM(qty_ctn) FROM order_line_items WHERE order_id = o.id), 0)::int AS total_qty
       FROM orders o
      WHERE o.shipping_plan_id = $1 AND (o.status IS NULL OR o.status NOT IN ('cancelled'))
      ORDER BY o.order_no`,
    [plan.id]);

  // candidates: active orders for same customer not yet assigned to any plan
  const custName = plan.customer_en || plan.customer || "";
  let candR = { rows: [] };
  if (custName) {
    candR = await pool.query(
      `SELECT o.id, o.order_no, o.factory, o.customer, o.pol, o.company_code,
              COALESCE(o.company_name_en, o.company_name_cn, o.customer, o.company_code, '') AS customer_label,
              COALESCE((SELECT SUM(qty_ctn) FROM order_line_items WHERE order_id = o.id), 0)::int AS total_qty
        FROM orders o
       WHERE o.shipping_plan_id IS NULL
          AND o.status IN ('confirmed', 'ready')
          AND (o.customer ILIKE $1 OR o.company_name_en ILIKE $1 OR o.company_name_cn ILIKE $1
               OR o.company_code IN (
                 SELECT company_code FROM companies
                  WHERE name_en ILIKE $1 OR name_cn ILIKE $1 LIMIT 5
               ))
        ORDER BY o.order_no LIMIT 20`,
      [`%${custName.trim()}%`]);
  }

  const candidates = candR.rows.map(o => {
    const reasons = [];
    if (plan.pol && o.pol && o.pol !== plan.pol) reasons.push(`POL不符(${o.pol}≠${plan.pol})`);
    if (plan.pod && o.pod && o.pod !== plan.pod) reasons.push(`POD不符(${o.pod}≠${plan.pod})`);
    return { ...o, match: { ok: reasons.length === 0, reasons } };
  });

  const shipDate = raw.shipment_date || null;
  const shipped = raw.shipped === true || !!shipDate;
  // 读时派生:本票挂着的订单里一致的值,供前端自动带(只在计划字段空时用,不落库)
  const uniq = (f) => [...new Set(curR.rows.map(r => (r[f] == null ? "" : String(r[f]).trim())).filter(Boolean))];
  const one = (f) => { const a = uniq(f); return a.length === 1 ? a[0] : null; };
  const derived = {
    freight_term: one("trade_terms"),
    issuing_company: one("issuing_company"),
    factory: one("factory"),
    customer: one("customer"),
    freight_term_conflict: uniq("trade_terms").length > 1 ? uniq("trade_terms") : null,
  };
  return res.json({
    ok: true,
    current: curR.rows,
    candidates,
    derived,
    plan: { id: plan.id, _id: plan._id, version: raw.version || 1, shipped, shipment_date: shipDate },
  });
}

// ── GET|POST /master-preview-token ───────────────────────────────────────────
// Generates a short-lived magic_link so Sanlyn staff can open a party's view.
// Returns { ok: true, url: "https://ai.sanlyn.cn/public/collab-*.html?token=..." }
async function handleMasterPreviewToken(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const isPost = req.method === "POST";
  const src = isPost ? (req.body || {}) : (req.query || {});
  const { plan_id, party, segments, company_label } = src;
  if (!plan_id) return res.status(400).json({ ok: false, error: "plan_id 必填" });

  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;

  let page = "collab-portal.html";
  let role = "supplier_portal";
  const meta = { shipment_id: numericId, plan_business_id: plan_id, preview: true };

  if (party === "customer") {
    page = "collab-customer.html";
    role = "customer_booking";
  } else if (party === "factory") {
    // 工厂预览必须开真工厂页(collab-factory.html)+ factory_booking 角色，
    // 与 handleSendFactoryLink 对齐；collab-portal 没有工厂段内容会显示成海运界面
    page = "collab-factory.html";
    role = "factory_booking";
    if (company_label) meta.factory_scope = { label: String(company_label).slice(0, 60) };
  } else {
    const segs = Array.isArray(segments) ? segments.filter(s => ["ocean","truck","customs","factory"].includes(s))
      : [party].filter(s => ["ocean","truck","customs"].includes(s));
    meta.segments = segs.length ? segs : ["ocean", "truck", "customs"];
    if (company_label) meta.company_label = String(company_label).slice(0, 60);
  }

  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '2 hours', '[]'::jsonb, NOW())`,
    [rawToHash(raw), role, JSON.stringify(meta)]);

  return res.json({ ok: true, url: `${APP_BASE}/public/${page}?token=${raw}` });
}



// ── POST /send-intermediary-link — 洋宝宝(货代居间人) / 巴匕(出口商) ──
const INTERMEDIARY_CONFIG = {
  oceanbaby: { company_label: "上海洋宝宝国际物流", segments: ["ocean"], field_profile: "shipping_booking" },
  babi: { company_label: "厦门巴匕进出口", segments: ["ocean","truck","customs","factory"], field_profile: "upstream_downstream" }
};
async function handleSendIntermediaryLink(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const { plan_id, intermediary } = req.body || {};
  if (!plan_id) return res.status(400).json({ ok: false, error: "plan_id 必填" });
  if (!INTERMEDIARY_CONFIG[intermediary])
    return res.status(400).json({ ok: false, error: "intermediary 必须是 oceanbaby 或 babi" });
  const planRow = await pool.query(
    `SELECT id FROM shipping_plans WHERE _id = $1 LIMIT 1`, [plan_id]);
  if (!planRow.rows.length)
    return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const numericId = planRow.rows[0].id;
  const cfg = INTERMEDIARY_CONFIG[intermediary];
  await pool.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'supplier_portal'
        AND (meta->>'shipment_id')::int = $1 AND revoked_at IS NULL
        AND meta->>'field_profile' = $2`,
    [numericId, cfg.field_profile]);
  const raw = genRaw();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'supplier_portal', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [rawToHash(raw), JSON.stringify({
      shipment_id: numericId, plan_business_id: plan_id,
      segments: cfg.segments, company_label: cfg.company_label,
      field_profile: cfg.field_profile,
      party_scope: { mode: "upstream_downstream" },
    })]);
  const page = intermediary === "babi" ? "collab-factory.html" : "collab-portal.html";
  return res.json({ ok: true, magic_link: `${APP_BASE}/public/${page}?token=${raw}` });
}

// ── GET /collab-pricing — 洋宝宝费用成本/销售视图（只读）──
async function handleCollabPricing(req, res, pool) {
  const { token: raw } = req.query || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows: ml } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!ml.length) return res.status(403).json({ ok: false, error: "链接无效" });
  const meta = typeof ml[0].meta === "string" ? JSON.parse(ml[0].meta) : ml[0].meta;
  // 仅货代居间人(含 ocean 段)或出口商可看运费成本/销售+下游客户；工厂/车队/报关一律拒绝
  const psegs = Array.isArray(meta.segments) ? meta.segments : [];
  const seesPricing = psegs.includes("ocean") || meta.field_profile === "shipping_booking" || meta.field_profile === "upstream_downstream";
  if (!seesPricing) return res.status(403).json({ ok: false, error: "无权访问运费价格" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "plan 无效" });

  // 从 shipping_plans 取 bl_no + 客户信息
  const { rows: plan } = await pool.query(
    `SELECT bl_no, hbl_no, trucking_arrange, customs_arrange, customer_en, customer,
            pol, pod, freight_term
     FROM shipping_plans WHERE id = $1 LIMIT 1`, [planId]);
  if (!plan.length) return res.status(404).json({ ok: false, error: "计划不存在" });
  const blNo = plan[0].bl_no || plan[0].hbl_no;
  if (!blNo) return res.json({ ok: true, items: [], note: "BL 尚未录入" });
  const customerName = plan[0].customer_en || plan[0].customer || "";

  // 自理段判断
  const selfHandled = {
    trucking: plan[0].trucking_arrange === "factory" || plan[0].trucking_arrange === "self",
    customs:  plan[0].customs_arrange  === "factory" || plan[0].customs_arrange  === "self",
  };

  const { rows: bills } = await pool.query(
    `SELECT id, cost_category, charge_basis, unit_price, qty, amount, sale_amount,
            currency, supplier, incoterm, rebill_to_name
       FROM freight_supplier_bills
      WHERE bl_no = $1
      ORDER BY created_at`, [blNo]);

  const items = bills.map(b => {
    const amt  = b.amount      != null ? Number(b.amount)      : null;
    const sale = b.sale_amount != null ? Number(b.sale_amount) : null;
    return {
      id:            b.id,
      cost_category: b.cost_category,
      charge_basis:  b.charge_basis || "per_bl",
      unit_price:    b.unit_price != null ? Number(b.unit_price) : null,
      qty:           b.qty        != null ? Number(b.qty)        : null,
      amount:        amt,
      sale_amount:   sale,
      currency:      b.currency || "CNY",
      supplier:      b.supplier,
      incoterm:      b.incoterm,
      rebill_to:     b.rebill_to_name || customerName,
      self_handled:  (b.cost_category === "trucking" && selfHandled.trucking) ||
                     (b.cost_category === "customs_declaration" && selfHandled.customs),
    };
  });

  // 分币种汇总
  const makeTotals = (cur) => items.filter(i => i.currency === cur).reduce(
    (acc, i) => ({ cost: acc.cost + (i.amount||0), sales: acc.sales + (i.sale_amount||0) }),
    { cost: 0, sales: 0 }
  );
  const totals = { USD: makeTotals("USD"), CNY: makeTotals("CNY") };

  return res.json({ ok: true, bl_no: blNo, customer: customerName,
                    pol: plan[0].pol, pod: plan[0].pod, freight_term: plan[0].freight_term,
                    items, totals, self_handled: selfHandled });
}

// ── GET /collab-order-pricing — 巴匕采购/销售价视图（只读）──
async function handleCollabOrderPricing(req, res, pool) {
  const { token: raw } = req.query || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows: ml } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!ml.length) return res.status(403).json({ ok: false, error: "链接无效" });
  const meta = typeof ml[0].meta === "string" ? JSON.parse(ml[0].meta) : ml[0].meta;
  if (meta.field_profile !== "upstream_downstream")
    return res.status(403).json({ ok: false, error: "无权访问价格" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "plan 无效" });

  // 拉本票关联订单的行项目（采购价=settle_after_tax_per_unit，销售价=unit_price）
  const { rows } = await pool.query(
    `SELECT o.order_no, o.customer_en AS customer,
            oli.product_name, oli.product_sku,
            oli.quantity, oli.unit,
            oli.settle_after_tax   AS purchase_unit_price,
            oli.unit_price         AS sales_unit_price,
            oli.total_amount       AS sales_total,
            (oli.settle_after_tax * oli.quantity) AS purchase_total,
            ((oli.unit_price - oli.settle_after_tax) * oli.quantity) AS gross_profit,
            oli.currency
       FROM orders o
       JOIN order_line_items oli ON oli.order_id = o.id
      WHERE o.shipping_plan_id = $1
      ORDER BY o.order_no, oli.id`, [planId]);

  const totals = rows.reduce((acc, r) => ({
    purchase: acc.purchase + (Number(r.purchase_total) || 0),
    sales:    acc.sales    + (Number(r.sales_total)    || 0),
    profit:   acc.profit   + (Number(r.gross_profit)   || 0),
  }), { purchase: 0, sales: 0, profit: 0 });

  return res.json({ ok: true, items: rows, totals });
}

// ── POST /collab-pricing-submit — 洋宝宝补录运费销售价（写 freight_supplier_bills.sale_amount）──
async function handleCollabPricingSubmit(req, res, pool) {
  const { token: raw, updates } = req.body || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ ok: false, error: "updates 必填" });

  // 校验 token（与 handleCollabPricing 完全一致）
  const { rows: ml } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!ml.length) return res.status(403).json({ ok: false, error: "链接无效" });
  const meta = typeof ml[0].meta === "string" ? JSON.parse(ml[0].meta) : ml[0].meta;
  // 仅货代居间人/出口商可补录运费销售价；工厂/车队/报关拒绝
  const psegs = Array.isArray(meta.segments) ? meta.segments : [];
  const seesPricing = psegs.includes("ocean") || meta.field_profile === "shipping_booking" || meta.field_profile === "upstream_downstream";
  if (!seesPricing) return res.status(403).json({ ok: false, error: "无权补录运费价格" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "plan 无效" });

  // 取本票 bl_no（只能改本票的账单行，防越权）
  const { rows: plan } = await pool.query(
    `SELECT bl_no, hbl_no FROM shipping_plans WHERE id = $1 LIMIT 1`, [planId]);
  if (!plan.length) return res.status(404).json({ ok: false, error: "计划不存在" });
  const blNo = plan[0].bl_no || plan[0].hbl_no;
  if (!blNo) return res.status(400).json({ ok: false, error: "BL 尚未录入" });

  // 逐条更新：bill id 必须属于本票 bl_no，sale_amount 必须是非负数字
  let updated = 0;
  for (const u of updates) {
    if (!u || !u.bill_id) continue;
    const sale = Number(u.sale_amount);
    if (!isFinite(sale) || sale < 0) continue;
    const r = await pool.query(
      `UPDATE freight_supplier_bills
          SET sale_amount = $1, updated_at = NOW()
        WHERE id = $2 AND bl_no = $3`,
      [sale, u.bill_id, blNo]);
    updated += r.rowCount || 0;
  }

  return res.json({ ok: true, updated });
// ── POST /factory-self-token  (工厂 JWT 自助生成协同表链接) ──────────────────
async function handleFactoryToken(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const companyCodes = ((req.user.companyCodes && req.user.companyCodes.length)
    ? req.user.companyCodes
    : req.user.companyCode ? [req.user.companyCode] : []
  ).map(c => String(c).toLowerCase());
  if (!companyCodes.length) return res.status(403).json({ ok: false, error: "no_scope" });

  const body = req.body || {};
  const shipping_plan_id = parseInt(body.shipping_plan_id);
  if (!shipping_plan_id || isNaN(shipping_plan_id))
    return res.status(400).json({ ok: false, error: "shipping_plan_id required" });

  const ownerRow = await pool.query(
    `SELECT COUNT(*) AS cnt FROM orders
     WHERE shipping_plan_id = $1
       AND LOWER(raw->>'factoryCompanyCode') = ANY($2::text[])`,
    [shipping_plan_id, companyCodes]
  );
  if (parseInt(ownerRow.rows[0]?.cnt || 0) === 0)
    return res.status(403).json({ ok: false, error: "scope_mismatch" });

  const rawTok = genRaw();
  const hash = rawToHash(rawTok);
  const factoryLabel = companyCodes[0].toUpperCase();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'factory_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, JSON.stringify({ shipment_id: shipping_plan_id, factory_scope: { label: factoryLabel } })]
  );

  return res.json({ ok: true, link: `${APP_BASE}/public/collab-factory.html?token=${rawTok}`, expires_in: "7 days" });
}

}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // Extract path suffix:  /api/db/booking-collab/validate → "validate"
  // For /sailings/:id: second-to-last = "sailings", last = id
  const _fullPath = (req.path || req.url || "").replace(/\?.*/, "");
  const segments = _fullPath.split("/").filter(Boolean);
  const pathSuffix  = segments[segments.length - 1] || "";
  const parentSuffix = segments[segments.length - 2] || "";

  try {
    if (req.method === "GET"    && pathSuffix === "plan-factories")     return await handlePlanFactories(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "validate")           return await handleValidate(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "customs-doc-status") return await handleCustomsDocStatus(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-factory-link")  return await handleSendFactoryLink(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-customer-link") return await handleSendCustomerLink(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "factory-submit")     return await handleFactorySubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "customer-submit")    return await handleCustomerSubmit(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "sailings")           return await handleGetSailings(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "contacts")           return await handleGetContacts(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-trucking-link") return await handleSendRoleLink(req, res, pool, "trucking");
    if (req.method === "POST"   && pathSuffix === "send-broker-link")   return await handleSendRoleLink(req, res, pool, "broker");
    if (req.method === "POST"   && pathSuffix === "send-portal-link")   return await handleSendPortalLink(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "trucking-submit")    return await handleTruckingSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "broker-submit")      return await handleBrokerSubmit(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "customer-notes")     return await handleCustomerNotes(req, res, pool);
    if (req.method === "GET"    && pathSuffix === "file")               return await handleFileProxy(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "upload")             return await handleCollabUpload(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "sailings")           return await handlePostSailing(req, res, pool);
    if (req.method === "DELETE" && parentSuffix === "sailings")         return await handleDeleteSailing(req, res, pool, pathSuffix);
    if (req.method === "GET"    && pathSuffix  === "plans-list")        return await handlePlansList(req, res, pool);
    if (req.method === "GET"    && parentSuffix === "plan")             return await handleGetPlan(req, res, pool, pathSuffix);
    if (req.method === "PATCH"  && parentSuffix === "plan")             return await handlePatchPlan(req, res, pool, pathSuffix);
    if (req.method === "POST"   && pathSuffix === "set-factory-bill")   return await handleSetFactoryBill(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "confirm-factory-bill") return await handleConfirmFactoryBill(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "supply-chain-options")  return await handleSupplyChainOptions(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "party-defaults")         return await handlePartyDefaults(req, res, pool);
    if (req.method === "POST" && pathSuffix === "set-party-default")      return await handleSetPartyDefault(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "party-billing-status")   return await handlePartyBillingStatus(req, res, pool);
    if (req.method === "POST" && pathSuffix === "set-party-billing")      return await handleSetPartyBilling(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "collab-messages")        return await handleCollabMessages(req, res, pool);
    if (req.method === "POST" && pathSuffix === "collab-message")         return await handlePostCollabMessage(req, res, pool);
    if (req.method === "GET"  && pathSuffix === "shipment-orders")        return await handleShipmentOrders(req, res, pool);
    if (await registerBookingCollabView(req, res, pool, { pathSuffix, parentSuffix, requireAuth })) return;
    if ((req.method === "GET" || req.method === "POST") && pathSuffix === "master-preview-token") return await handleMasterPreviewToken(req, res, pool);
    if (req.method === "GET" && pathSuffix === "collab-pricing")       return await handleCollabPricing(req, res, pool);
    if (req.method === "GET" && pathSuffix === "collab-order-pricing") return await handleCollabOrderPricing(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "send-intermediary-link")  return await handleSendIntermediaryLink(req, res, pool);
    if (req.method === "POST" && pathSuffix === "factory-self-token")  return await handleFactoryToken(req, res, pool);
    if (req.method === "POST"   && pathSuffix === "collab-pricing-submit")    return await handleCollabPricingSubmit(req, res, pool);

    return res.status(404).json({ error: "Not found" });
  } catch (e) {
    console.error("[booking-collab]", e.message, e.stack);
    return res.status(500).json({ error: "internal_error" });
  }
}

/*
2026-07-01 factory profile address correction:
- L232-L243, L360: validate returns factory_profile_address only for non-preview scoped factory tokens with one exact companies.name_cn match.
- L625-L688: factory-submit update-factory-address requires scoped factory token, confirm=true, <=200-char address, unique companies row by token label, and appends audit to shipping_plans.raw.factory_address_changes.
*/
