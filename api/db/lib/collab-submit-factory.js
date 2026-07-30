// collab-submit-factory.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import fs from "fs";
import { rawToHash } from "./collab-shared.js";

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

function customsVatMultiplierFromHs(hs) {
  const clean = String(hs || "").replace(/\D/g, "");
  if (!clean) return null;
  if (clean.startsWith("2309")) return 1.09;
  return 1.13;
}

// ── POST /factory-submit ──────────────────────────────────────
async function handleFactorySubmit(req, res, pool) {
  const { token, cargo_ready_date, container_type, cargo_type, remarks } = req.body || {};
  // 工厂自填分柜明细（订单没挂/明细缺失时）：raw.factory_cargo 留痕，绝不覆盖订单真值
  let factoryCargo = Array.isArray(req.body.containers) ? req.body.containers : null;
  if (factoryCargo) {
    for (const x of factoryCargo) {
      if (x && x.price != null && x.price !== "" && !customsVatMultiplierFromHs(x.hs_code)) {
        return res.status(400).json({ ok: false, error: "customs_price_blocked_missing_hs", message: "工厂价格行缺 HS 编码，无法按 HS 取报关税率，已阻断" });
      }
    }
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
          const customsVat = customsVatMultiplierFromHs(x.hs_code);
          const qty = x.pkg_qty != null ? Number(x.pkg_qty) : null;
          return { price: pr, price_type: taxed ? "taxed" : "untaxed", tax_points: pts,
                   price_untaxed: untaxed,
                   invoice_price: invoicePrice,                              // 给工厂看的开票价(1.11档)
                   customs_price: +(untaxed * customsVat).toFixed(4),        // 报关价=未含税×HS增值税率(2309=9%,其他制成品=13%)
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
     ["FOB","CIF","CFR","CNF","EXW","DDP","FCA","CPT","CIP","DAP","DPU"].includes(req.body.freight_term) ? req.body.freight_term : null,
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

export { handleFactorySubmit };
