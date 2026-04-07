// /api/db/shipping-plan-create.js — Shipping plan creation / editing
// GET  ?action=init              → pending orders for selection
// GET  ?action=detail&id=xxx     → single plan detail
// POST                           → create new plan
// PATCH ?id=xxx                  → update existing plan
// DELETE ?id=xxx                 → delete plan
import { getPool, setCors } from "../db.js";

function generateShipmentNo() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  var seq = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return "SP" + y + m + day + seq;
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
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS insurance_cn TEXT;
  ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS remarks TEXT;
`;

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();

  // ── GET ──
  if (req.method === "GET") {
    try {
      var action = req.query.action || "init";

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
        nextShipmentNo: generateShipmentNo(),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH: update existing plan ──
  if (req.method === "PATCH") {
    try {
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
      return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error("[shipping-plan-create PATCH]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── DELETE ──
  if (req.method === "DELETE") {
    try {
      var id = req.query.id;
      if (!id) return res.status(400).json({ error: "_id required" });
      var del = await pool.query("DELETE FROM shipping_plans WHERE _id = $1 RETURNING _id", [id]);
      if (!del.rows.length) return res.status(404).json({ error: "Not found" });
      return res.status(200).json({ success: true, deleted: del.rows[0]._id });
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
      forwarderCN, forwarderEN, truckingCN, customsCN, insuranceCN,
      freightCost, freightSaleUSD,
      docFee, tlxFee, infoTransFee, bkgFee, thcFee, eirFee, sealFee,
      freightTotalUSD, freightTotalCNY,
      portSurchargeTotal, truckingCostTotal, customsCostTotal, insuranceCost,
      containersDetail, truckingDetail,
      isDdp, ddpTotal, ddpAgent,
      flowStatus, remarks, createdBy
    } = body;

    var sNo = shipmentNo || generateShipmentNo();
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
      flow_status, remarks, created_by
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
      $56,$57,$58
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
      flowStatus || "待订舱", s(remarks), createdBy || "admin"
    ];

    var result = await pool.query(sql, vals);
    var plan = result.rows[0];

    // Mark linked orders as confirmed
    if (orderNos && orderNos.length) {
      var nos = arr(orderNos);
      await pool.query(
        "UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE order_no = ANY($1) AND status = 'pending'",
        [nos]
      ).catch(function() {});
    }

    return res.status(200).json({
      success: true,
      data: plan,
      summary: { shipmentNo: plan.shipment_no, soNo: plan.so_no, vessel: vessel, etd: etd, orderNos: orderNos }
    });
  } catch (err) {
    console.error("[shipping-plan-create POST]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
