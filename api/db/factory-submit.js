// api/db/factory-submit.js — S97: Factory form submission API
//
// POST /api/db/factory-submit
//   Receives factory booking form data, auto-creates account + shipping_plans record
//
// Flow:
//   1. Validate required fields
//   2. Check if factory account already exists (by phone or company name)
//   3. If not, create account (role=factory) + generate credentials
//   4. Write shipping_plans record with cargo details
//   5. Return credentials + shipment reference

import { getPool, setCors } from "../db.js";

function _genId() {
  return "FS-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function _genShipmentNo() {
  var d = new Date();
  var yy = String(d.getFullYear()).slice(2);
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var seq = Math.random().toString(36).slice(2, 6).toUpperCase();
  return "SH" + yy + mm + "-" + seq;
}

function _genUsername(contact, phone) {
  // Use phone as username base; fallback to contact name pinyin-ish
  if (phone) return phone.replace(/\D/g, "").slice(-11);
  if (contact) return contact.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "factory" + Date.now().toString(36);
  return "factory" + Date.now().toString(36);
}

function _genPassword(phone) {
  // Default password: last 6 digits of phone, or random 6
  if (phone) {
    var digits = phone.replace(/\D/g, "");
    if (digits.length >= 6) return digits.slice(-6);
  }
  return Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var pool = getPool();
    var body = req.body || {};

    // ── Extract form fields ──
    var items        = body.items || [];
    var readyDate    = body.readyDate || null;
    var tradeTerms   = body.tradeTerms || "";
    var serviceMode  = body.serviceMode || "allin";
    var services     = body.services || [];
    var insurance    = !!body.insurance;
    var declaredValue = body.declaredValue || "";
    var contact      = body.contact || "";
    var phone        = body.phone || "";
    var companyName  = body.companyName || body.company || "";
    var taxId        = body.taxId || "";
    var legalPerson  = body.legalPerson || "";
    var regAddress   = body.regAddress || "";
    var licenseUrl   = body.licenseUrl || null;
    var locationImg  = body.locationImg || null;     // { text, aiResult: { province, city, ... formatted } }
    var packingList  = body.packingList || null;

    // Validate
    if (!items.length || !items.some(function(it) { return (it.name || "").trim(); })) {
      return res.status(400).json({ success: false, error: "至少填写一条货物品名 / At least one cargo item required" });
    }
    if (!phone && !contact) {
      return res.status(400).json({ success: false, error: "联系人或手机号必填 / Contact name or phone required" });
    }

    // ── Compute cargo totals ──
    var totalCartons = 0, totalWeight = 0, totalCBM = 0;
    items.forEach(function(it) {
      totalCartons += parseFloat(it.qty) || 0;
      totalWeight  += parseFloat(it.weight) || 0;
      totalCBM     += parseFloat(it.cbm) || 0;
    });

    // ── Check existing account by phone ──
    var username = _genUsername(contact, phone);
    var password = _genPassword(phone);
    var accountCreated = false;
    var existingAccount = null;

    var acctCheck = await pool.query(
      "SELECT * FROM accounts WHERE username = $1 LIMIT 1",
      [username]
    );

    if (acctCheck.rowCount > 0) {
      existingAccount = acctCheck.rows[0];
      // Don't overwrite existing password
      password = "(已有账号 / existing account)";
    } else {
      // Create new factory account
      var companyCode = "FAC-" + (phone ? phone.replace(/\D/g, "").slice(-6) : Date.now().toString(36).slice(-6).toUpperCase());

      await pool.query(
        `INSERT INTO accounts (username, password, role, company, supplier_role, permissions, department, raw, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (username) DO NOTHING`,
        [
          username,
          password,
          "factory",
          companyName || contact || "Factory-" + username,
          "factory",
          "view_shipping,view_documents,upload_docs",
          "",
          JSON.stringify({
            source: "factory-form",
            contact: contact,
            phone: phone,
            companyName: companyName,
            taxId: taxId,
            legalPerson: legalPerson,
            regAddress: regAddress,
            licenseUrl: licenseUrl,
            createdAt: new Date().toISOString(),
          }),
        ]
      );
      accountCreated = true;
    }

    // ── Build address from AI result ──
    var address = "";
    if (locationImg && locationImg.aiResult) {
      address = locationImg.aiResult.formatted || locationImg.text || "";
    } else if (locationImg && locationImg.text) {
      address = locationImg.text;
    }

    // ── Create shipping_plans record ──
    var shipmentNo = _genShipmentNo();
    var planId = _genId();

    var rawData = {
      source: "factory-form",
      formSubmittedAt: new Date().toISOString(),
      contact: contact,
      phone: phone,
      companyName: companyName,
      taxId: taxId,
      legalPerson: legalPerson,
      regAddress: regAddress,
      licenseUrl: licenseUrl,
      address: address,
      addressDetail: locationImg && locationImg.aiResult ? locationImg.aiResult : null,
      readyDate: readyDate,
      tradeTerms: tradeTerms,
      serviceMode: serviceMode,
      services: services,
      insurance: insurance,
      declaredValue: declaredValue,
      items: items,
      totalCartons: totalCartons,
      totalWeight: totalWeight,
      totalCBM: totalCBM,
      packingListName: packingList ? packingList.name : null,
      factoryUsername: username,
    };

    await pool.query(
      // W0-4: explicit forwarder_partner=NULL prevents DDL default '上海洋宝宝 × COSCO' from firing.
      `INSERT INTO shipping_plans
        (_id, shipment_no, customer, created_by, flow_status, raw, forwarder_partner, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NOW())
       ON CONFLICT (_id) DO UPDATE SET
        shipment_no=$2, customer=$3, created_by=$4, flow_status=$5, raw=$6, updated_at=NOW()`,
      [
        planId,
        shipmentNo,
        companyName || contact,
        username,
        "cargo_ready",
        JSON.stringify(rawData),
      ]
    );

    // ── Response ──
    return res.status(200).json({
      success: true,
      shipment_no: shipmentNo,
      account: {
        username: username,
        password: accountCreated ? password : undefined,
        is_new: accountCreated,
        login_url: "https://ai.sanlynos.com",
        message: accountCreated
          ? "账号已自动创建，请使用以下凭证登录 / Account created, use credentials below to log in"
          : "已关联到现有账号 / Linked to existing account",
      },
      cargo_summary: {
        items: items.filter(function(it) { return (it.name || "").trim(); }).length,
        total_cartons: totalCartons,
        total_weight_kg: totalWeight,
        total_cbm: totalCBM,
        ready_date: readyDate,
        trade_terms: tradeTerms,
      },
    });

  } catch (err) {
    console.error("[factory-submit] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
