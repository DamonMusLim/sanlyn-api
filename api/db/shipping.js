import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard
import { derivePlanFromOrders } from "../lib/derive-plan-from-orders.js"; // task 1817: 读时按 order_nos[] 派生工厂/客户/etd/量类
import { sendCancellationNotice } from "../../jobs/shipment-notify.js"; // 2026-06-26: 取消通知工厂
import { normalizeContainersDetail } from "../lib/containers-detail-guard.js"; // 2026-07-12: CY00376 柜数虚增防线

// Normalize a Chinese company name for matching:
//  - strip full/half-width brackets, spaces, punctuation
//  - drop leading geo prefix (厦门/上海/天津/…)
//  - drop generic corporate suffixes (有限公司/有限责任公司/股份有限公司/分公司)
// So e.g. both "万汇国际（厦门）" and "万汇国际厦门有限公司" → "万汇国际"
// while "万汇恒通(厦门)国际物流有限公司" → "万汇恒通国际物流" (distinct!)
function normCompany(s) {
  if (!s) return "";
  let x = String(s).replace(/[（）()【】\[\]\s、，,。.·\-_/\\]/g, "");
  const geo = ["厦门","上海","天津","青岛","宁波","深圳","山东","江苏","烟台","福建","广州"];
  for (const g of geo) if (x.startsWith(g) && x.length > g.length + 1) { x = x.slice(g.length); break; }
  x = x.replace(/(股份有限公司|有限责任公司|有限公司|分公司)$/g, "");
  return x;
}

// 可写列白名单（绝不放 id/_id/created_at/tenant 等）
const WRITABLE = [
  "bl_no","shipment_no","mbl_no","hbl_no","so_no","booking_no","forwarder_booking_no",
  "vessel","voyage","carrier_code","route_type","transit","schedule","call_port",
  "etd","eta","atd","ata","cutoff_date","si_cutoff_date","port_open_date","doc_cutoff",
  "container_no","container_type","container_qty","seal_no","release_type","freight_term",
  "customer","customer_en","customer_cn","issuing_company","shipper","notify_party",
  "pol","pod","pol_country","pod_country",
  "contract_no","order_contract_nos","contract_nos","order_nos","sub_order_no","shipment_no",
  "forwarder_cn","forwarder_en","forwarder_partner","trucking_cn","customs_cn","insurance_cn",
  "customs_broker_id","customs_broker_cn","trucking_company_id","trucking_company_cn",
  "factory_company_id","trucking_arrange","forwarder_company_id",
  "freight_cost","freight_sale_usd","freight_sale_cny","freight_total_usd","freight_total_cny",
  "port_surcharge_total","trucking_cost_total","customs_cost_total","insurance_cost",
  "doc_fee","tlx_fee","bkg_fee","thc_fee","eir_fee","seal_fee","vgm_fee","customs_declare_fee","info_trans_fee",
  "gross_weight_kg","total_cartons","total_cbm","cargo_description","cargo_ready_date",
  "is_ddp","ddp_total","ddp_agent","status","flow_status","shipping_status","source_system","remarks","arrange_mode",
  "containers_detail","trucking_detail","driver_info","raw","container_bookings",
  // 托书四方确认 + 洋宝宝价格 (2026-06-22)
  "booking_stage",
  "forwarder_price_confirmed_at",
  "customer_consignee_confirmed_at",
  "factory_dispatch_confirmed_at",
  "oceanbaby_price_confirmed",
];
const JSONB_COLS = new Set(["containers_detail","trucking_detail","driver_info","raw",
  "order_contract_nos","contract_nos","order_nos","container_bookings"]);
const ARRAY_COLS = new Set(["order_nos","contract_nos"]);
function buildSet(body, params) {
  const sets = [];
  for (const col of WRITABLE) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    let v = body[col];
    if (ARRAY_COLS.has(col)) { v = Array.isArray(v) ? v : (v == null ? null : [v]); params.push(v); sets.push(`${col} = $${params.length}`); }
    else if (JSONB_COLS.has(col)) { params.push(v == null ? null : JSON.stringify(v)); sets.push(`${col} = $${params.length}::jsonb`); }
    else { params.push(v); sets.push(`${col} = $${params.length}`); }
  }
  return sets;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  const poolW = getPool();

  // ── POST: 新建海运计划（修复「一直没写入」：原来只有 GET，+New 撞 405）──
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      if (Object.prototype.hasOwnProperty.call(body, "containers_detail"))
        body.containers_detail = normalizeContainersDetail(body.containers_detail, body.container_qty);
      const params = [];
      const sets = buildSet(body, params);
      // _id 必填(NOT NULL) → 自动生成；created_by 记录操作者
      const _id = (body._id && String(body._id)) || ("sp_" + Math.random().toString(36).slice(2) + Date.now().toString(36));
      params.push(_id); sets.push(`_id = $${params.length}`);
      const u = req.user || {};
      params.push(u.name || u.username || u.email || u.role || "admin"); sets.push(`created_by = $${params.length}`);
      sets.push(`created_at = now()`); sets.push(`updated_at = now()`);
      if (sets.length <= 3) return res.status(400).json({ success:false, error:"no fields" });
      const cols = sets.map(s => s.split(" = ")[0]);
      const vals = sets.map(s => s.split(" = ")[1]);
      const sql = `INSERT INTO shipping_plans (${cols.join(",")}) VALUES (${vals.join(",")}) RETURNING *`;
      const r = await poolW.query(sql, params);
      return res.status(201).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

  // ── PATCH: 更新海运计划（by id 或 _id）──
  if (req.method === "PATCH") {
    try {
      const body = req.body || {};
      const BOOKING_STAGES = new Set(["so_received","confirming","confirmed"]);
      if (body.booking_stage && !BOOKING_STAGES.has(body.booking_stage)) {
        return res.status(400).json({ success:false, error:"invalid booking_stage" });
      }
      const id = body.id != null ? parseInt(body.id, 10) : null;
      const _id = body._id != null ? String(body._id) : null;
      if (id == null && !_id) return res.status(400).json({ success:false, error:"id or _id required" });
      if (Object.prototype.hasOwnProperty.call(body, "containers_detail") && Array.isArray(body.containers_detail)) {
        let cq = body.container_qty;
        if (cq == null) {
          const qr = (id != null && Number.isFinite(id))
            ? await poolW.query("SELECT container_qty FROM shipping_plans WHERE id = $1", [id])
            : await poolW.query("SELECT container_qty FROM shipping_plans WHERE _id = $1", [_id]);
          cq = qr.rows[0] ? qr.rows[0].container_qty : null;
        }
        body.containers_detail = normalizeContainersDetail(body.containers_detail, cq);
      }
      const params = [];
      const sets = buildSet(body, params);
      if (!sets.length) return res.status(400).json({ success:false, error:"no editable fields" });
      sets.push(`updated_at = now()`);
      let where;
      if (id != null && Number.isFinite(id)) { params.push(id); where = `id = $${params.length}`; }
      else { params.push(_id); where = `_id = $${params.length}`; }
      const r = await poolW.query(`UPDATE shipping_plans SET ${sets.join(", ")} WHERE ${where} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success:false, error:"not found" });
      // ── 取消副作用 (2026-06-26): flow_status→已取消 时盖时间戳 + 留痕 + 通知工厂 ──
      try {
        const nf = String(body.flow_status || "");
        const isCancel = /cancel/i.test(nf) || nf.indexOf("已取消") >= 0 || nf === "取消";
        if (isCancel && Object.prototype.hasOwnProperty.call(body, "flow_status")) {
          const row = r.rows[0];
          const who = (req.user && (req.user.name || req.user.username || req.user.email || req.user.role)) || "admin";
          await poolW.query("UPDATE shipping_plans SET cancelled_at = COALESCE(cancelled_at, now()), cancelled_by = COALESCE(cancelled_by, $2) WHERE id = $1", [row.id, who]).catch(()=>{});
          poolW.query("INSERT INTO shipping_plan_audit (plan_id, plan_uid, action, actor, detail) VALUES ($1,$2,'cancel',$3,$4::jsonb)",
            [row.id, row._id || null, who, JSON.stringify({ bl_no: row.bl_no, shipment_no: row.shipment_no })]).catch(()=>{});
          // 通知工厂(企微, best-effort, 失败不影响取消)
          sendCancellationNotice(poolW, row, who).catch((e)=>console.warn("[shipping cancel notify]", e.message));
        }
      } catch (ce) { console.warn("[shipping cancel side-effect]", ce.message); }
      // Normalize issuing_company: English alias → canonical name_cn from companies(sanlyn_entity)
      if (Object.prototype.hasOwnProperty.call(body, "issuing_company")) {
        poolW.query(
          `UPDATE shipping_plans sp SET issuing_company = c.name_cn
             FROM companies c
            WHERE sp.id = $1
              AND c.type = 'sanlyn_entity'
              AND coalesce(sp.source_system, '') != 'freight_agency'
              AND sp.issuing_company IS NOT NULL
              AND upper(replace(replace(sp.issuing_company, '.', ''), ',', '')) =
                  upper(replace(replace(c.name_en, '.', ''), ',', ''))
              AND sp.issuing_company IS DISTINCT FROM c.name_cn`,
          [r.rows[0].id]
        ).catch(function(e) { console.warn("[shipping PATCH] normalize issuing_company:", e.message); });
      }
      return res.status(200).json({ success:true, data:r.rows[0] });
    } catch (err) { return res.status(500).json({ success:false, error: err.message }); }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { customer, created_by, shipment_no, forwarder_company_id, bl_no, limit = 500 } = req.query;
    let query = "SELECT * FROM shipping_plans", params = [], conds = [];
    // 按CY号/货代精确过滤(agent自动补链用,服务端过滤=只富集匹配行,避免全表N+1慢)
    if (shipment_no) { params.push(shipment_no); conds.push(`shipment_no = $${params.length}`); }
    if (bl_no) { params.push(bl_no); conds.push(`(bl_no = $${params.length} OR mbl_no = $${params.length} OR hbl_no = $${params.length} OR booking_no = $${params.length} OR forwarder_booking_no = $${params.length})`); }
    if (forwarder_company_id) { params.push(parseInt(forwarder_company_id)); conds.push(`forwarder_company_id = $${params.length}`); }
    if (customer) { params.push(`%${customer}%`); conds.push(`customer ILIKE $${params.length}`); }
    if (created_by) { params.push(created_by); conds.push(`created_by = $${params.length}`); }

    // ── Vendor data scoping: logistics users see ONLY their own shipments ──
    // Strategy: fetch candidate rows then filter in Node by bidirectional
    // normalized-substring match (tighter than SQL ILIKE on a 2-char prefix).
    const u = req.user || {};
    let scopeCol = null, scopeNeedle = "";

    // ── Tenant scope for ALL non-logistics, non-admin roles ──────────────────
    const isAdmin = u.role === "admin" || u.role === "superadmin";
    if (u.role !== "logistics" && !isAdmin) {
      const callerCode = u.companyCode || u.company_code || "";
      if (!callerCode) {
        return res.status(403).json({ error: "company_scope_missing" });
      }
      const allCodes = (u.companyCodes && u.companyCodes.length)
        ? u.companyCodes
        : [callerCode];
      params.push(allCodes);
      conds.push(`company_code = ANY($${params.length}::text[])`);
    }
    // admin/superadmin: no company_code filter → full-table access is intentional

    if (u.role === "logistics") {
      scopeCol = u.supplierRole === "ocean" ? "forwarder_cn"
              : u.supplierRole === "customs" ? "customs_cn"
              : u.supplierRole === "truck"   ? "trucking_cn"
              : null;
      scopeNeedle = normCompany(u.company);
      if (!scopeCol || !scopeNeedle) {
        return res.status(200).json({ success: true, data: [], count: 0, scoped: "logistics:empty" });
      }
      // Pre-filter in SQL with a loose 2-char hint to avoid scanning all rows,
      // then apply tight substring check in Node.
      const hint = scopeNeedle.slice(0, 2);
      params.push(`%${hint}%`);
      conds.push(`${scopeCol} ILIKE $${params.length}`);
    }

    // 软删: 默认不显示回收站记录; ?include_deleted=1 才带出(回收站视图)
    if (req.query.include_deleted !== "1") conds.push("deleted_at IS NULL");
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY etd DESC NULLS LAST, created_at DESC NULLS LAST, id DESC LIMIT $${params.length}`;  // ETD为主(Damon 2026-06-12), 无ETD按新增
    let rows = (await pool.query(query, params)).rows;

    if (scopeCol && scopeNeedle) {
      rows = rows.filter(r => {
        const cell = normCompany(r[scopeCol]);
        return cell && (cell.includes(scopeNeedle) || scopeNeedle.includes(cell));
      });
    }

    // ── Master-first enrichment (2026-06-04): derive order-side + consignee fields ──
    // shipping_plans is NOT linked to orders (order_nos empty across the table); the only
    // key is the comma-separated `order_contract_nos` text, which matches orders.contract_no.
    // orders hold 出单公司 / PO / cargo totals / 贸易条款(trade_terms); customers master holds
    // the 收货方 contact / country / address. Surface them read-time only: fill-if-empty —
    // never overwrite a value shipping_plans already has, never fabricate.
    //
    // SECURITY (gpt-5.5 review 2026-06-04): enrich for ADMIN ONLY. shipping_plans has no
    // company_code column, so we can't tenant-scope the orders/customers lookups; restricting
    // enrichment to admin/superadmin prevents over-exposing consignee commercial details
    // (contact/phone/address) to scoped logistics(forwarder) callers.
    if (isAdmin) try {
      const empty = (v) => v == null || String(v).trim() === "";
      const emptyNum = (v) => v == null || (typeof v === "string" && v.trim() === "");
      const normEn = (s) => String(s || "").trim().toLowerCase();
      const fin = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      // order_contract_nos is a MULTI-value field in inconsistent shapes: comma list, PG array
      // literal `{a,b}`, pipe `48-5|FS...`. Strip braces/brackets/quotes, split on , or |.
      const parseCNs = (s) => String(s || "").replace(/[{}\[\]"]/g, " ").split(/[,|]/).map(x => x.trim()).filter(Boolean);
      // contract_no is a SINGLE canonical value — do NOT split on delimiters (gpt-5.5 review):
      // splitting could spuriously match an unrelated order. Just strip braces + trim.
      const cleanCN = (s) => { const v = String(s || "").replace(/[{}\[\]"]/g, "").trim(); return v || null; };
      const allCNs = new Set();
      const custNames = new Set();
      for (const r of rows) {
        for (const cn of parseCNs(r.order_contract_nos)) allCNs.add(cn);
        const c = cleanCN(r.contract_no); if (c) allCNs.add(c);
        if (!empty(r.customer)) custNames.add(normEn(r.customer));
      }

      // orders keyed by contract_no
      const byCN = new Map();
      if (allCNs.size) {
        const ords = (await pool.query(
          `SELECT id, contract_no, issuing_company, customer_po, pol, trade_terms,
                  total_qty, total_cbm, gross_weight, container_type, container_qty
             FROM orders WHERE contract_no = ANY($1::text[])`,
          [[...allCNs]]
        )).rows;
        for (const o of ords) if (o.contract_no) byCN.set(String(o.contract_no).trim(), o);
      }

      // customers master keyed by normalized name_en (consignee = shipping_plans.customer)
      const custByName = new Map();
      if (custNames.size) {
        const custs = (await pool.query(
          `SELECT name_en, name_cn, contact_name, contact_phone, contact_email, country, country_en, addresses
             FROM customers WHERE lower(btrim(name_en)) = ANY($1::text[])`,
          [[...custNames]]
        )).rows;
        for (const c of custs) if (c.name_en) custByName.set(normEn(c.name_en), c);
      }
      const pickAddr = (addrs) => {
        if (!Array.isArray(addrs)) return "";
        const a = addrs.find(x => /consignee|shipping|delivery/i.test(x?.type))
               || addrs.find(x => /billing/i.test(x?.type)) || addrs[0] || {};
        return a && (a.full || a.address) || "";
      };

      for (const r of rows) {
        // own copy so injections are safe; guard against jsonb that isn't a plain object
        r.raw = (r.raw && typeof r.raw === "object" && !Array.isArray(r.raw)) ? { ...r.raw } : {};

        // (a) order-derived fields — order_contract_nos (multi) + canonical contract_no (single)
        const cns = [...new Set([...parseCNs(r.order_contract_nos), cleanCN(r.contract_no)].filter(Boolean))];
        // map candidates → orders, then dedup by order id (gpt-5.5 review) so totals never double-count
        const seenOrd = new Set();
        const linked = cns.map(cn => byCN.get(cn)).filter(o => o && !seenOrd.has(o.id) && seenOrd.add(o.id));
        if (linked.length) {
          const firstNonEmpty = (k) => { for (const o of linked) if (!empty(o[k])) return o[k]; return null; };
          const sum = (k) => { let s = null; for (const o of linked) { const n = fin(o[k]); if (n != null) s = (s || 0) + n; } return s; };
          const poList = [...new Set(linked.map(o => o.customer_po).filter(v => !empty(v)))].join(", ");
          const incoterm = firstNonEmpty("trade_terms");
          const sCbm = sum("total_cbm"), sQty = sum("total_qty"), sGw = sum("gross_weight");
          if (empty(r.issuing_company))   r.issuing_company  = firstNonEmpty("issuing_company");
          if (empty(r.pol))               r.pol              = firstNonEmpty("pol");
          if (emptyNum(r.total_cbm)      && sCbm != null) r.total_cbm       = sCbm;
          if (emptyNum(r.total_cartons)  && sQty != null) r.total_cartons   = sQty;
          if (emptyNum(r.gross_weight_kg)&& sGw  != null) r.gross_weight_kg = sGw;
          // container auto-derive from linked orders when shipping_plan has none
          if (emptyNum(r.container_qty)) {
            let totalCtn = null;
            for (const o of linked) { const n = parseInt(o.container_qty); if (!isNaN(n) && n > 0) totalCtn = (totalCtn || 0) + n; }
            if (totalCtn != null) r.container_qty = totalCtn;
          }
          if (empty(r.container_type)) { const ct = firstNonEmpty('container_type'); if (ct) r.container_type = ct; }
          if (empty(r.raw.customerPO) && poList)  r.raw.customerPO = poList;
          if (empty(r.raw.incoterm)   && incoterm) r.raw.incoterm  = incoterm;
          r.order_linked_count = linked.length;
        }

        // (b) consignee fields from customers master (the editor reads raw.consignee_*)
        const cust = custByName.get(normEn(r.customer));
        if (cust) {
          const addr = pickAddr(cust.addresses);
          if (empty(r.raw.consignee_name_cn) && !empty(cust.name_cn))      r.raw.consignee_name_cn = cust.name_cn;
          if (empty(r.raw.consignee_contact) && !empty(cust.contact_name)) r.raw.consignee_contact = cust.contact_name;
          if (empty(r.raw.consignee_phone)   && !empty(cust.contact_phone))r.raw.consignee_phone   = cust.contact_phone;
          if (empty(r.raw.consignee_country) && (!empty(cust.country) || !empty(cust.country_en)))
            r.raw.consignee_country = cust.country || cust.country_en;
          if (empty(r.raw.consignee_address) && !empty(addr))             r.raw.consignee_address = addr;
          if (empty(r.raw.contactEmail)     && !empty(cust.contact_email)) r.raw.contactEmail      = cust.contact_email;
        }
      }

      // (a2) order_nos[]-based derive (task 1817, 2026-06-24) ───────────────────────
      // 治本: 订单数据有但海运显示「缺」, 根因=两表没派生 + 关联用错钥匙(脏标量 contract_no)。
      // 真实关联键 = shipping_plans.order_nos[] → orders.order_no。块(a)用 contract_no 兜底,
      // 这里用 order_nos[] 把工厂/客户/etd/量类派生出来。fill-if-empty: 计划自身字段为空才补,
      // 绝不覆盖人工已填值; 一票多柜多工厂 → factory_company_ids 数组不塌缩(主标量列留空走多值展示);
      // 量类锚 OLI 真值。只读, 不落库, 派生不出来就留空(绝不造数)。
      try {
        for (const r of rows) {
          const hasOns = Array.isArray(r.order_nos) && r.order_nos.filter(Boolean).length > 0;
          const hasDirtyCN = r.contract_no && /[\s,/|]/.test(String(r.contract_no));
          // 仅当存在 order_nos[](或可兜底的单值 contract_no)时才派生; 块(a)已覆盖纯净 contract_no 单值路径。
          if (!hasOns && !(r.contract_no && !hasDirtyCN)) continue;
          let d;
          try { d = await derivePlanFromOrders(r, pool); }
          catch (de) { continue; } // 单行派生失败不影响其余行
          if (!d || !d.linked_order_count) continue;

          // 工厂: 多值不塌缩。计划主标量 factory_company_id 为空时:
          //   单工厂 → 回填标量; 多工厂 → 主标量留空, 只给数组走多值展示。
          if (Array.isArray(d.factory_company_ids) && d.factory_company_ids.length) {
            r.derived_factory_company_ids = d.factory_company_ids; // 始终给数组(供多值展示)
            if (empty(r.factory_company_id) && d.factory_company_ids.length === 1) {
              r.factory_company_id = d.factory_company_ids[0];
            }
            r.factory_multi = d.factory_company_ids.length > 1;
          }
          // 客户 / etd / pol / issuing_company / container_type — fill-if-empty
          if (empty(r.customer_company_id) && d.customer_company_id != null) r.customer_company_id = d.customer_company_id;
          if (empty(r.etd)             && d.etd)             r.etd             = d.etd;
          if (empty(r.pol)             && d.pol)             r.pol             = d.pol;
          if (empty(r.issuing_company) && d.issuing_company) r.issuing_company = d.issuing_company;
          if (empty(r.container_type)  && d.container_type)  r.container_type  = d.container_type;
          // 量类锚 OLI — fill-if-empty
          if (emptyNum(r.total_cartons)   && d.total_cartons   != null) r.total_cartons   = d.total_cartons;
          if (emptyNum(r.gross_weight_kg) && d.gross_weight_kg != null) r.gross_weight_kg = d.gross_weight_kg;
          r.order_nos_linked_count = d.linked_order_count;
        }
      } catch (a2e) { /* order_nos derive best-effort */ }

      // (c) customs_data enrichment: link by shipping_plan_id (Workstream B, 2026-06-07)
      try {
        const planIds = rows.map(r => r.id).filter(v => v != null);
        if (planIds.length) {
          const custRes = await pool.query(
            `SELECT shipping_plan_id,
                    COUNT(*) AS doc_count,
                    bool_or(customs_dec IS NOT NULL) AS has_customs_dec,
                    bool_or(bl_final    IS NOT NULL) AS has_bl_final,
                    bool_or(origin_cert IS NOT NULL) AS has_origin_cert
             FROM customs_data
             WHERE shipping_plan_id = ANY($1::int[])
             GROUP BY shipping_plan_id`,
            [planIds]
          );
          const byPlanId = new Map(custRes.rows.map(r => [r.shipping_plan_id, r]));
          for (const r of rows) {
            const cd = byPlanId.get(r.id);
            if (cd) {
              r.customs_doc_count  = parseInt(cd.doc_count) || 0;
              r.customs_has_dec    = cd.has_customs_dec;
              r.customs_has_bl     = cd.has_bl_final;
              r.customs_has_origin = cd.has_origin_cert;
              // simple status roll-up
              r.customs_status = cd.has_customs_dec ? 'declared'
                               : cd.has_bl_final    ? 'bl_ready'
                               : 'pending';
            } else {
              r.customs_doc_count = 0;
              r.customs_status    = null;
            }
          }
        }
      } catch (ce) { /* customs enrichment best-effort */ }

      // (d) balance_paid enrichment: 客户尾款(货款)是否已收 (task 1816, 2026-06-23)
      // 真值口径(踩坑铁律): 回款 direction 多为空串'' 而非 'in'，必须用
      //   COALESCE(direction,'') NOT IN ('out','refund') 判收款，否则漏空串/NULL。
      // 匹配键: 海运计划的 contract_nos[] (一票多柜=多合同) 精确匹配 finance_payments.contract_no。
      //   customer+amount 模糊匹配会误判(同客户几十笔/计划捆多合同总额不等于单笔)，故只用 contract_no 精确键。
      // 只算货款/尾款，排除海运费(运费/freight/ocean_freight)。
      // 一票多柜: 全部合同都有货款回款=paid; 部分=partial; 全无=unpaid; 无合同号=null(不显徽章)。
      // 只读 enrich，绝不写库。
      try {
        const splitArr = (a) => Array.isArray(a) ? a.map(x => String(x || "").trim()).filter(Boolean) : [];
        const planCNs = new Map(); // plan id -> [contract_no...]
        const allBalCNs = new Set();
        for (const r of rows) {
          let cns = splitArr(r.contract_nos);
          if (!cns.length && r.contract_no && String(r.contract_no).trim()) {
            cns = [String(r.contract_no).trim()];
          }
          cns = [...new Set(cns)];
          planCNs.set(r.id, cns);
          for (const c of cns) allBalCNs.add(c);
        }
        if (allBalCNs.size) {
          const payRes = await pool.query(
            `SELECT DISTINCT contract_no
               FROM finance_payments
              WHERE contract_no = ANY($1::text[])
                AND COALESCE(direction,'') NOT IN ('out','refund')
                AND COALESCE(status,'') NOT IN ('pending','已退回/已冲销')
                AND COALESCE(pay_item,'') NOT ILIKE '%运费%'
                AND COALESCE(pay_item,'') NOT IN ('freight','ocean_freight')`,
            [[...allBalCNs]]
          );
          const paidCNs = new Set(payRes.rows.map(x => String(x.contract_no).trim()));
          for (const r of rows) {
            const cns = planCNs.get(r.id) || [];
            if (!cns.length) { r.balance_paid = null; r.balance_paid_status = null; continue; }
            const n = cns.length;
            const np = cns.filter(c => paidCNs.has(c)).length;
            r.balance_paid_status = np === 0 ? "unpaid" : (np === n ? "paid" : "partial");
            r.balance_paid = np === n && n > 0; // boolean: 全部尾款已收
            r.balance_paid_count = np;
            r.balance_total_count = n;
          }
        }
      } catch (be) { /* balance_paid enrichment best-effort */ }

    } catch (e) { /* enrichment is best-effort; never fail the listing on it */ }

    return res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
