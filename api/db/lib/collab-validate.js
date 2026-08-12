// collab-validate.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import fs from "fs";
import { billingSegmentFor, sanitizeSheet, visibleBillLines } from "./collab-field-profiles.js";
import { materializeAndList } from "./carrier-requirements.js";
import { rawToHash, COLLAB_VERSION, COLLAB_VERSION_AT } from "./collab-shared.js";
import { ensureColumns as ensureCompanyColumns, findCompany as findScopedCompany } from "./collab-company-profile.js";

async function handleValidate(req, res, pool) {
  let _partyHasBills = false;   // 该方是否有可见账单行；决定 billing 卡片出不出
  const raw = req.query && req.query.token;
  if (!raw || raw.length < 10)
    return res.status(400).json({ valid: false, error: "token 缺失" });

  const hash = rawToHash(raw);
  const { rows } = await pool.query(
    `SELECT recipient_role, meta, expires_at, created_at
       FROM magic_links
      WHERE token_hash = $1
        AND recipient_role IN ('factory_booking','customer_booking','trucking_booking','broker_booking','supplier_portal','shipper_booking','customer_quote')
        AND expires_at > NOW()
        AND revoked_at IS NULL
      LIMIT 1`,
    [hash]
  );
  if (!rows.length)
    return res.json({ valid: false, error: "链接无效或已过期" });

  const { recipient_role: role, meta: rawMeta } = rows[0];
  {
    const _m = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta) || {};
    if (role === "customer_quote") {
      return res.json({ valid: true, role, meta: { customer_company_id: _m.customer_company_id || null } });
    }
  }
  const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta) || {};
  const factoryScope = meta.factory_scope || null;
  const portalScope = role === "supplier_portal"
    ? { segments: meta.segments || ["ocean","truck","customs"], company_label: meta.company_label || null, field_profile: meta.field_profile || null }
    : null;
  // 货代看自己的公司资料+联系人（图2 卡片用）——本方看本方，非跨方泄露
  if (role === "supplier_portal" && portalScope && portalScope.company_label) {
    try {
      const cp = await pool.query(
        `SELECT code, name_cn, name_en, short_name, contact_name, contact_phone, contact_email, address, legal_representative
           FROM companies
          WHERE name_cn = $1 OR code = $2 OR short_name = $1
          ORDER BY (merged_into_code IS NULL) DESC, id LIMIT 1`,
        [portalScope.company_label, meta.company_code || null]);
      if (cp.rows.length) portalScope.company_profile = cp.rows[0];
    } catch (e) {}
  }
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId)
    return res.json({ valid: false, error: "链接数据异常 — 缺少 shipment_id" });

  // Fetch plan + orders
  const planRes = await pool.query(
    `SELECT sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta,
            sp.container_type, sp.container_qty, sp.collab_status,
            sp.total_cartons, sp.gross_weight_kg, sp.total_cbm, sp.freight_term,
            sp.raw->'customer_item_notes' AS customer_item_notes,
            sp.raw->'doc_sends' AS doc_sends,
            sp.raw->'factory_cargo' AS factory_cargo,
            sp.raw->'factory_attrs' AS factory_attrs,
            sp.raw->'bl_confirmation' AS bl_confirmation,
            sp.raw->'customer_amend' AS customer_amend,
            sp.trucking_arrange, sp.customs_arrange,
            sp.forwarder_cn, sp.forwarder_en, sp.trucking_company_cn, sp.trucking_cn, sp.customs_broker_cn, sp.customs_cn,
            sp.so_no, sp.bl_no, sp.cargo_cutoff, sp.carrier_code, sp.vessel, sp.voyage,
            sp.freight_sale_usd, sp.freight_term AS plan_freight_term,
            sp.logistics_provider_kind, sp.trade_owner_kind,
            sp.raw->>'so_bl_reference' AS so_bl_reference,
            sp.raw->'so_bl_ref_pending' AS so_bl_ref_pending,
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
                  'contract_no', o.contract_no,
                  'brand', o.brand,
                  'trade_terms', o.trade_terms,
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
                      'brand',       oli.brand,
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
      GROUP BY sp.id, sp._id, sp.shipment_no, sp.pol, sp.pod, sp.etd, sp.eta, sp.so_no, sp.bl_no, sp.cargo_cutoff, sp.carrier_code, sp.vessel, sp.voyage, sp.freight_sale_usd, sp.logistics_provider_kind, sp.trade_owner_kind, sp.release_type, sp.source_system,
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

  // 2026-08-05 双成交方式:工厂页的交易条款必须是【采购侧】(工厂→巴匕),不是销售侧。
  // 病象:工厂页 6 个条款一个都没选中(plan.freight_term 空),Damon 选过 EXW 也不回填。
  // 本票所有单口径一致才回填;不一致就留空让工厂自己选(宁可不填,不猜)。
  let factoryPurchaseTerm = null;
  if (role === "factory_booking") {
    try {
      const _pt = await pool.query(
        "SELECT purchase_trade_terms AS t, count(*) AS n FROM orders" +
        " WHERE shipping_plan_id=$1 AND COALESCE(purchase_trade_terms,'') NOT IN ('','PENDING')" +
        " GROUP BY 1 ORDER BY n DESC LIMIT 2", [planId]);
      if (_pt.rows.length === 1) factoryPurchaseTerm = _pt.rows[0].t;
    } catch (e) { console.warn("[collab-validate] 取采购侧成交方式失败:", e.message); }
  }

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

  // 承包方公司名规范化：链接里存的可能是已废弃的合并别名（如「[已合并]瀚龙→CN-00071」），
  // 对外门户一律显示真身公司全名（厦门瀚龙国际物流有限公司）。解析规则：
  //   1) 别名尾部「→CODE」→ 按 code 查 companies.name_cn（未再被合并的真身）
  //   2) 别名本身是某条已合并公司 → 顺 merged_into_code 找真身
  //   3) 都查不到 → 至少剥掉「[已合并]」前缀与「→…」尾巴
  if (portalScope && portalScope.company_label) {
    const lab = String(portalScope.company_label);
    let resolved = null;
    try {
      const m = lab.match(/→\s*([A-Za-z0-9-]+)/);
      if (m) {
        const cr = await pool.query(
          `SELECT name_cn FROM companies
             WHERE code = $1 AND COALESCE(merged_into_code,'') = '' AND COALESCE(name_cn,'') <> ''
             LIMIT 1`, [m[1]]);
        if (cr.rows.length) resolved = cr.rows[0].name_cn;
      }
      if (!resolved) {
        const cr2 = await pool.query(
          `SELECT c2.name_cn FROM companies c1
             JOIN companies c2 ON c2.code = c1.merged_into_code
             WHERE c1.name_cn = $1 AND COALESCE(c2.name_cn,'') <> ''
             LIMIT 1`, [lab]);
        if (cr2.rows.length) resolved = cr2.rows[0].name_cn;
      }
    } catch (e) { /* 解析失败不阻断门户，走下方剥壳兜底 */ }
    portalScope.company_label = resolved || lab.replace(/^\[已合并\]\s*/, "").replace(/→.*$/, "").trim() || lab;
  }

  // 检疫报告是否存在（真源=document_uploads，按 plan→orders 的 contract_no 或 order_no 匹配；
  // du.contract_no 字段有的存合同号有的存订单号，两头都匹配才不漏）
  let quarantineDocs = [];
  try {
    const { rows: qr } = await pool.query(
      `SELECT DISTINCT du.id, COALESCE(NULLIF(du.name,''), '检疫报告') AS name
         FROM document_uploads du
         JOIN orders o ON (o.contract_no = du.contract_no OR o.order_no = du.contract_no)
        WHERE o.shipping_plan_id = $1 AND du.doc_type = 'quarantine_report'
          AND COALESCE(du.stamped_url, du.url) IS NOT NULL
        ORDER BY du.id`, [planId]);
    quarantineDocs = qr.map(r => ({ ref: String(r.id), name: r.name })); // 一票可多份(拼柜每单一张CIQ)，全列出
  } catch (e) { /* 检疫探测失败不阻断门户 */ }

  const carrierRequirements = await materializeAndList(pool, planId, {
    role,
    internal: meta.field_profile === "upstream_downstream" || meta.field_profile === "shipping_booking",
  }).catch(() => []);
  const companyProfile = await (async () => {
    try {
      await ensureCompanyColumns(pool);
      return await findScopedCompany(pool, { role, meta, planId });
    } catch (e) { return null; }
  })();
  if (role === "supplier_portal" && portalScope && companyProfile) portalScope.company_profile = companyProfile;

  return res.json({
    valid: true,
    role,
    company_profile: companyProfile,
    // 协同版本戳（Damon 2026-08-06）：线上跑的是哪一版，外部页脚可直接显示
    collab_version: COLLAB_VERSION,
    collab_version_at: COLLAB_VERSION_AT,
    carrier_requirements: carrierRequirements,
    // factory_booking 下 preview 标志无意义，不能驱动前端显示全貌。
    is_preview: role !== "factory_booking" && meta.preview === true,
    preview_godview: role !== "factory_booking" && meta.preview === true && !(factoryScope && factoryScope.label),
    factory_progress: await (async (roleX) => {
      // 分厂确认进度：有 scoped 链接才有意义（拼柜/分柜）
      const { rows: fl } = await pool.query(
        `SELECT DISTINCT meta->'factory_scope'->>'label' AS label FROM magic_links
          WHERE recipient_role = 'factory_booking'
            AND (meta->>'shipment_id')::int = $1
            AND meta->'factory_scope' IS NOT NULL AND revoked_at IS NULL`, [planId]);
      if (!fl.length) return null;
      if (roleX === "factory_booking") return null;   // 工厂绝不见跨厂进度/厂数(存在也是泄露)
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
      sheet.quarantine_docs = quarantineDocs;              // 检疫报告清单（真源 document_uploads，每份带 ref=du.id）
      sheet.has_quarantine = quarantineDocs.length > 0;   // 兼容旧判断
      sheet.containers_live = cbRes.rows;
      // 本票汇总(CBM/箱数/毛净重)：真源在 order_line_items(cbm_ctn×qty_ctn),plan级 total_cbm 常年空。
      // 货代/工厂装柜要看 CBM，这里从订单行现算并回填(不覆盖已有非空值)。
      (function(){
        let cbm=0, ctn=0, gw=0;
        (Array.isArray(sheet.orders)?sheet.orders:[]).forEach(o=>(Array.isArray(o&&o.items)?o.items:[]).forEach(it=>{
          cbm+=Number(it.cbm||0); ctn+=Number(it.ctns||0); gw+=Number(it.gw_kgs||0);
        }));
        if((sheet.total_cbm==null||Number(sheet.total_cbm)===0) && cbm>0) sheet.total_cbm = Math.round(cbm*1000)/1000;
        if((sheet.total_cartons==null||Number(sheet.total_cartons)===0) && ctn>0) sheet.total_cartons = ctn;
        if((sheet.gross_weight_kg==null||Number(sheet.gross_weight_kg)===0) && gw>0) sheet.gross_weight_kg = Math.round(gw*10)/10;
      })();
      // ⚠️ 不能塞进 freight_term:它在 FORBIDDEN_KEYS 硬黑名单里(对客条款,外部方一律不许见,
      //    与"发货人不得见下游客户"同属命脉红线)。工厂看的是【它自己那侧】,本就是另一个概念,
      //    所以用独立字段名 factory_purchase_term。
      if (factoryPurchaseTerm) sheet.factory_purchase_term = factoryPurchaseTerm;
      // 2026-08-04:下面会用 container_bookings 重建 containers_detail,但 plan 上那份
      // (claude-shipping-intake 等录进来的真箱号/封号)不能丢 —— 先存下按 seq 兜底。
      // 实测漏了会让 68 票/187 柜在所有协同页显示"待回填",库里其实全有。
      const _planDetail = Array.isArray(sheet.containers_detail) ? sheet.containers_detail : [];
      const _planBySeq = new Map(_planDetail.map((c, i) => [Number((c && (c.seq || c.container_seq)) || i + 1), c || {}]));
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
        const old = _planBySeq.get(seq) || {};   // plan 上原有真值,作为最后一道兜底
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
          container_no: live.container_no || old.container_no || "",
          seal_no: live.seal_no || veh.seal_no || old.seal_no || null,
          container_type: live.container_type || old.container_type || sheet.container_type || null,
          tare_weight_kg: toNumOrNull(live.tare_weight_kg != null ? live.tare_weight_kg : (veh.tare_kg != null ? veh.tare_kg : old.tare_weight_kg)),
          cargo_weight_kg: toNumOrNull(live.cargo_weight_kg != null ? live.cargo_weight_kg : (veh.weigh_kg != null ? veh.weigh_kg : old.cargo_weight_kg)),
          vgm_weight_kg: toNumOrNull(live.vgm_weight_kg != null ? live.vgm_weight_kg : old.vgm_weight_kg),
          driver_name: live.driver_name || veh.driver || old.driver_name || null,
          driver_phone: live.driver_phone || veh.driver_phone || null,
          driver_id_no: live.driver_id_no || veh.driver_id_no || null,
          plate: live.plate || live.trailer_plate || veh.plate || veh.trailer_plate || old.plate || null,
          loading_address: live.loading_address || veh.loading_address || old.loading_address || (factoryProfileAddress && factoryProfileAddress.address) || null,
          loading_contact: live.loading_contact || veh.loading_contact || old.loading_contact || null,
          driver_photos: driverPhotos,
          plate_photos: platePhotos,
          ...pickupFor(seq),
          ...doneState(seq),
        };
      });
      // 单柜票：本票 CBM 精确归到这唯一的柜（多柜按行归柜的映射 DB 里没有，只在票级给 total_cbm，前端标「本票」）
      if (Array.isArray(sheet.containers_detail) && sheet.containers_detail.length === 1 && sheet.total_cbm != null)
        sheet.containers_detail[0].cbm = Number(sheet.total_cbm);
      // 价格：只有客户能看，且只给卖价——cost 一律不出 API
      const costLines = Array.isArray(sheet._cost_lines_raw) ? sheet._cost_lines_raw : [];
      delete sheet._cost_lines_raw;
      // 2026-08-05 Damon:「物流费他没账单，不该有这个的」
      // 该方一条可见账单行都没有 → 不下发 billing token → 前端整张卡不渲染
      _partyHasBills = visibleBillLines(costLines, {
        role, field_profile: meta.field_profile || null, plan: planRes.rows[0],
      }).length > 0;
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
      // 方案A：factory_booking 永远 scoped-or-failclosed。
      // 内部全貌只能走登录态 collab-hub；工厂页 token 不再存在 preview godview 豁免。
      if (role === "factory_booking") {
        delete sheet.customer_name; delete sheet.customer_en;   // 工厂只见下游 issuing_company
        delete sheet.customer_selected_sailing;
        (sheet.orders || []).forEach(o => (o.items || []).forEach(it => { delete it.unit_price; delete it.amount; delete it.declare_amount; })); // hongxian: factory sees purchase side only (cargo-payment); strip sales unit_price/amount/declare
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
      // supplier_portal visibility is centralized in collab-field-profiles.
      // shipper_booking 发货人只做港杂账单(走 invoice-collab-section→invoice-collab-confirm)，
      // 无权访问订舱 sheet：若 shipper token 被手动指向 collab-portal，validate 一律 fail-closed，
      // 绝不返回下游客户/条款/订单/柜/航班(命脉红线：发货人不得见下游客户)。
      if (role === "shipper_booking") {
        delete sheet.customer_name; delete sheet.customer_en;
        delete sheet.freight_term; delete sheet.plan_freight_term; delete sheet.customer_selected_sailing;
        sheet.orders = []; sheet.factory_cargo = []; sheet.factory_entry = {};
        sheet.containers_live = []; sheet.containers_detail = []; sheet.factory_loading_done = {};
        sheet.sailings = []; sheet.scope_missing = true;
      }
        // 红线扩展(2026-07-29): 车队/报关行与工厂同样保留 orders 却未删销售价, 补齐剥离; 只有客户可见订单销售 unit_price(=她自己采购价), 内部走登录态
      if (role === "trucking_booking" || role === "broker_booking") {
        (sheet.orders || []).forEach(o => (o.items || []).forEach(it => { delete it.unit_price; delete it.amount; delete it.declare_amount; }));
      }
      // 🔴 对外参照号(2026-08-05 Damon)：CY号是内部代码，绝不外发。
      //    工厂/供应链 → 看订单号(40-LL-7 / LL-23)；货代/船司/车队/报关 → 看他自己给的 BL 或 SO。
      //    取不到就留空，绝不回落 shipment_no。
      const _ordRefs = (sheet.orders || [])
        .map(o => String(o && o.order_no || "").trim()).filter(Boolean);
      // 2026-08-06：so_no/bl_no 对工厂已屏蔽，但「是否已订舱」这个状态工厂要知道
      // （决定柜型锁不锁）。→ 下发布尔值，绝不下发号码本身。
      sheet.is_booked = !!(String(sheet.so_no||"").trim() || String(sheet.bl_no||"").trim());
      sheet.ext_ref =
        (role === "factory_booking")
          ? (_ordRefs.length ? [...new Set(_ordRefs)].join(" / ") : "")
          : (String(sheet.bl_no || "").trim() || String(sheet.so_no || "").trim() || "");
    return sanitizeSheet(sheet, { role, field_profile: meta.field_profile || null, plan: planRes.rows[0] });
    })(),
    ...(factoryProfileAddress ? { factory_profile_address: factoryProfileAddress } : {}),
    factory_scope: factoryScope,
    portal_scope: portalScope,
    dispatched_at: rows[0].created_at || null,   // 委托/接单时间戳（本票何时派给该方）
    billing: {
      token: _partyHasBills ? raw : null,        // 无账单不给 token
      show_amount: _partyHasBills,
      segment: (() => {
        const segment = billingSegmentFor({ role, field_profile: meta.field_profile || null });
        return role === "supplier_portal" && !meta.field_profile && segment === "ocean"
          ? ((portalScope && portalScope.segments && portalScope.segments[0]) || "supplier")
          : segment;
      })(),
    },
  });
}

export { handleValidate };
