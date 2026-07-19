// /api/db/shipping-plan-create.js — Shipping plan creation / editing
import { getPool, setCors } from "../db.js";
import { mirrorPlanBlToOrders } from "../lib/bl-order-mirror.js"; // 2026-07-13: bl_no 镜像同步到 orders
import { enableContractSplit } from "./lib/shipping-plan-contracts.js";
import { autoIssueCollabLinks } from "./lib/collab-auto-links.js";

// Production convention: CY00000 sequential.
// Real order count reached 146 before the system caught up — old rows
// (CY00001..CY00045) stay untouched; new numbering continues from 146+.
// So we floor at CY00146 so nothing dips back into the legacy gap.
const MIN_SHIPMENT_SEQ = 146;
async function generateShipmentNo(pool) {
  try {
    const { rows } = await pool.query(
      "SELECT shipment_no FROM shipping_plans WHERE shipment_no ~ '^CY[0-9]{5}$' ORDER BY shipment_no DESC LIMIT 1"
    );
    const last = rows[0]?.shipment_no || "CY00000";
    const n = Math.max(parseInt(last.slice(2), 10), MIN_SHIPMENT_SEQ) + 1;
    return "CY" + String(n).padStart(5, "0");
  } catch (e) {
    return "CY" + String(Date.now()).slice(-5);
  }
}

var ENSURE_COLS = `
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS so_no TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS si_cutoff_date TIMESTAMP;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS port_open_date DATE;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS atd DATE;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS ata DATE;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS transit TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS schedule TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS call_port TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS doc_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS tlx_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS info_trans_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS bkg_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS thc_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS eir_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS seal_fee NUMERIC(10,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS freight_total_usd NUMERIC(12,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS freight_total_cny NUMERIC(12,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS containers_detail JSONB;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS trucking_detail JSONB;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS insurance_cost NUMERIC(12,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS is_ddp BOOLEAN DEFAULT FALSE;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS ddp_total NUMERIC(12,2);
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS ddp_agent TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS order_nos TEXT[];
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS contract_nos TEXT[];
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS customer_en TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS customer_cn TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS forwarder_en TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS forwarder_company_id INT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS insurance_cn TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS remarks TEXT;
`;

// 软删 + 取消 + 审计列 (2026-06-26: 取消后才能删 / 删除可找回 / 操作留痕)
var SOFT_COLS = `
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS deleted_by TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
`;
var AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS shipping_plan_audit (
    id BIGSERIAL PRIMARY KEY,
    plan_id INTEGER,
    plan_uid TEXT,
    action TEXT NOT NULL,
    actor TEXT,
    detail JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
  );
`;
async function writeAudit(pool, plan, action, actor, detail) {
  try {
    await pool.query(
      "INSERT INTO shipping_plan_audit (plan_id, plan_uid, action, actor, detail) VALUES ($1,$2,$3,$4,$5::jsonb)",
      [plan && plan.id != null ? plan.id : null, plan && plan._id ? plan._id : null, action, actor || "admin", JSON.stringify(detail || {})]
    );
  } catch (e) { console.warn("[shipping audit]", e.message); }
}
function actorOf(req) {
  var u = req.user || {};
  return u.name || u.username || u.email || u.role || "admin";
}
function wantsContractSplit(body) {
  return body && (
    body.contract_split_enabled === true ||
    body.contractSplitEnabled === true ||
    body.enableContractSplit === true ||
    body.splitContracts === true
  );
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  var pool = getPool();

  // ── GET ──
  if (req.method === "GET") {
    try {
      var action = req.query.action || "init";

      if (action === "migrate") {
        await pool.query(SOFT_COLS).catch(function(e){ console.warn("[migrate soft_cols]", e.message); });
        await pool.query(AUDIT_DDL).catch(function(e){ console.warn("[migrate audit_ddl]", e.message); });
        return res.status(200).json({ success: true, migrated: ["deleted_at","deleted_by","cancelled_at","cancelled_by","shipping_plan_audit"] });
      }

      if (action === "audit") {
        var aid = req.query.id;
        var aq = aid
          ? await pool.query("SELECT * FROM shipping_plan_audit WHERE plan_id = $1 ORDER BY created_at DESC LIMIT 100", [aid])
          : await pool.query("SELECT * FROM shipping_plan_audit ORDER BY created_at DESC LIMIT 100");
        return res.status(200).json({ success: true, data: aq.rows });
      }

      if (action === "detail" && req.query.id) {
        var plan = await pool.query("SELECT * FROM shipping_plans WHERE _id = $1", [req.query.id]);
        if (!plan.rows.length) return res.status(404).json({ error: "Not found" });
        return res.status(200).json({ success: true, data: plan.rows[0] });
      }

      var ordersResult = await pool.query(
        "SELECT _id, order_no, contract_no, customer_po, company_name_en, company_name_cn, company_code, country, destination_port, pol, container_type, container_qty, total_amount, currency, total_cbm, gross_weight, net_weight, delivery_date, issuing_company, factory, status FROM orders WHERE status NOT IN ('shipped','cancelled') ORDER BY created_at DESC LIMIT 200"
      ).catch(function() { return { rows: [] }; });

      return res.status(200).json({
        success: true,
        orders: ordersResult.rows,
        nextShipmentNo: await generateShipmentNo(pool),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH: update existing plan ──
  if (req.method === "PATCH") {
    try {
      // 找回(恢复软删) — PATCH ?action=restore&id=<int id>
      if (req.query.action === "restore") {
        var rid = req.query.id || (req.body || {}).id;
        if (!rid) return res.status(400).json({ error: "id required" });
        var ractor = actorOf(req);
        var rr = await pool.query("UPDATE shipping_plans SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1 RETURNING id, _id, shipment_no", [rid]);
        if (!rr.rows.length) return res.status(404).json({ error: "Not found" });
        await writeAudit(pool, rr.rows[0], "restore", ractor, { shipment_no: rr.rows[0].shipment_no });
        return res.status(200).json({ success: true, restored: rr.rows[0].id });
      }

      var id = req.query.id || (req.body || {})._id;
      if (!id) return res.status(400).json({ error: "_id required for update" });

      var body = req.body || {};
      var UPDATABLE = [
        "shipment_no","so_no","bl_no","vessel","voyage","shipping_line","transit","schedule","call_port",
        "etd","eta","atd","ata","cutoff_date","si_cutoff_date","port_open_date","shipment_date",
        "container_no","container_type","container_qty","seal_no",
        "pol","pod",
        "customer","customer_en","customer_cn","company_code","order_nos","contract_nos",
        "forwarder_cn","forwarder_en","trucking_cn","customs_cn","insurance_cn",
        "forwarder_company_id",
        "freight_cost","freight_sale_usd",
        "doc_fee","tlx_fee","info_trans_fee","bkg_fee","thc_fee","eir_fee","seal_fee",
        "freight_total_usd","freight_total_cny",
        "port_surcharge_total","trucking_cost_total","customs_cost_total","insurance_cost",
        "containers_detail","trucking_detail",
        "is_ddp","ddp_total","ddp_agent",
        "flow_status","remarks"
      ];

      var sets = [];
      var params = [];
      for (var col of UPDATABLE) {
        if (body[col] !== undefined) {
          params.push(typeof body[col] === "object" ? JSON.stringify(body[col]) : body[col]);
          if (col === "containers_detail" || col === "trucking_detail" || col === "order_nos" || col === "contract_nos") {
            sets.push(col + " = $" + params.length + "::jsonb");
          } else {
            sets.push(col + " = $" + params.length);
          }
        }
      }
      if (!sets.length) return res.status(400).json({ error: "No fields to update" });
      params.push(new Date().toISOString());
      sets.push("updated_at = $" + params.length);
      params.push(id);
      var sql = "UPDATE shipping_plans SET " + sets.join(", ") + " WHERE _id = $" + params.length + " RETURNING *";
      var result = await pool.query(sql, params);
      if (!result.rows.length) return res.status(404).json({ error: "Plan not found" });
      var _blm = await mirrorPlanBlToOrders(pool, result.rows[0], actorOf(req));
      var _auto = body.forwarder_company_id !== undefined
        ? await autoIssueCollabLinks(pool, result.rows[0].id, ["forwarder"]).catch(e => ({ error: e.message }))
        : [];
      return res.status(200).json({ success: true, data: result.rows[0], bl_mirror: _blm, collab_auto_links: _auto });
    } catch (err) {
      console.error("[shipping-plan-create PATCH]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── DELETE (软删=移入回收站，可找回；取消后才能删；有报关记录则拦截) ──
  if (req.method === "DELETE") {
    try {
      var id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      await pool.query(SOFT_COLS).catch(function(){});   // 幂等保列存在
      var cur = await pool.query("SELECT id, _id, shipment_no, bl_no, flow_status, deleted_at FROM shipping_plans WHERE id = $1", [id]);
      if (!cur.rows.length) return res.status(404).json({ error: "Not found" });
      var plan = cur.rows[0];
      if (plan.deleted_at) return res.status(409).json({ error: "already_deleted", message: "该记录已在回收站中。" });
      // 闸1: 取消后才能删
      var st = String(plan.flow_status || "");
      var isCancelled = /cancel/i.test(st) || st.indexOf("已取消") >= 0 || st === "取消";
      if (!isCancelled) return res.status(409).json({ error: "must_cancel_first", message: "请先「取消订单」，取消后才能删除。" });
      // 闸2: 已有报关汇总记录则拦截(防报关失锚)，确需删除加 ?force=1
      var force = req.query.force === "1";
      if (plan.bl_no && !force) {
        var cc = await pool.query("SELECT 1 FROM customs_consolidated WHERE bl_no = $1 LIMIT 1", [plan.bl_no]).catch(function(){ return { rows: [] }; });
        if (cc.rows.length) return res.status(409).json({ error: "has_customs_records", message: "该票已有报关汇总(customs_consolidated)，删除会造成报关失锚。确需删除请加 ?force=1。" });
      }
      var actor = actorOf(req);
      var del = await pool.query("UPDATE shipping_plans SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, _id", [id, actor]);
      if (!del.rows.length) return res.status(409).json({ error: "already_deleted", message: "该记录已在回收站中。" });
      await writeAudit(pool, plan, "delete", actor, { bl_no: plan.bl_no, shipment_no: plan.shipment_no, force: force });
      return res.status(200).json({ success: true, soft_deleted: del.rows[0].id, recoverable: true, message: "已移入回收站，可找回。" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: create plan ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var body = req.body || {};

    // Ensure all new columns exist (safe to re-run)
    await pool.query(ENSURE_COLS).catch(function() {});

    var {
      shipmentNo, soNo, blNo, vessel, voyage, shippingLine, transit, schedule, callPort,
      etd, eta, atd, ata, cutoffDate, siCutoffDate, portOpenDate, shipmentDate,
      containerNo, containerType, containerQty, sealNo,
      pol, pod,
      customer, customerEN, customerCN, companyCode, orderNos, contractNos,
      forwarderCN, forwarderEN, truckingCN, customsCN, insuranceCN, forwarderCompanyId,
      freightCost, freightSaleUSD,
      docFee, tlxFee, infoTransFee, bkgFee, thcFee, eirFee, sealFee,
      freightTotalUSD, freightTotalCNY,
      portSurchargeTotal, truckingCostTotal, customsCostTotal, insuranceCost,
      containersDetail, truckingDetail,
      isDdp, ddpTotal, ddpAgent,
      flowStatus, remarks, createdBy
    } = body;

    // ── 准入闸(2026-06-11 Damon定): 买方必填; 内单必须有合同号; 外单必须显式标记 ──
    var isExternal = !!(body.isExternal || /外单|freight_external|freight_agency/.test(String(remarks || "")));
    if (!customer && !customerEN && !customerCN) {
      return res.status(400).json({ error: "买方公司必填(customer)——没有买方不进海运主表" });
    }
    var cnList = Array.isArray(contractNos) ? contractNos.filter(Boolean) : (contractNos ? [contractNos] : []);
    if (!isExternal && !cnList.length) {
      return res.status(400).json({ error: "内单必须带合同号(contractNos)；外单请显式传 isExternal=true 或备注标[外单]" });
    }

    var sNo = shipmentNo || await generateShipmentNo(pool);
    var portalId = "sp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shipping_plans (
        _id TEXT PRIMARY KEY,
        shipment_no TEXT UNIQUE,
        so_no TEXT,
        bl_no TEXT,
        vessel TEXT,
        voyage TEXT,
        shipping_line TEXT,
        transit TEXT,
        schedule TEXT,
        call_port TEXT,
        etd DATE,
        eta DATE,
        atd DATE,
        ata DATE,
        cutoff_date TIMESTAMP,
        si_cutoff_date TIMESTAMP,
        port_open_date DATE,
        shipment_date DATE,
        container_no TEXT,
        container_type TEXT,
        container_qty INT,
        seal_no TEXT,
        pol TEXT,
        pod TEXT,
        customer TEXT,
        customer_en TEXT,
        customer_cn TEXT,
        company_code TEXT,
        order_nos TEXT[],
        contract_nos TEXT[],
        forwarder_cn TEXT,
        forwarder_en TEXT,
        trucking_cn TEXT,
        customs_cn TEXT,
        insurance_cn TEXT,
        freight_cost NUMERIC(12,2),
        freight_sale_usd NUMERIC(12,2),
        doc_fee NUMERIC(10,2),
        tlx_fee NUMERIC(10,2),
        info_trans_fee NUMERIC(10,2),
        bkg_fee NUMERIC(10,2),
        thc_fee NUMERIC(10,2),
        eir_fee NUMERIC(10,2),
        seal_fee NUMERIC(10,2),
        freight_total_usd NUMERIC(12,2),
        freight_total_cny NUMERIC(12,2),
        port_surcharge_total NUMERIC(12,2),
        trucking_cost_total NUMERIC(12,2),
        customs_cost_total NUMERIC(12,2),
        insurance_cost NUMERIC(12,2),
        containers_detail JSONB,
        trucking_detail JSONB,
        is_ddp BOOLEAN DEFAULT FALSE,
        ddp_total NUMERIC(12,2),
        ddp_agent TEXT,
        flow_status TEXT DEFAULT '待订舱',
        remarks TEXT,
        forwarder_company_id INT,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(function() {});

    var n = function(v) { return v ? parseFloat(v) || null : null; };
    var i = function(v) { return v ? parseInt(v) || null : null; };
    var s = function(v) { return v || null; };
    var arr = function(v) { return Array.isArray(v) ? v : (v ? [v] : []); };

    var sql = `INSERT INTO shipping_plans (
      _id, shipment_no, so_no, bl_no, vessel, voyage, shipping_line, transit, schedule, call_port,
      etd, eta, atd, ata, cutoff_date, si_cutoff_date, port_open_date, shipment_date,
      container_no, container_type, container_qty, seal_no, pol, pod,
      customer, customer_en, customer_cn, company_code, order_nos, contract_nos,
      forwarder_cn, forwarder_en, trucking_cn, customs_cn, insurance_cn,
      freight_cost, freight_sale_usd,
      doc_fee, tlx_fee, info_trans_fee, bkg_fee, thc_fee, eir_fee, seal_fee,
      freight_total_usd, freight_total_cny,
      port_surcharge_total, trucking_cost_total, customs_cost_total, insurance_cost,
      containers_detail, trucking_detail,
      is_ddp, ddp_total, ddp_agent,
      flow_status, remarks, created_by,
      forwarder_partner, forwarder_company_id
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,
      $25,$26,$27,$28,$29,$30,
      $31,$32,$33,$34,$35,
      $36,$37,
      $38,$39,$40,$41,$42,$43,$44,
      $45,$46,
      $47,$48,$49,$50,
      $51,$52,
      $53,$54,$55,
      $56,$57,$58,
      $59,$60
    ) RETURNING *`;

    var vals = [
      portalId, sNo, s(soNo), s(blNo), s(vessel), s(voyage), s(shippingLine), s(transit), s(schedule), s(callPort),
      s(etd), s(eta), s(atd), s(ata), s(cutoffDate), s(siCutoffDate), s(portOpenDate), s(shipmentDate),
      s(containerNo), s(containerType), i(containerQty)||1, s(sealNo), s(pol), s(pod),
      s(customer||customerEN||customerCN), s(customerEN), s(customerCN), s(companyCode),
      arr(orderNos), arr(contractNos),
      s(forwarderCN), s(forwarderEN), s(truckingCN), s(customsCN), s(insuranceCN),
      n(freightCost), n(freightSaleUSD),
      n(docFee), n(tlxFee), n(infoTransFee), n(bkgFee), n(thcFee), n(eirFee), n(sealFee),
      n(freightTotalUSD), n(freightTotalCNY),
      n(portSurchargeTotal), n(truckingCostTotal), n(customsCostTotal), n(insuranceCost),
      containersDetail ? JSON.stringify(containersDetail) : null,
      truckingDetail ? JSON.stringify(truckingDetail) : null,
      isDdp ? true : false, n(ddpTotal), s(ddpAgent),
      flowStatus || "待订舱", s(remarks), createdBy || "admin",
      // W0-4: explicit NULL prevents the DDL default '上海洋宝宝 × COSCO' from firing.
      // Caller must set forwarder via raw or POST body if they want it; never silently default.
      (req.body && (req.body.forwarderPartner || req.body.forwarder_partner)) || null,
      forwarderCompanyId || body.forwarder_company_id || null
    ];

    var result = await pool.query(sql, vals);
    var plan = result.rows[0];

    // 缺成本 → 自动开三段 RFQ（海运/车队/报关；自拖自报不开车队/报关；防重）
    if (plan.pol) {
      var ct = String(plan.container_type || "40HQ").toUpperCase().replace("HC", "HQ");
      var selfArr = plan.arrange_mode === "self";
      var rfqJobs = [];
      if (plan.freight_cost == null && plan.pod)
        rfqJobs.push(["ocean", plan.pol + "→" + plan.pod]);
      if (!selfArr && plan.trucking_cost_total == null)
        rfqJobs.push(["truck", "装柜→" + plan.pol]);
      if (!selfArr && plan.customs_cost_total == null)
        rfqJobs.push(["customs", plan.pol + " 出口报关"]);
      rfqJobs.forEach(function(job) {
        pool.query(
          `INSERT INTO freight_rfqs (pol, pod, ctnr_type, status, etd, route,
             shipping_plan_id, service_type, created_by)
           SELECT $1,$2,$3,'open',$4,$5,$6,$7,$8
           WHERE NOT EXISTS (
             SELECT 1 FROM freight_rfqs r
              WHERE r.shipping_plan_id = $6 AND COALESCE(r.service_type,'ocean') = $7
                AND r.status NOT IN ('closed','cancelled'))`,
          [plan.pol, plan.pod || null, ct, plan.etd || null, job[1],
           plan.id, job[0], createdBy || "auto"]
        ).catch(function(e) { console.warn("[plan-create] auto-RFQ skip:", e.message); });
      });
    }

    // Mark linked orders as confirmed + 回挂 shipping_plan_id + 带出开票公司（工厂端"下游"显示用）
    if (orderNos && orderNos.length) {
      var nos = arr(orderNos);
      await pool.query(
        "UPDATE orders SET status = 'confirmed', shipping_plan_id = $2, updated_at = NOW() WHERE order_no = ANY($1) AND (status = 'pending' OR shipping_plan_id IS NULL)",
        [nos, plan.id]
      ).catch(function() {});
      // 回填 order_contract_nos（列表「合同号」列读这个字段）+ contract_nos 数组
      await pool.query(
        `UPDATE shipping_plans sp
            SET order_contract_nos = d.cns,
                contract_nos = CASE WHEN sp.contract_nos IS NULL OR sp.contract_nos = '{}' THEN d.cn_arr ELSE sp.contract_nos END
           FROM (SELECT string_agg(DISTINCT o.contract_no, ',') AS cns,
                        array_agg(DISTINCT o.contract_no) AS cn_arr
                   FROM orders o
                  WHERE o.order_no = ANY($2) AND o.contract_no IS NOT NULL AND o.contract_no <> '') d
          WHERE sp.id = $1
            AND (sp.order_contract_nos IS NULL OR sp.order_contract_nos = '')
            AND d.cns IS NOT NULL`,
        [plan.id, nos]
      ).catch(function(e) { console.warn("[plan-create] contract_nos backfill skip:", e.message); });
      if (!plan.issuing_company) {
        pool.query(
          `UPDATE shipping_plans sp SET issuing_company = o.issuing_company
             FROM orders o
            WHERE sp.id = $1 AND o.order_no = ANY($2) AND o.issuing_company IS NOT NULL
              AND sp.issuing_company IS NULL`,
          [plan.id, nos]
        ).catch(function() {});
      }
    }

    if (wantsContractSplit(body)) {
      var splitClient = await pool.connect();
      try {
        await splitClient.query("BEGIN");
        plan = await enableContractSplit(
          splitClient,
          plan.id,
          body.contract_base_no || body.contractBaseNo || sNo
        );
        await splitClient.query("COMMIT");
        await writeAudit(pool, plan, "contract_split_enable", actorOf(req), {
          contract_base_no: plan.contract_base_no,
          contract_nos: plan.contract_nos,
          primary_contract_no: plan.primary_contract_no,
        });
      } catch (e) {
        await splitClient.query("ROLLBACK").catch(function(){});
        throw e;
      } finally {
        splitClient.release();
      }
    }

    var _blm = await mirrorPlanBlToOrders(pool, plan, actorOf(req));
    var _auto = await autoIssueCollabLinks(pool, plan.id).catch(e => ({ error: e.message }));
    return res.status(200).json({
      success: true,
      data: plan,
      summary: { shipmentNo: plan.shipment_no, soNo: plan.so_no, vessel: vessel, etd: etd, orderNos: orderNos },
      bl_mirror: _blm,
      collab_auto_links: _auto
    });
  } catch (err) {
    console.error("[shipping-plan-create POST]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
