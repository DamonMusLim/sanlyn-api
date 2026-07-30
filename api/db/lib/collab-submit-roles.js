// collab-submit-roles.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import { rawToHash } from "./collab-shared.js";

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
      ["FOB","CIF","CFR","CNF","EXW","DDP","FCA","CPT","CIP","DAP","DPU"].includes((req.body||{}).freight_term) ? req.body.freight_term : null,
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
  const ft = ["FOB","CIF","CFR","CNF","EXW","DDP","FCA","CPT","CIP","DAP","DPU"].includes(req.body.freight_term)
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

export { handleCustomerSubmit, handleTruckingSubmit, handleBrokerSubmit, handleCustomerNotes };
