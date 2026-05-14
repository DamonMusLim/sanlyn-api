// /api/db/order-create-v2.js — New order creation (SQL-first, full schema)
// POST: create order with customer + products selection
// GET: fetch form helpers (customers list, products list)
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

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
  if (!requireAuth(req, res)) return;

  // ── Access control ────────────────────────────────────────────────────────
  // Admin: unrestricted for all methods.
  // Customer (non-admin): POST allowed with server-side scope enforcement.
  //   - DELETE remains admin-only (destructive, no undo).
  //   - buyer_company_code must be within the caller's JWT companyCodes.
  //   - Scope empty → fail-closed (403). Client scope params are never trusted.
  var isAdmin = req.user && req.user.role === "admin";

  if (!isAdmin && req.method === "DELETE") {
    return res.status(403).json({
      error: "Admin only — order deletion is restricted.",
      code: "FORBIDDEN",
    });
  }

  // Compute caller scope for all non-admin users (used by GET scoping + POST validation).
  // FAIL-CLOSED: empty scope → reject (forces re-login with fresh JWT).
  var userCodes = null;
  if (!isAdmin) {
    var rawCodes = req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : []);
    userCodes = Array.isArray(rawCodes) && rawCodes.length ? rawCodes : null;
    if (!userCodes) {
      return res.status(403).json({
        error: "Account scope missing — please log out and log in again.",
        code: "SCOPE_MISSING",
      });
    }
  }

  var pool = getPool();

  // ── GET: return form data ──
  // ?action=customers → customer list
  // ?action=customer-products&companyCode=XXX → customer's recent order products
  // default → customers + next numbers
  if (req.method === "GET") {
    try {
      var action = req.query.action || "init";

      // ── Single customer info (returns sub_entities + base fields) ──
      if (action === "customer-info" && req.query.companyCode) {
        var ciCode = req.query.companyCode;
        if (!isAdmin && userCodes && !userCodes.includes(ciCode)) {
          return res.status(403).json({ error: "Out of scope" });
        }
        var ciRes = await pool.query(
          "SELECT company_code, name_cn, name_en, country, currency, grade, destination_port, consignee, sub_entities FROM customers WHERE company_code = $1 LIMIT 1",
          [ciCode]
        ).catch(function() { return { rows: [] }; });
        if (!ciRes.rows.length) {
          return res.status(404).json({ success: false, error: "Customer not found" });
        }
        var row = ciRes.rows[0];
        var subEntities = row.sub_entities || [];
        if (typeof subEntities === "string") { try { subEntities = JSON.parse(subEntities); } catch(_) { subEntities = []; } }
        if (!Array.isArray(subEntities)) subEntities = [];
        return res.status(200).json({
          success: true,
          data: {
            companyCode: row.company_code,
            companyNameCN: row.name_cn || "",
            companyNameEN: row.name_en || "",
            country: row.country || "",
            currency: row.currency || "",
            grade: row.grade || "",
            destinationPort: row.destination_port || "",
            consignee: row.consignee || "",
            subEntities: subEntities,
          }
        });
      }

      // ── Customer's history products (for association) ──
      if (action === "customer-products" && req.query.companyCode) {
        var code = req.query.companyCode;
        if (!isAdmin && userCodes && !userCodes.includes(code)) {
          return res.status(403).json({ error: "Out of scope — you cannot view this customer's order history." });
        }

        // Try company_products table first (authorized catalog with customer-specific pricing)
        var cpRows = [];
        try {
          var cpResult = await pool.query(
            `SELECT cp.id AS cp_id, cp.alias_sku, cp.price_cny, cp.price_usd, cp.moq, cp.lead_time_days, cp.notes AS cp_notes,
                    p.sku, p.name_cn, p.name_en, p.brand, p.size, p.unit, p.cbm, p.gross_weight, p.net_weight,
                    p.inner_qty, p.inner_unit, p.hs_code
             FROM company_products cp
             JOIN customers cust ON cust.id = cp.company_id
             JOIN products p ON p.id = cp.product_id
             WHERE cust.company_code = $1 AND cp.active = true
             ORDER BY p.name_en`,
            [code]
          );
          cpRows = cpResult.rows || [];
        } catch(cpErr) {
          // table may not exist or product_id FK issue — fall through to order history
        }

        if (cpRows.length > 0) {
          var cpProducts = cpRows.map(function(r) {
            return {
              name: r.name_en || r.name_cn || "",
              code: r.alias_sku || r.sku || "",
              brand: r.brand || "",
              size: r.size || "",
              unit: r.unit || "CTN",
              unitPrice: parseFloat(r.price_usd) || 0,
              price_usd: parseFloat(r.price_usd) || 0,
              price_cny: parseFloat(r.price_cny) || 0,
              cbm: parseFloat(r.cbm) || 0,
              grossWeight: parseFloat(r.gross_weight) || 0,
              netWeight: parseFloat(r.net_weight) || 0,
              innerQty: r.inner_qty || 0,
              innerUnit: r.inner_unit || "PCS",
              hsCode: r.hs_code || "",
              moq: r.moq || 0,
              leadTimeDays: r.lead_time_days || 0,
              notes: r.cp_notes || "",
              isAuthorized: true,
            };
          });
          return res.status(200).json({
            success: true,
            products: cpProducts,
            orderCount: 0,
            defaults: {},
            source: "company_products",
            authorizedCount: cpProducts.length,
          });
        }

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
                innerQty: p.innerQty || p.bagsPerBox || 0,
                innerUnit: p.innerUnit || "PCS",
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

      // ── Factories authorized for a specific buyer ──
      if (action === "factory-by-buyer" && req.query.buyerCode) {
        var buyerCode = req.query.buyerCode;
        var subEntityCode = (req.query.subEntityCode || "").trim();   // optional — when set, use sub-entity's signed factories

        // PKG-006 AUTHZ-GUARD: non-admin callers may only query factories for their own buyerCode.
        // Prevents enumerating other companies' factory relationships by probing arbitrary buyerCodes.
        if (!isAdmin) {
          var callerBuyerNorm = (userCodes || []).map(function(c){ return (c||"").toUpperCase(); });
          if (!callerBuyerNorm.includes((buyerCode||"").toUpperCase())) {
            return res.status(403).json({
              error: "Forbidden — buyerCode is outside your account scope.",
              code: "FACTORY_BY_BUYER_SCOPE_ERROR",
            });
          }
        }

        var buyerRes = await pool.query(
          "SELECT id, sub_entities FROM customers WHERE company_code = $1 LIMIT 1",
          [buyerCode]
        ).catch(function() { return { rows: [] }; });

        // Validate subEntityCode belongs to this buyer (defense against spoofing)
        if (subEntityCode && buyerRes.rows.length) {
          var subs = buyerRes.rows[0].sub_entities || [];
          if (typeof subs === "string") { try { subs = JSON.parse(subs); } catch(_) { subs = []; } }
          var validCodes = subs.map(function(s){ return s.code; });
          if (validCodes.indexOf(subEntityCode) === -1) {
            return res.status(400).json({ error: "subEntityCode not found under buyerCode" });
          }
        }

        var factories = [];
        var fromRelationships = false;

        // ── Layer 1: partner_relationships (new) — customer_factory edges ─────
        // Resolves company_code_b to factories OR seller_profiles (so 巴匕/洋宝宝-style entries also surface).
        // If subEntityCode given, query sub-entity's relations; otherwise parent buyer.
        var lookupCode = subEntityCode || buyerCode;
        var partnerRes = await pool.query(
          `SELECT pr.company_code_b AS code
             FROM partner_relationships pr
            WHERE pr.company_code_a = $1
              AND pr.relationship_type = 'customer_factory'
              AND pr.status = 'active'`,
          [lookupCode]
        ).catch(function() { return { rows: [] }; });

        if (partnerRes.rows.length) {
          var codes = partnerRes.rows.map(function(r){ return r.code; });
          // Hydrate from factories table + customers (for name_en)
          var factHydrate = await pool.query(
            `SELECT f.company_code, f.name AS name_cn, f.name_short, f.po_prefix, f.ports, f.address,
                    c.name_en, c.address_cn, c.address_en, c.currency, c.addresses
               FROM factories f
               LEFT JOIN customers c ON (c.company_code = f.company_code OR c.name_cn = f.name)
              WHERE f.company_code = ANY($1::text[])`,
            [codes]
          ).catch(function() { return { rows: [] }; });
          var seenCodes = new Set();
          factHydrate.rows.forEach(function(row) {
            seenCodes.add(row.company_code);
            factories.push({
              company_code: row.company_code,
              name_cn:      row.name_cn || "",
              name_en:      row.name_en || "",
              name_short:   row.name_short || "",
              po_prefix:    row.po_prefix || "",
              port_default: Array.isArray(row.ports) && row.ports.length ? row.ports[0] : "",
              export_mode:  null,
              address:      row.address_en || row.address_cn || row.address || "",
              addresses:    row.addresses || null,
              currency:     row.currency || "CNY",
            });
          });
          // Hydrate any remaining codes from seller_profiles (e.g. petbaby)
          var missing = codes.filter(function(c){ return !seenCodes.has(c); });
          if (missing.length) {
            var spHydrate = await pool.query(
              `SELECT code, name_cn, name_en
                 FROM seller_profiles
                WHERE code = ANY($1::text[])`,
              [missing]
            ).catch(function() { return { rows: [] }; });
            spHydrate.rows.forEach(function(row) {
              seenCodes.add(row.code);
              factories.push({
                company_code: row.code,
                name_cn:      row.name_cn || "",
                name_en:      row.name_en || "",
                name_short:   row.name_cn || row.code,
                port_default: "",
                export_mode:  "proxy",  // seller_profile entries default to proxy export
                address:      "",
              });
            });
            // Codes not resolved anywhere — still surface them as raw entries so UI can show them
            missing.filter(function(c){ return !seenCodes.has(c); }).forEach(function(c) {
              factories.push({
                company_code: c, name_cn: c, name_en: "", name_short: c,
                port_default: "", export_mode: null, address: "",
              });
            });
          }
          fromRelationships = true;
        }

        // ── Layer 2: legacy relationships table fallback ───────────────────────
        if (!factories.length && buyerRes.rows.length) {
          var buyerId = buyerRes.rows[0].id;
          var relRes = await pool.query(
            `SELECT DISTINCT c.id, c.company_code, c.name_cn, c.name_en, c.name_short,
                    c.port_default, c.export_mode, c.address, c.address_cn, c.address_en,
                    c.currency, c.addresses
             FROM relationships r
             JOIN customers c ON (
               (r.type = 'buys_from' AND r.from_company_id = $1 AND c.id = r.to_company_id)
               OR (r.type = 'sells_to' AND r.to_company_id = $1 AND c.id = r.from_company_id)
             )
             WHERE c.role_type = 'factory' AND r.status = 'active'`,
            [buyerId]
          ).catch(function() { return { rows: [] }; });

          if (relRes.rows.length) {
            factories = relRes.rows;
            fromRelationships = true;
          }
        }

        // Fallback: all factories from customers table
        // AUTHZ-GUARD-001: external callers (non-admin) are FAIL-CLOSED —
        // they must have an explicit buyer↔factory relationship in the relationships table.
        // Only admin/internal callers may see the full factory list when no relationship is set.
        if (!factories.length) {
          if (!isAdmin) {
            // External customer / agent: no authorized factories → return empty, do NOT leak full list
            return res.status(200).json({
              success: true,
              factories: [],
              authorizedCount: 0,
              fromRelationships: false,
              fallbackBlocked: true,
              message: "No authorized factories configured for this buyer. Contact Sanlyn to set up factory authorization.",
            });
          }
          // Admin / internal only: fallback to full factory list for internal order creation
          var allFactRes = await pool.query(
            "SELECT id, company_code, name_cn, name_en, name_short, port_default, export_mode, address, address_cn, address_en, currency, addresses FROM customers WHERE portal_role = 'factory' ORDER BY name_en"
          ).catch(function() { return { rows: [] }; });
          factories = allFactRes.rows;
        }

        var factoryList = factories.map(function(row) {
          var displayName = row.name_en || row.name_cn || row.name_short || row.company_code || "";
          return {
            name: displayName,                            // OrderCreateV4 reads this as the display label
            companyCode: row.company_code || "",
            nameEN: row.name_en || "",
            nameCN: row.name_cn || "",
            nameShort: row.name_short || "",
            poPrefix: row.po_prefix || row.name_short || row.company_code || "",
            portDefault: row.port_default || "",
            ports: row.port_default ? [row.port_default] : [],
            exportMode: row.export_mode || null,
            isProxy: row.export_mode === "proxy",
            address: row.address_cn || row.address_en || row.address || "",
            addresses: row.addresses || null,
            defaultCurrency: row.currency || "CNY",
          };
        });

        return res.status(200).json({
          success: true,
          factories: factoryList,
          authorizedCount: factoryList.length,
          fromRelationships: fromRelationships,
        });
      }

      // ── Next PO number: {factoryPrefix}-{seq} e.g. ZC-3 ──
      if (action === "next-po" && req.query.factoryPrefix) {
        var fp = req.query.factoryPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "");
        var pattern = "^" + fp + "-[0-9]+$";
        var result = await pool.query(
          "SELECT customer_po FROM orders WHERE customer_po ~ $1 ORDER BY LENGTH(customer_po) DESC, customer_po DESC LIMIT 1",
          [pattern]
        ).catch(function() { return { rows: [] }; });
        var nextNum = 1;
        if (result.rows.length) {
          var last = result.rows[0].customer_po || "";
          var num = parseInt(last.replace(fp + "-", "")) || 0;
          nextNum = num + 1;
        }
        return res.status(200).json({ success: true, nextPO: fp + "-" + nextNum });
      }

      // ── Default: init data ──
      // Scope customer list by user's companyCodes for non-admin callers.
      var scopeClauseOrders = "";
      var scopeClauseCust   = "";
      var scopeParams       = [];
      if (!isAdmin && userCodes && userCodes.length) {
        var ph = userCodes.map(function (c, i) { scopeParams.push(c); return "$" + scopeParams.length; }).join(",");
        scopeClauseOrders = " AND company_code IN (" + ph + ")";
        scopeClauseCust   = " AND company_code IN (" + ph + ")";
      }

      var customers = await pool.query(
        "SELECT DISTINCT company_code, company_name_cn, company_name_en FROM orders WHERE company_code IS NOT NULL AND company_code != ''" + scopeClauseOrders + " GROUP BY company_code, company_name_cn, company_name_en ORDER BY company_name_en",
        scopeParams
      ).catch(function() { return { rows: [] }; });

      var custTable = await pool.query(
        "SELECT id, company_code, name_cn, name_en, brands, country, country_en, currency, grade, payment_policy, payment_terms, destination_port, address, consignee, bl_type, trade_terms, our_shipping, addresses, sub_entities, raw FROM customers WHERE is_active != false" + scopeClauseCust + " AND (grade IS NOT NULL AND grade != '' OR brands IS NOT NULL AND brands != '{}' AND brands != '[]' AND brands::text != '') ORDER BY name_en",
        scopeParams
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

        // Normalize sub_entities (may come as JSON string or array)
        var subEntities = c.sub_entities || [];
        if (typeof subEntities === "string") { try { subEntities = JSON.parse(subEntities); } catch(_) { subEntities = []; } }
        if (!Array.isArray(subEntities)) subEntities = [];

        if (isAdmin) {
          // Admin: full customer record for internal order creation
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
            subEntities: subEntities,
            raw: c.raw || {}
          };
        } else {
          // DEC-03: external callers receive whitelist-only fields — no raw/payment/internal data
          customerMap[code] = {
            companyCode: code,
            companyNameCN: c.name_cn || "",
            companyNameEN: c.name_en || "",
            country: c.country || firstAddr.country || "",
            currency: c.currency || "USD",
            destinationPort: c.destination_port || firstAddr.port || "",
            consignee: c.consignee || firstAddr.consignee || "",
            subEntities: subEntities,
          };
        }
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

      // Load factories from customers table (role_type='factory') as enrichment
      var customersFactories = await pool.query(
        "SELECT company_code, name_cn, name_en, name_short, port_default, export_mode FROM customers WHERE role_type = 'factory' AND is_active != false ORDER BY name_en"
      ).catch(function() { return { rows: [] }; });

      // Build enrichment map: company_code/name_short → row
      var custFactMap = {};
      (customersFactories.rows || []).forEach(function(cf) {
        if (cf.company_code) custFactMap[cf.company_code] = cf;
        if (cf.name_short) custFactMap[cf.name_short] = custFactMap[cf.name_short] || cf;
      });

      // Merge: factories table rows enriched with customers export_mode/companyCode
      var mergedFactories = (factoriesResult.rows || []).map(function(f) {
        var enrich = custFactMap[f.po_prefix] || custFactMap[f.name_short] || {};
        return {
          name: f.name,
          nameShort: f.name_short || enrich.name_short || "",
          poPrefix: f.po_prefix || "",
          ports: f.ports || [],
          exportMode: enrich.export_mode || null,
          companyCode: enrich.company_code || null,
        };
      });

      // Also add any customers-table factories NOT already in factories table
      (customersFactories.rows || []).forEach(function(cf) {
        var alreadyPresent = mergedFactories.some(function(f) {
          return f.companyCode === cf.company_code || f.nameShort === cf.name_short;
        });
        if (!alreadyPresent && (cf.name_en || cf.name_cn)) {
          mergedFactories.push({
            name: cf.name_en || cf.name_cn || cf.company_code,
            nameShort: cf.name_short || "",
            poPrefix: "",
            ports: cf.port_default ? [cf.port_default] : [],
            exportMode: cf.export_mode || null,
            companyCode: cf.company_code,
          });
        }
      });

      return res.status(200).json({
        success: true,
        customers: Object.values(customerMap),
        factories: mergedFactories,
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

  // ── POST: create order or action-specific tasks ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── POST ?action=sample-request ──
  if (req.query.action === "sample-request") {
    try {
      var srBody = req.body || {};

      // AUTHZ-GUARD-001: scope-gate companyCode for non-admin callers
      // External callers cannot create sourcing tasks on behalf of other buyers.
      if (!isAdmin) {
        var srCode = (srBody.companyCode || "").toUpperCase();
        var srCallerNorm = (userCodes || []).map(function(c){ return (c||"").toUpperCase(); });
        if (!srCode || !srCallerNorm.includes(srCode)) {
          return res.status(403).json({
            error: "Forbidden — companyCode is outside your account scope.",
            code: "SAMPLE_REQUEST_SCOPE_ERROR",
          });
        }
      }

      var taskId = "t-sr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      await pool.query(`
        INSERT INTO tasks (
          id, title, task_type, level, status, risk_level,
          owner_object_type, owner_object_id, owner_object_label,
          company_code, mode, due_at, reason, raw
        ) VALUES (
          $1, $2, 'SAMPLE_REQUEST', 'sourcing', 'open', 'low',
          'sourcing', $3, $4,
          $5, 'owned', NOW() + INTERVAL '7 days',
          'New sample / sourcing request submitted via Order Create.',
          $6::jsonb
        )
      `, [
        taskId,
        "Sample Request: " + (srBody.productName || "Unknown"),
        taskId,
        "Sample: " + (srBody.productName || "Unknown"),
        srBody.companyCode || "",
        JSON.stringify({
          productName: srBody.productName || "",
          spec: srBody.spec || "",
          qty: srBody.qty || "",
          budget: srBody.budget || "",
          notes: srBody.notes || "",
          requestedBy: srBody.requestedBy || "admin",
          submittedAt: new Date().toISOString(),
        }),
      ]);
      return res.status(200).json({ success: true, taskId: taskId });
    } catch (srErr) {
      console.error("[order-create-v2] sample-request failed:", srErr);
      return res.status(500).json({ success: false, error: srErr.message });
    }
  }

  try {
    var body = req.body || {};

    // ── Forbidden field scrub ─────────────────────────────────────────────────
    // Strip internal cost/settlement fields before any processing or DB storage.
    // Defense-in-depth: these must never enter orders.raw via customer portal.
    var FORBIDDEN_PAYLOAD_KEYS = [
      "margin", "trader_margin", "platform_fee", "settlement_edge",
      "paid", "settled", "factory_exw_price", "other_broker_commission",
      "bank_account", "driver_phone",
    ];
    FORBIDDEN_PAYLOAD_KEYS.forEach(function(k) { delete body[k]; });

    // ── V3 payload detection and adaptation ──────────────────────────────────
    // OrderCreateV3 sends V3 format: { buyer_company_code, containers, shipment, factory_code, ref }
    // Legacy admin tool sends:        { companyCode, products, consignee, ... }
    // Detect by presence of buyer_company_code and adapt to legacy format for INSERT.
    if (body.buyer_company_code) {
      // Look up buyer details from customers table (never trust frontend name strings)
      var buyerRow = {};
      try {
        var bRes = await pool.query(
          "SELECT name_cn, name_en, country, destination_port, consignee, currency FROM customers WHERE company_code = $1 LIMIT 1",
          [body.buyer_company_code]
        );
        buyerRow = bRes.rows[0] || {};
      } catch (lookupErr) {
        console.warn("[order-create-v2] buyer lookup failed (non-fatal):", lookupErr.message);
      }

      // Flatten containers → products array
      var v3Products = [];
      (body.containers || []).forEach(function(c) {
        (c.slots || []).forEach(function(s) {
          (s.products || []).forEach(function(p) {
            v3Products.push(Object.assign({}, p, {
              containerType: c.containerType || "",
              _slotFactoryKey: s.factoryKey || c.factoryKey || body.factory_code || "",
              _slotPO: s.po || c.po || "",
            }));
          });
        });
      });

      var ship = body.shipment || {};
      var primaryContainerType = (body.containers && body.containers[0] && body.containers[0].containerType) || "40HQ";
      var containerQtyV3 = (body.containers || []).length || 1;

      // Remap to legacy body format (reuse existing validation + INSERT path)
      body = {
        companyCode:      body.buyer_company_code,
        companyNameCN:    buyerRow.name_cn || "",
        companyNameEN:    buyerRow.name_en || "",
        consignee:        ship.consignee   || buyerRow.consignee || "",
        customerAddress:  ship.deliveryAddr || "",
        country:          ship.country     || buyerRow.country   || "",
        // P1-BUG-2 fix: destination_port = port code; destination = human-readable country/city text
        destinationPort:  buyerRow.destination_port || "",
        destination:      ship.country || buyerRow.country || "",
        pol:              ship.loadPort    || "",
        deliveryDate:     ship.deliveryDate || null,
        requiredArrival:  ship.reqArrival  || null,
        remarks:          ship.remarks     || "",
        factory:          body.factory_code || "",
        currency:         buyerRow.currency || "USD",
        containerType:    primaryContainerType,
        containerQty:     containerQtyV3,
        products:         v3Products,
        contractNo:       body.ref || null,  // V3 ref (SC-YYYYMMDD-NNN) as contract ref
        // P1-BUG-3 fix: source = "customer-portal" for customer self-service orders
        createdBy:        "customer-portal",
        source:           "customer-portal",
        // Preserve V3 metadata in raw (visible to admin, never returned to customers)
        _source:          "OrderCreateV3",
        _v3_proxy_export: body.proxy_export   || false,
        _v3_sanlyn_commission: body.sanlyn_commission || null,
        _v3_containers:   body.containers     || [],
      };
    }

    // ── Server-side buyer scope validation (non-admin) ────────────────────────
    // CRITICAL: Must run AFTER V3 adaptation so body.companyCode is normalised.
    // Verifies caller JWT scope includes the requested buyer. Never trust any
    // client-supplied company_codes, query params, or stagingProfile values.
    if (!isAdmin) {
      var requestedBuyer = (body.companyCode || "").toUpperCase();
      if (!requestedBuyer) {
        return res.status(400).json({
          error: "buyer_company_code (companyCode) is required.",
          code: "BUYER_REQUIRED",
        });
      }
      var callerNorm = userCodes.map(function(c) { return (c || "").toUpperCase(); });
      if (!callerNorm.includes(requestedBuyer)) {
        return res.status(403).json({
          error: "Forbidden — buyer_company_code is outside your account scope.",
          code: "BUYER_OUT_OF_SCOPE",
          requestedBuyer: requestedBuyer,
          // Do NOT echo callerNorm — avoid leaking caller scope to error response
        });
      }
    }

    var exportController = body.exportController || (body.proxyExport ? "SANLYN" : "SELF");
    var factoryCompanyCode = body.factoryCompanyCode || body.selectedFactoryCode || null;

    var {
      companyCode, companyNameCN, companyNameEN, groupCode, brand, category,
      consignee, customerAddress, phone, email,
      country, destinationPort, destination, pol,
      deliveryDate, confirmedDelivery, requiredArrival,
      currency, exchangeRate,
      factory, issuingCompany, issuingCompanyEN,
      // P1-BUG-3 fix: source is set explicitly by V3 adapter or legacy caller
      remarks, products, createdBy, source
    } = body;

    // Merge exportController + factoryCompanyCode into body so they land in orders.raw
    body = Object.assign({}, body, { exportController: exportController, factoryCompanyCode: factoryCompanyCode });

    if (!companyNameCN && !companyNameEN) return res.status(400).json({ error: "客户名称必填" });
    if (!products || !products.length) return res.status(400).json({ error: "请添加产品" });

    var orderNo = body.orderNo || generateOrderNo();
    // DEC-02: backend FS-prefix is canonical contract_no.
    // Non-admin callers may supply a client-side SC-prefix ref (draft display ref) but it is
    // stored as raw._clientRef only. The official contract_no always comes from server generateContractNo().
    // Admin callers may explicitly supply contractNo (for re-submission / import scenarios).
    var contractNo = isAdmin
      ? (body.contractNo || generateContractNo())
      : generateContractNo();
    // Preserve client SC-prefix ref in raw for display continuity (OrderCreateV4 shows SC-... in header)
    if (!isAdmin && body.contractNo) {
      body = Object.assign({}, body, { _clientRef: body.contractNo });
    }

    // ── Product Master JOIN ─────────────────────────────────────────────────────
    // Batch-fetch product master data for all SKUs in this order.
    // FAIL-OPEN: if sku not in products table, row is kept as-is (no error).
    // Only active products are used (active = true filter).
    //
    // Columns fetched (verified against products schema 2026-05-07):
    //   id, updated_at — used for deterministic duplicate resolution
    //   net_weight, gross_weight, cbm, hs_code, declaration_name,
    //   bl_description, barcode
    //
    // Duplicate SKU policy (products table has no sku UNIQUE constraint):
    //   If multiple active rows share the same sku, pick the one with:
    //     1. latest updated_at (most recently maintained record)
    //     2. largest id as tie-breaker (inserted later, more likely canonical)
    //   Resolution is done in JS (not relying on SQL ORDER BY for forEach stability).
    //   A console.warn is emitted for every duplicate found (for observability).
    //
    // NOTE: inner_qty / inner_unit do NOT exist in products table (2026-05-07 audit).
    //   These remain in the allowed-fill intent but cannot be populated until the column
    //   is added. Tracked as P2 schema addition.
    //
    // NEVER fetched from master (forbidden — financial / settlement fields):
    //   factory_price, price_usd, profit, declaration_amount, vat_rate, rebate_rate
    var skuMasterMap = {};
    var incomingSkus = (products || []).map(function(p) { return (p.sku || p.code || "").trim(); }).filter(Boolean);
    if (incomingSkus.length) {
      try {
        var masterRes = await pool.query(
          "SELECT id, sku, product_name, net_weight, gross_weight, cbm, hs_code, declaration_name, bl_description, barcode, updated_at FROM products WHERE sku = ANY($1) AND active = true",
          [incomingSkus]
        );

        // Group rows by sku, then pick the best row deterministically.
        // This is robust regardless of SQL result-set order.
        var skuGroups = {};
        (masterRes.rows || []).forEach(function(row) {
          var key = row.sku ? row.sku.trim() : "";
          if (!key) return;
          if (!skuGroups[key]) skuGroups[key] = [];
          skuGroups[key].push(row);
        });

        Object.keys(skuGroups).forEach(function(sku) {
          var group = skuGroups[sku];
          var selected;
          if (group.length === 1) {
            selected = group[0];
          } else {
            // Deterministic selection: updated_at DESC, then id DESC as tie-breaker.
            group.sort(function(a, b) {
              var tA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
              var tB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
              if (tB !== tA) return tB - tA;           // latest updated_at first
              return (Number(b.id) || 0) - (Number(a.id) || 0);  // largest id first
            });
            selected = group[0];
            // Warn on every duplicate so it is visible in production logs
            console.warn(
              "[order-create-v2] duplicate_sku_master_found sku=" + sku +
              " count=" + group.length +
              " selected_id=" + selected.id +
              " selected_updated_at=" + (selected.updated_at || "null")
            );
          }
          skuMasterMap[sku] = selected;
        });

        if (Object.keys(skuMasterMap).length) {
          console.log("[order-create-v2] product master JOIN: " + Object.keys(skuMasterMap).length + "/" + incomingSkus.length + " SKUs resolved");
        }
      } catch (masterErr) {
        // Fail-open: master lookup failure must never block order creation
        console.warn("[order-create-v2] product master JOIN failed (non-fatal):", masterErr.message);
      }
    }

    // Fill only missing/falsy fields from master row. Never overwrites client-supplied values.
    // p is treated as immutable — returns a new object.
    function fillFromMaster(p, master) {
      if (!master) return p;
      var filled = [];
      var result = Object.assign({}, p);

      // Each entry: [products_col, p_camelKey, p_snakeKey (optional alias)]
      // Only columns verified to exist in products table are listed here.
      var MASTER_FILL = [
        ["net_weight",       "netWeight",       "net_weight"],
        ["gross_weight",     "grossWeight",      "gross_weight"],
        ["cbm",              "cbm",              null],
        ["hs_code",          "hsCode",           "hs_code"],
        ["declaration_name", "declarationName",  "declaration_name"],
        ["barcode",          "barcode",          null],
        // bl_description: direct column in products (not derived from declaration_name)
        ["bl_description",   "blDescription",    "bl_description"],
      ];

      MASTER_FILL.forEach(function(entry) {
        var col = entry[0], camel = entry[1], snake = entry[2];
        var masterVal = master[col];
        if (masterVal === null || masterVal === undefined || masterVal === "") return;
        // Check all aliases for an existing client value
        var clientHasValue = (
          (p[camel]  !== null && p[camel]  !== undefined && p[camel]  !== "" && p[camel]  !== 0) ||
          (snake && p[snake] !== null && p[snake] !== undefined && p[snake] !== "" && p[snake] !== 0)
        );
        if (!clientHasValue) {
          result[camel] = masterVal;
          if (snake) result[snake] = masterVal;
          filled.push(col);
        }
      });

      if (filled.length) result._masterFilled = filled;
      return result;
    }

    // Calculate totals from products
    var totalQty = 0, totalAmount = 0, totalAmountFactory = 0;
    var totalCBM = 0, grossWeight = 0, netWeight = 0;
    var declareAmount = 0;

    var cleanProducts = products.map(function(p) {
      // Enrich p with product master data before extracting fields (fail-open)
      var skuKey = (p.sku || p.code || "").trim();
      if (skuKey && skuMasterMap[skuKey]) {
        p = fillFromMaster(p, skuMasterMap[skuKey]);
      }
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
        declarationName: p.declarationName || p.declaration_name || p.category || p.cat1 || "",
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
        innerQty: parseInt(p.innerQty) || parseInt(p.bagsPerBox) || parseInt(p.bags_per_box) || 0,
        innerUnit: p.innerUnit || "PCS",
        // bl_description: from client, or filled from master bl_description column (never overrides client)
        blDescription: p.blDescription || p.bl_description || p.declarationName || p.declaration_name || "",
        // barcode: from client, or filled from master (never overrides client)
        barcode: p.barcode || p.code || "",
        sku: p.sku || "",
        // Track which fields were auto-filled from product master (for audit in raw)
        _masterFilled: p._masterFilled || undefined,
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

    // ─────────────────────────────────────────────────────────────
    // S89: Credit exposure check (proxy-purchase model)
    // Flags over-limit orders so admin can approve/reject before production.
    // Non-blocking: the order is still created, just tagged.
    // ─────────────────────────────────────────────────────────────
    var creditInfo = null;
    try {
      if (companyCode) {
        var acctQ = await pool.query(
          "SELECT username, raw FROM accounts WHERE role = 'customer' AND (raw->>'companyCode' = $1 OR company_code = $1) LIMIT 1",
          [companyCode]
        );
        if (acctQ.rows.length) {
          var acctRaw = acctQ.rows[0].raw || {};
          var paymentTerms   = acctRaw.paymentTerms   || "prepay_100";
          var creditLimit    = Number(acctRaw.creditLimit)   || 0;
          var creditUsed     = Number(acctRaw.creditUsed)    || 0;
          var creditCurrency = acctRaw.creditCurrency || "USD";
          var requireApprv   = acctRaw.requireApproval !== false;
          var orderCurrency  = (currency || "CNY").toUpperCase();
          var orderAmt       = Number(totalAmount) || 0;
          var currencyMatch  = orderCurrency === creditCurrency;
          // MVP: only enforce when currencies match; otherwise flag as advisory
          var newExposure    = creditUsed + (currencyMatch ? orderAmt : 0);
          var overLimit      = creditLimit > 0 && newExposure > creditLimit;
          var isCredit       = (paymentTerms === "cod_on_arrival" || paymentTerms === "net_30" || paymentTerms === "prepay_30_balance_bl");

          creditInfo = {
            paymentTerms:     paymentTerms,
            creditLimit:      creditLimit,
            creditCurrency:   creditCurrency,
            creditUsedBefore: creditUsed,
            orderAmount:      orderAmt,
            orderCurrency:    orderCurrency,
            currencyMatch:    currencyMatch,
            newExposure:      newExposure,
            overLimit:        overLimit,
            isCreditOrder:    isCredit,
            requireApproval:  requireApprv,
            checkedAt:        new Date().toISOString(),
            acctUsername:     acctQ.rows[0].username,
          };
          if (overLimit && isCredit) {
            creditInfo.creditApprovalStatus = requireApprv ? "pending" : "acknowledged";
          } else if (isCredit) {
            creditInfo.creditApprovalStatus = "within_limit";
          } else {
            creditInfo.creditApprovalStatus = "not_applicable";  // prepay_100
          }
        } else {
          creditInfo = { checkedAt: new Date().toISOString(), note: "no_matching_customer_account" };
        }
      }
    } catch (ce) {
      console.error("[order-create-v2] credit check failed:", ce);
      creditInfo = { checkedAt: new Date().toISOString(), error: ce.message };
    }

    // Merge credit info into body.raw so it persists to orders.raw
    if (creditInfo) {
      body = Object.assign({}, body, { credit: creditInfo });
    }

    // orders.id has no serial default — must supply next integer manually.
    // Use MAX(id)+1 with a fallback to 1 (low-concurrency acceptable for order creation).
    var nextIdRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS nid FROM orders");
    var nextId = nextIdRes.rows[0].nid;

    // P1-BUG-3 fix: source reflects actual order origin, not hardcoded "admin"
    // V3 adapter sets body.source = "customer-portal"; legacy admin path has no source → "admin_panel"
    var orderSource = source || (createdBy === "customer-portal" ? "customer-portal" : "admin_panel");

    var sql = `INSERT INTO orders (
      id, _id, order_no, contract_no, customer_po,
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
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
      $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
      $38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48
    ) RETURNING id, _id, order_no, contract_no, total_amount, total_amount_factory, profit, status`;

    // $1–$16:  id … country
    // $17:     destination_port  (P1-BUG-2 fix: was $17 twice)
    // $18:     destination       (P1-BUG-2 fix: new distinct param)
    // $19:     pol               (shifted from $18)
    // $20–$22: delivery_date, confirmed_delivery, required_arrival
    // $23–$26: total_qty, total_cbm, gross_weight, net_weight
    // $27–$28: container_type, container_qty
    // $29–$32: total_amount, total_amount_factory, currency, exchange_rate
    // $33–$37: profit, declare_amount, vat_rate, tax_rebate_rate, tax_rebate_amount
    // $38–$39: status, production_status
    // $40–$44: products, factory, issuing_company, issuing_company_en, remarks
    // $45:     source  (P1-BUG-3 fix: was hardcoded "admin")
    // $46–$48: created_by, customer, raw
    var vals = [
      /*$1*/  nextId,
      /*$2*/  portalId,
      /*$3*/  orderNo,
      /*$4*/  contractNo,
      /*$5*/  body.customerPO || null,
      /*$6*/  companyCode || "",
      /*$7*/  companyNameCN || "",
      /*$8*/  companyNameEN || "",
      /*$9*/  groupCode || "",
      /*$10*/ brand || "",
      /*$11*/ category || "",
      /*$12*/ consignee || "",
      /*$13*/ customerAddress || "",
      /*$14*/ phone || "",
      /*$15*/ email || "",
      /*$16*/ country || "",
      /*$17*/ destinationPort || "",
      /*$18*/ destination || "",
      /*$19*/ pol || "",
      /*$20*/ deliveryDate || null,
      /*$21*/ confirmedDelivery || null,
      /*$22*/ requiredArrival || null,
      /*$23*/ totalQty,
      /*$24*/ parseFloat(totalCBM.toFixed(3)),
      /*$25*/ parseFloat(grossWeight.toFixed(2)),
      /*$26*/ parseFloat(netWeight.toFixed(2)),
      /*$27*/ containerType,
      /*$28*/ containerQty,
      /*$29*/ parseFloat(totalAmount.toFixed(2)),
      /*$30*/ parseFloat(totalAmountFactory.toFixed(2)),
      /*$31*/ currency || "CNY",
      /*$32*/ parseFloat(exchangeRate) || null,
      /*$33*/ parseFloat(profit.toFixed(2)),
      /*$34*/ parseFloat(declareAmount.toFixed(2)),
      /*$35*/ vatRate || null,
      /*$36*/ taxRebateRate || null,
      /*$37*/ parseFloat(taxRebateAmount.toFixed(2)),
      /*$38*/ "pending",
      /*$39*/ null,
      /*$40*/ JSON.stringify(cleanProducts),
      /*$41*/ factory || "",
      /*$42*/ issuingCompany || "",
      /*$43*/ issuingCompanyEN || "",
      /*$44*/ remarks || "",
      /*$45*/ orderSource,
      /*$46*/ createdBy || "admin_panel",
      /*$47*/ companyNameEN || companyNameCN || "",
      /*$48*/ JSON.stringify(body),
    ];

    var result = await pool.query(sql, vals);
    var order = result.rows[0];

    // Save trade_terms to order row + update customer's last-used value (non-fatal)
    if (body.trade_terms) {
      try {
        var tt = String(body.trade_terms).toUpperCase().trim();
        await pool.query("UPDATE orders SET trade_terms = $1 WHERE id = $2", [tt, order.id]);
        await pool.query("UPDATE customers SET trade_terms = $1, updated_at = NOW() WHERE company_code = $2", [tt, companyCode]);
      } catch (_) {}
    }

    // Auto-create payment_term task (non-fatal — never blocks order creation)
    try {
      const taskId = "t-pt-" + Math.random().toString(36).slice(2, 10);
      const orderLabel = order.contract_no || order.order_no || `Order #${order.id}`;
      await pool.query(`
        INSERT INTO tasks (
          id, title, task_type, level, status, risk_level,
          owner_object_type, owner_object_id, owner_object_label,
          related_order_no, related_po_no, company_code,
          mode, due_at, reason, raw
        ) VALUES (
          $1, $2, 'payment_term_confirm', 'order', 'open', 'mid',
          'order', $3, $4,
          $5, $6, $7,
          'owned', NOW() + INTERVAL '3 days',
          'Order created without an agreed payment term. Factory or trader needs to propose one.',
          $8::jsonb
        )
      `, [
        taskId,
        `Confirm payment term · ${orderLabel}`,
        String(order.id),
        orderLabel,
        order.order_no || '', body.customerPO || '', companyCode || '',
        JSON.stringify({
          order_id: order.id,
          workflow: 'payment_term',
          cta: { label: 'Propose payment term', open_payment_term_modal: true },
        }),
      ]);
    } catch (taskErr) {
      console.warn("[order-create-v2] payment_term task creation failed (non-fatal):", taskErr.message);
    }

    // PKG-002: strip internal cost fields from customer-facing response.
    // profit / totalAmountFactory reveal Sanlyn's margin and MUST NOT reach external callers.
    // Admin callers receive the full summary for cost tracking.
    var summaryPublic = {
      orderNo: order.order_no,
      contractNo: order.contract_no,
      customer: companyNameEN || companyNameCN,
      totalAmount: totalAmount,
      totalQty: totalQty,
      totalCBM: totalCBM,
      containerType: containerType,
      productCount: cleanProducts.length,
    };
    var summaryFull = Object.assign({}, summaryPublic, {
      totalAmountFactory: totalAmountFactory,
      profit: profit,
    });

    // Also strip cost fields from the order row returned to non-admin callers
    var orderPublic = Object.assign({}, order);
    if (!isAdmin) {
      delete orderPublic.profit;
      delete orderPublic.total_amount_factory;
    }

    return res.status(200).json({
      success: true,
      // Top-level order_no for easy client parsing (OrderCreateV3 reads d.order_no)
      order_no: order.order_no,
      order: isAdmin ? order : orderPublic,
      summary: isAdmin ? summaryFull : summaryPublic,
      credit: creditInfo,   // S89: client may show "pending approval" banner
    });
  } catch (err) {
    console.error("[order-create-v2]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
