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

  // ── GET: return form data ──
  // ?action=customers → customer list
  // ?action=customer-products&companyCode=XXX → customer's recent order products
  // default → customers + next numbers
  if (req.method === "GET") {
    try {
      var action = req.query.action || "init";

      // ── Customer's history products (for association) ──
      if (action === "customer-products" && req.query.companyCode) {
        var code = req.query.companyCode;
        // Get products from this customer's recent orders
        var recentOrders = await pool.query(
          "SELECT products, customer_po, order_no, created_at FROM orders WHERE company_code = $1 AND products IS NOT NULL ORDER BY created_at DESC LIMIT 10",
          [code]
        );
        // Extract unique products with latest qty/price
        var productMap = {};
        (recentOrders.rows || []).forEach(function(ord) {
          var prods = [];
          try { prods = typeof ord.products === "string" ? JSON.parse(ord.products) : (ord.products || []); } catch(e) {}
          prods.forEach(function(p) {
            var key = p.code || p.name;
            if (key && !productMap[key]) {
              productMap[key] = {
                name: p.name || "", code: p.code || "", brand: p.brand || "",
                size: p.size || "", unit: p.unit || "CTN",
                unitPrice: p.unitPrice || p.price || 0,
                cbm: p.cbm || 0, grossWeight: p.grossWeight || 0, netWeight: p.netWeight || 0,
                lastQty: p.qty || 0, lastOrderNo: ord.order_no,
                lastDate: ord.created_at,
                // Keep declare/tax info for finance
                bagsPerBox: p.bagsPerBox || 0,
                declareAmountPerBox: p.declareAmountPerBox || 0,
                vatRate: p.vatRate || 0, taxRebateRate: p.taxRebateRate || 0,
                hsCode: p.hsCode || "",
              };
            }
          });
        });

        // Also get this customer's default info
        var custInfo = await pool.query(
          "SELECT country, destination_port, customer_address, consignee, currency FROM orders WHERE company_code = $1 ORDER BY created_at DESC LIMIT 1",
          [code]
        ).catch(function() { return { rows: [] }; });

        return res.status(200).json({
          success: true,
          products: Object.values(productMap),
          orderCount: recentOrders.rows.length,
          defaults: custInfo.rows[0] || {},
        });
      }

      // ── Next PO number: {factoryPrefix}-{customerId}-{seq} e.g. ZC-03-61 ──
      if (action === "next-po" && req.query.factoryPrefix && req.query.customerId) {
        var fp = req.query.factoryPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "");
        var cid = String(parseInt(req.query.customerId) || 0).padStart(2, "0");
        var poPrefix = fp + "-" + cid + "-";
        var pattern = "^" + fp + "-" + cid + "-[0-9]+$";
        var result = await pool.query(
          "SELECT customer_po FROM orders WHERE customer_po ~ $1 ORDER BY LENGTH(customer_po) DESC, customer_po DESC LIMIT 1",
          [pattern]
        ).catch(function() { return { rows: [] }; });
        var nextNum = 1;
        if (result.rows.length) {
          var last = result.rows[0].customer_po || "";
          var num = parseInt(last.replace(poPrefix, "")) || 0;
          nextNum = num + 1;
        }
        return res.status(200).json({ success: true, nextPO: poPrefix + nextNum });
      }

      // ── Default: init data ──
      var customers = await pool.query(
        "SELECT DISTINCT company_code, company_name_cn, company_name_en FROM orders WHERE company_code IS NOT NULL AND company_code != '' GROUP BY company_code, company_name_cn, company_name_en ORDER BY company_name_en"
      ).catch(function() { return { rows: [] }; });

      var custTable = await pool.query(
        "SELECT id, company_code, name_cn, name_en, brands, country, country_en, currency, grade, payment_policy, payment_terms, destination_port, address, consignee, bl_type, trade_terms, our_shipping, addresses, raw FROM customers WHERE is_active != false AND (grade IS NOT NULL AND grade != '' OR brands IS NOT NULL AND brands != '{}' AND brands != '[]' AND brands::text != '') ORDER BY name_en"
      ).catch(function() { return { rows: [] }; });

      var customerMap = {};
      (custTable.rows || []).forEach(function(c) {
        var code = c.company_code || ("cust-" + c.id);
        if (!code) return;
        // Extract first address for defaults
        var addrs = [];
        try { addrs = typeof c.addresses === "string" ? JSON.parse(c.addresses) : (c.addresses || []); } catch(e) {}
        var firstAddr = addrs[0] || {};
        var brands = Array.isArray(c.brands) ? c.brands.join(", ") : (c.brands || "");

        customerMap[code] = {
          customerId: c.id,
          companyCode: code,
          companyNameCN: c.name_cn || "",
          companyNameEN: c.name_en || "",
          brands: brands,
          country: c.country || firstAddr.country || "",
          countryEN: c.country_en || "",
          currency: c.currency || "CNY",
          grade: c.grade || "",
          paymentPolicy: c.payment_policy || "",
          paymentTerms: c.payment_terms || [],
          destinationPort: c.destination_port || firstAddr.port || "",
          address: c.address || firstAddr.address || "",
          consignee: c.consignee || firstAddr.consignee || "",
          blType: c.bl_type || "",
          tradeTerms: c.trade_terms || "",
          ourShipping: c.our_shipping || "",
          addresses: addrs,
          raw: c.raw || {}
        };
      });
      // Supplement from orders table for any customers not in customers table
      (customers.rows || []).forEach(function(c) {
        if (c.company_code && !customerMap[c.company_code]) {
          customerMap[c.company_code] = {
            companyCode: c.company_code,
            companyNameCN: c.company_name_cn || "",
            companyNameEN: c.company_name_en || "",
          };
        }
      });

      var lastOrder = await pool.query(
        "SELECT order_no, contract_no FROM orders WHERE order_no IS NOT NULL ORDER BY created_at DESC LIMIT 1"
      ).catch(function() { return { rows: [] }; });

      // Load factory config from DB (falls back to empty if table not yet created)
      var factoriesResult = await pool.query(
        "SELECT name, name_short, po_prefix, ports FROM factories WHERE is_active = true ORDER BY name_short"
      ).catch(function() { return { rows: [] }; });

      return res.status(200).json({
        success: true,
        customers: Object.values(customerMap),
        factories: factoriesResult.rows,
        lastOrderNo: lastOrder.rows[0]?.order_no || null,
        lastContractNo: lastOrder.rows[0]?.contract_no || null,
        nextOrderNo: generateOrderNo(),
        nextContractNo: generateContractNo(),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DELETE: remove a single order ──
  if (req.method === "DELETE") {
    try {
      var orderNo = req.query.orderNo || (req.body || {}).orderNo;
      if (!orderNo) return res.status(400).json({ error: "orderNo required" });
      var del = await pool.query("DELETE FROM orders WHERE order_no = $1 RETURNING order_no", [orderNo]);
      if (!del.rows.length) return res.status(404).json({ error: "Order not found: " + orderNo });
      return res.status(200).json({ success: true, deleted: del.rows[0].order_no });
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
