// /api/db/order-create-v2.js — New order creation (SQL-first, full schema)
// POST: create order with customer + products selection
// GET: fetch form helpers (customers list, products list)
import { getPool, setCors } from "../db.js";

function generateOrderNo() {
  var d = new Date();
  var prefix = "ORD-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  return prefix + "-" + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function generateContractNo() {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  var seq = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return "FS" + y + m + day + seq;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();

  // ── GET: return form data (customers + recent orders for next number) ──
  if (req.method === "GET") {
    try {
      var customers = await pool.query(
        "SELECT DISTINCT company_code, company_name_cn, company_name_en FROM orders WHERE company_code IS NOT NULL AND company_code != '' GROUP BY company_code, company_name_cn, company_name_en ORDER BY company_name_en"
      ).catch(function() { return { rows: [] }; });

      // Also try customers table
      var custTable = await pool.query(
        "SELECT _id, company_code, company_name_cn, company_name_en, raw FROM customers ORDER BY company_name_en"
      ).catch(function() { return { rows: [] }; });

      // Merge: customers table is source of truth, supplement from orders
      var customerMap = {};
      (custTable.rows || []).forEach(function(c) {
        var code = c.company_code || c._id;
        if (code) customerMap[code] = {
          companyCode: code,
          companyNameCN: c.company_name_cn || "",
          companyNameEN: c.company_name_en || "",
          raw: c.raw || {}
        };
      });
      (customers.rows || []).forEach(function(c) {
        if (c.company_code && !customerMap[c.company_code]) {
          customerMap[c.company_code] = {
            companyCode: c.company_code,
            companyNameCN: c.company_name_cn || "",
            companyNameEN: c.company_name_en || "",
          };
        }
      });

      // Get latest order number for reference
      var lastOrder = await pool.query(
        "SELECT order_no, contract_no FROM orders WHERE order_no IS NOT NULL ORDER BY created_at DESC LIMIT 1"
      ).catch(function() { return { rows: [] }; });

      return res.status(200).json({
        success: true,
        customers: Object.values(customerMap),
        lastOrderNo: lastOrder.rows[0]?.order_no || null,
        lastContractNo: lastOrder.rows[0]?.contract_no || null,
        nextOrderNo: generateOrderNo(),
        nextContractNo: generateContractNo(),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: create order ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var body = req.body || {};
    var {
      companyCode, companyNameCN, companyNameEN, groupCode, brand, category,
      consignee, customerAddress, phone, email,
      country, destinationPort, pol,
      deliveryDate, confirmedDelivery, requiredArrival,
      currency, exchangeRate,
      factory, issuingCompany, issuingCompanyEN,
      remarks, products, createdBy
    } = body;

    if (!companyNameCN && !companyNameEN) return res.status(400).json({ error: "客户名称必填" });
    if (!products || !products.length) return res.status(400).json({ error: "请添加产品" });

    var orderNo = body.orderNo || generateOrderNo();
    var contractNo = body.contractNo || generateContractNo();

    // Calculate totals from products
    var totalQty = 0, totalAmount = 0, totalAmountFactory = 0;
    var totalCBM = 0, grossWeight = 0, netWeight = 0;
    var declareAmount = 0;

    var cleanProducts = products.map(function(p) {
      var qty = parseInt(p.qty) || 0;
      var unitPrice = parseFloat(p.unitPrice) || parseFloat(p.price) || 0;
      var factoryPrice = parseFloat(p.factoryPrice) || parseFloat(p.factory_price) || unitPrice;
      var subtotal = parseFloat(p.subtotal) || (unitPrice * qty);
      var factorySubtotal = factoryPrice * qty;
      var pCbm = (parseFloat(p.cbm) || 0) * qty;
      var pGW = (parseFloat(p.grossWeight) || parseFloat(p.gross_weight) || 0) * qty;
      var pNW = (parseFloat(p.netWeight) || parseFloat(p.net_weight) || 0) * qty;
      var pDeclare = (parseFloat(p.declareAmount) || parseFloat(p.declareAmountPerBox) || 0) * qty;

      totalQty += qty;
      totalAmount += subtotal;
      totalAmountFactory += factorySubtotal;
      totalCBM += pCbm;
      grossWeight += pGW;
      netWeight += pNW;
      declareAmount += pDeclare;

      return {
        name: p.name || p.productName || "",
        code: p.code || p.barcode || "",
        brand: p.brand || "",
        category: p.category || p.cat1 || "",
        hsCode: p.hsCode || p.hs_code || "",
        size: p.size || p.spec || "",
        qty: qty,
        unit: p.unit || "CTN",
        unitPrice: unitPrice,
        factoryPrice: factoryPrice,
        subtotal: subtotal,
        factorySubtotal: factorySubtotal,
        cbm: parseFloat(p.cbm) || 0,
        totalCbm: pCbm,
        grossWeight: parseFloat(p.grossWeight) || parseFloat(p.gross_weight) || 0,
        netWeight: parseFloat(p.netWeight) || parseFloat(p.net_weight) || 0,
        bagsPerBox: parseInt(p.bagsPerBox) || parseInt(p.bags_per_box) || 0,
        declareAmountPerBox: parseFloat(p.declareAmount) || parseFloat(p.declareAmountPerBox) || 0,
        vatRate: parseFloat(p.vatRate) || parseFloat(p.vat_rate) || 0,
        taxRebateRate: parseFloat(p.taxRebateRate) || parseFloat(p.tax_rebate_rate) || 0,
      };
    });

    // Auto container type
    var containerType = body.containerType || (totalCBM < 30 ? "20GP" : "40HQ");
    var containerQty = parseInt(body.containerQty) || 1;

    // Tax rebate calculation (use first product's rate as default)
    var vatRate = parseFloat(body.vatRate) || (cleanProducts[0]?.vatRate) || 0;
    var taxRebateRate = parseFloat(body.taxRebateRate) || (cleanProducts[0]?.taxRebateRate) || 0;
    var taxRebateAmount = declareAmount > 0 ? (declareAmount / (1 + vatRate) * taxRebateRate) : 0;

    // Profit = sales - factory cost (simplified, not including logistics)
    var profit = totalAmount - totalAmountFactory;

    var portalId = "order_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    var sql = `INSERT INTO orders (
      _id, order_no, contract_no, customer_po,
      company_code, company_name_cn, company_name_en, group_code, brand, category,
      consignee, customer_address, phone, email,
      country, destination_port, destination, pol,
      delivery_date, confirmed_delivery, required_arrival,
      total_qty, total_cbm, gross_weight, net_weight,
      container_type, container_qty,
      total_amount, total_amount_factory, currency, exchange_rate,
      profit, declare_amount, vat_rate, tax_rebate_rate, tax_rebate_amount,
      status, production_status,
      products, factory, issuing_company, issuing_company_en, remarks,
      source, created_by, customer, raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,
      $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,
      $36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46
    ) RETURNING _id, order_no, contract_no, total_amount, total_amount_factory, profit, status`;

    var vals = [
      portalId, orderNo, contractNo, body.customerPO || null,
      companyCode || "", companyNameCN || "", companyNameEN || "", groupCode || "", brand || "", category || "",
      consignee || "", customerAddress || "", phone || "", email || "",
      country || "", destinationPort || "", pol || "",
      deliveryDate || null, confirmedDelivery || null, requiredArrival || null,
      totalQty, parseFloat(totalCBM.toFixed(3)), parseFloat(grossWeight.toFixed(2)), parseFloat(netWeight.toFixed(2)),
      containerType, containerQty,
      parseFloat(totalAmount.toFixed(2)), parseFloat(totalAmountFactory.toFixed(2)), currency || "CNY", parseFloat(exchangeRate) || null,
      parseFloat(profit.toFixed(2)), parseFloat(declareAmount.toFixed(2)), vatRate || null, taxRebateRate || null, parseFloat(taxRebateAmount.toFixed(2)),
      "pending", null,
      JSON.stringify(cleanProducts), factory || "", issuingCompany || "", issuingCompanyEN || "", remarks || "",
      "admin", createdBy || "admin", companyNameEN || companyNameCN || "",
      JSON.stringify(body)
    ];

    var result = await pool.query(sql, vals);
    var order = result.rows[0];

    return res.status(200).json({
      success: true,
      order: order,
      summary: {
        orderNo: order.order_no,
        contractNo: order.contract_no,
        customer: companyNameEN || companyNameCN,
        totalAmount: totalAmount,
        totalAmountFactory: totalAmountFactory,
        profit: profit,
        totalQty: totalQty,
        totalCBM: totalCBM,
        containerType: containerType,
        productCount: cleanProducts.length,
      }
    });
  } catch (err) {
    console.error("[order-create-v2]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
