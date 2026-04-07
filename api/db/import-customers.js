// /api/db/import-customers.js — Import/upsert customers from JDY Excel data
// POST: array of customer objects → upsert into customers table
// GET: list all customers with full detail
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();

  // ── GET: list all customers ──
  if (req.method === "GET") {
    try {
      var result = await pool.query(
        "SELECT * FROM customers ORDER BY company_name_en, company_name_cn"
      );
      return res.status(200).json({ success: true, count: result.rows.length, customers: result.rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: upsert customers ──
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var customers = req.body;
    if (!Array.isArray(customers)) customers = [customers];

    // Ensure customers table has the columns we need
    await pool.query(`
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS person_no TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS brands TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS linked_factory TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS departments TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS bl_type TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS country TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS country_en TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS currency TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS grade TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_policy TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms JSONB;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS pricing_mode TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS trade_terms TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS logistics_markup TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS logistics_markup_pct TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS logistics_markup_per_container TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS our_shipping TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS destination_port TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE customers ADD COLUMN IF NOT EXISTS consignee TEXT;
    `).catch(function(e) { console.log("ALTER:", e.message); });

    var results = [];
    for (var c of customers) {
      var id = c.data_id || ("cust_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
      var companyCode = c.company_code || id;
      var nameEN = c.company_name_en || "";
      var nameCN = c.company_name_cn || "";

      // Build raw JSON with all original data
      var rawData = Object.assign({}, c);

      var sql = `
        INSERT INTO customers (_id, company_code, company_name_en, company_name_cn, person_no, brands, linked_factory, departments, bl_type, country, country_en, currency, grade, payment_policy, payment_terms, pricing_mode, trade_terms, logistics_markup, logistics_markup_pct, logistics_markup_per_container, our_shipping, destination_port, address, consignee, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        ON CONFLICT (_id) DO UPDATE SET
          company_code = EXCLUDED.company_code,
          company_name_en = EXCLUDED.company_name_en,
          company_name_cn = EXCLUDED.company_name_cn,
          person_no = EXCLUDED.person_no,
          brands = EXCLUDED.brands,
          linked_factory = EXCLUDED.linked_factory,
          departments = EXCLUDED.departments,
          bl_type = EXCLUDED.bl_type,
          country = EXCLUDED.country,
          country_en = EXCLUDED.country_en,
          currency = EXCLUDED.currency,
          grade = EXCLUDED.grade,
          payment_policy = EXCLUDED.payment_policy,
          payment_terms = EXCLUDED.payment_terms,
          pricing_mode = EXCLUDED.pricing_mode,
          trade_terms = EXCLUDED.trade_terms,
          logistics_markup = EXCLUDED.logistics_markup,
          logistics_markup_pct = EXCLUDED.logistics_markup_pct,
          logistics_markup_per_container = EXCLUDED.logistics_markup_per_container,
          our_shipping = EXCLUDED.our_shipping,
          destination_port = EXCLUDED.destination_port,
          address = EXCLUDED.address,
          consignee = EXCLUDED.consignee,
          raw = EXCLUDED.raw
        RETURNING _id, company_name_en, company_name_cn
      `;

      var vals = [
        id, companyCode, nameEN, nameCN,
        c.person_no || "", c.brands || "", c.linked_factory || "", c.departments || "",
        c.bl_type || "", c.country_cn || "", c.country_en || "",
        c.currency || "CNY", c.grade || "", c.payment_policy || "",
        JSON.stringify(c.payment_terms || []),
        c.pricing_mode || "", c.trade_terms || "",
        c.logistics_markup || "", c.logistics_markup_pct || "", c.logistics_markup_per_container || "",
        c.our_shipping || "", c.destination_port || "", c.address || "", c.consignee || "",
        JSON.stringify(rawData)
      ];

      try {
        var r = await pool.query(sql, vals);
        results.push({ success: true, customer: r.rows[0] });
      } catch (e) {
        results.push({ success: false, id: id, error: e.message });
      }
    }

    var ok = results.filter(function(r) { return r.success; }).length;
    var fail = results.filter(function(r) { return !r.success; }).length;

    return res.status(200).json({
      success: true,
      imported: ok,
      failed: fail,
      results: results,
    });
  } catch (err) {
    console.error("[import-customers]", err);
    return res.status(500).json({ error: err.message });
  }
}
