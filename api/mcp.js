// api/mcp.js — Sanlyn MCP Server (streamable-HTTP, MCP 2024-11-05)
// WorkBuddy connects here as a connector: https://ai.sanlyn.cn/api/mcp
// Auth: x-mcp-key header = MCP_SECRET env var
import { getPool } from "./db.js";

// 0929: 去掉写死的默认密码;没设 MCP_SECRET 时一律拒绝(fail closed)
const MCP_SECRET = process.env.MCP_SECRET || "";
const SERVER_INFO = { name: "sanlyn-api", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "query_rebates",
    description: "查询出口退税记录。支持按年月筛选，或获取有数据的月份列表。",
    inputSchema: {
      type: "object",
      properties: {
        year:  { type: "number", description: "年份，如 2026" },
        month: { type: "number", description: "月份 1-12" },
        list_months: { type: "boolean", description: "为 true 时返回有数据的月份列表" },
      },
    },
  },
  {
    name: "query_orders",
    description: "查询订单列表。可按客户、状态、合同号搜索。",
    inputSchema: {
      type: "object",
      properties: {
        q:       { type: "string",  description: "搜索关键词（合同号/订单号/客户名）" },
        status:  { type: "string",  description: "状态过滤" },
        limit:   { type: "number",  description: "返回条数，默认 20，最大 100" },
      },
    },
  },
  {
    name: "query_shipping",
    description: "查询海运计划。可按 BL 号、合同号、状态搜索。",
    inputSchema: {
      type: "object",
      properties: {
        q:      { type: "string", description: "BL号/合同号/船名等关键词" },
        status: { type: "string", description: "状态过滤：booked/departed/arrived" },
        limit:  { type: "number", description: "返回条数，默认 20" },
      },
    },
  },
  {
    name: "query_fe_certs",
    description: "查询 FE 原产地证书状态。",
    inputSchema: {
      type: "object",
      properties: {
        q:      { type: "string", description: "合同号/BL号/证书号关键词" },
        status: { type: "string", description: "状态: pending/filed/issued/printed" },
        limit:  { type: "number", description: "返回条数，默认 20" },
      },
    },
  },
  {
    name: "query_customs",
    description: "查询报关记录，含报关单号、HS码、退税率。",
    inputSchema: {
      type: "object",
      properties: {
        q:     { type: "string", description: "报关单号/合同号/品名" },
        limit: { type: "number", description: "返回条数，默认 20" },
      },
    },
  },
  {
    name: "query_invoices_out",
    description: "查询销项发票（开给客户的发票，表 finance_invoices_out）。可按发票号/合同号/购方名搜索，按开票年月、发票类型筛选。金额原样返回，不换算币种。",
    inputSchema: {
      type: "object",
      properties: {
        q:            { type: "string", description: "搜索关键词（发票号/合同号/购方名）" },
        year:         { type: "number", description: "开票年份，如 2026" },
        month:        { type: "number", description: "开票月份 1-12，可单独使用" },
        invoice_type: { type: "string", description: "发票类型精确过滤（取值同库内 invoice_type）" },
        limit:        { type: "number", description: "返回条数，默认 20，最大 100" },
      },
    },
  },
  {
    name: "query_invoices_in",
    description: "查询进项发票（供应商开来的发票，表 finance_invoices_in）。可按票号/销方名/合同号/报关单号搜索，按开票年月筛选。⚠️ 该表混有非发票行（银行流水 source=bank_statement、货代结算单 source=billing_statement），默认排除；include_non_invoice=true 时带上，行内 source 列标明来源。金额原样返回，不换算币种。",
    inputSchema: {
      type: "object",
      properties: {
        q:                   { type: "string",  description: "搜索关键词（票号/销方名/合同号/报关单号）" },
        year:                { type: "number",  description: "开票年份，如 2026" },
        month:               { type: "number",  description: "开票月份 1-12，可单独使用" },
        include_non_invoice: { type: "boolean", description: "true 时连银行流水/货代结算单等非发票行一起返回" },
        limit:               { type: "number",  description: "返回条数，默认 20，最大 100" },
      },
    },
  },
  {
    name: "query_customs_chain",
    description: "查一票货的报关链路：订单 ↔ 报关单（退税联权威视图 v_customs_spine） ↔ 提单。按合同号/订单号/提单号/报关单号任一关键词查，返回命中的报关单（出口日期/HS/品名/申报额等，按视图实际列）及按合同号关联的订单（订单号/客户/状态）和提单（BL号/船名/ETD）。一柜多票时视图里一张报关单只挂销售额最大的一票，订单侧按合同号全量返回。",
    inputSchema: {
      type: "object",
      properties: {
        q:     { type: "string", description: "合同号/订单号/提单号/报关单号关键词" },
        limit: { type: "number", description: "报关单返回条数，默认 20，最大 100" },
      },
    },
  },
  {
    name: "query_customs_docs",
    description: "查一票货已上传的报关资料文件清单（表 document_uploads）：文件名、单据类型、合同号、上传人、上传时间。只返回元数据，不含文件下载地址（文件链接走站内签名，不外放）。",
    inputSchema: {
      type: "object",
      properties: {
        q:        { type: "string", description: "关键词（合同号/订单号 doc_id/文件名）" },
        doc_type: { type: "string", description: "单据类型精确过滤，如 customs_decl" },
        limit:    { type: "number", description: "返回条数，默认 20，最大 100" },
      },
    },
  },
  {
    name: "get_stats",
    description: "获取 Sanlyn 业务看板摘要：本月退税金额、在途订单数、待处理 FE 数。",
    inputSchema: { type: "object", properties: {} },
  },
];

// 年月筛选：对 date/text 两种列类型都成立的写法（::text 后取前缀），参数化 $n
function pushYearMonth(col, args, vals, conds) {
  if (args.year) {
    vals.push(String(parseInt(args.year, 10)));
    conds.push(`SUBSTRING(${col}::text FROM 1 FOR 4)=$${vals.length}`);
  }
  if (args.month) {
    vals.push(String(parseInt(args.month, 10)).padStart(2, "0"));
    conds.push(`SUBSTRING(${col}::text FROM 6 FOR 2)=$${vals.length}`);
  }
}

async function handleTool(name, args, pool) {
  const lim = Math.min(args.limit || 20, 100);

  if (name === "query_rebates") {
    if (args.list_months) {
      const r = await pool.query(
        `SELECT DISTINCT TO_CHAR(export_date,'YYYY-MM') AS month, COUNT(*) AS cnt
         FROM finance_export_rebates GROUP BY 1 ORDER BY 1 DESC LIMIT 24`
      );
      return r.rows;
    }
    const where = [];
    const vals = [];
    if (args.year)  { vals.push(args.year);  where.push(`EXTRACT(YEAR  FROM export_date)=$${vals.length}`); }
    if (args.month) { vals.push(args.month); where.push(`EXTRACT(MONTH FROM export_date)=$${vals.length}`); }
    const sql = `SELECT customs_no, contract_no, export_date, fob_cny, rebate_rate,
                        rebate_expected, rebate_lifecycle_status, currency, note
                 FROM finance_export_rebates
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY export_date DESC LIMIT $${vals.length + 1}`;
    vals.push(lim);
    const r = await pool.query(sql, vals);
    return r.rows;
  }

  if (name === "query_orders") {
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      conds.push(`(o.order_no ILIKE $${vals.length} OR o.contract_no ILIKE $${vals.length} OR c.company_name ILIKE $${vals.length})`);
    }
    if (args.status) { vals.push(args.status); conds.push(`o.status=$${vals.length}`); }
    vals.push(lim);
    const r = await pool.query(
      `SELECT o.order_no, o.contract_no, o.status, o.total_qty, o.total_amount,
              o.created_at, COALESCE(c.name_cn, c.name, c.name_en) AS customer
       FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY o.created_at DESC LIMIT $${vals.length}`,
      vals
    );
    return r.rows;
  }

  if (name === "query_shipping") {
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      conds.push(`(sp.bl_no ILIKE $1 OR sp.vessel ILIKE $1 OR sp.so_no ILIKE $1)`);
    }
    if (args.status) { vals.push(args.status); conds.push(`sp.status=$${vals.length}`); }
    vals.push(lim);
    const r = await pool.query(
      `SELECT sp.id, sp.bl_no, sp.vessel, sp.voyage, sp.etd, sp.eta,
              sp.pol, sp.pod, sp.status, sp.so_no
       FROM shipping_plans sp
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY sp.etd DESC NULLS LAST LIMIT $${vals.length}`,
      vals
    );
    return r.rows;
  }

  if (name === "query_fe_certs") {
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      conds.push(`(ec.cert_no ILIKE $1 OR ec.bl_no ILIKE $1 OR ec.contract_no ILIKE $1)`);
    }
    if (args.status) { vals.push(args.status); conds.push(`ec.status=$${vals.length}`); }
    vals.push(lim);
    const r = await pool.query(
      `SELECT ec.id, ec.cert_no, ec.cert_type, ec.contract_no, ec.bl_no,
              ec.status, ec.created_at, ec.raw
       FROM export_certs ec
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY ec.created_at DESC LIMIT $${vals.length}`,
      vals
    );
    return r.rows;
  }

  if (name === "query_customs") {
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      conds.push(`(entry_id ILIKE $1 OR contract_no ILIKE $1 OR declaration_name ILIKE $1)`);
    }
    vals.push(lim);
    const r = await pool.query(
      `SELECT entry_id, contract_no, declaration_name, hs_code, tax_rebate_rate,
              total_amount, export_date, status
       FROM customs_declarations
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY export_date DESC NULLS LAST LIMIT $${vals.length}`,
      vals
    );
    return r.rows;
  }

  if (name === "query_invoices_out") {
    // 列名依据：api/db/invoice-records.js 的 FIELDS/EDIT_FIELDS（销进两表共用字段表，线上在跑）
    // + ybb-recon/freight-recon/collab-contacts-vendor 对 invoice_no/issue_date/seller_name/
    // amount_incl_tax/currency/contract_nos(数组列) 的非防御查询。未连库逐列复核。
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      const n = vals.length;
      conds.push(`(invoice_no ILIKE $${n} OR buyer_name ILIKE $${n} OR contract_nos::text ILIKE $${n})`);
    }
    if (args.invoice_type) { vals.push(args.invoice_type); conds.push(`invoice_type=$${vals.length}`); }
    pushYearMonth("issue_date", args, vals, conds);
    vals.push(lim);
    const sql = `SELECT invoice_no, invoice_type, issue_date, seller_name, seller_tax_id,
              buyer_name, buyer_tax_id, amount_ex_tax, total_tax, amount_incl_tax,
              tax_rate, currency, contract_nos, customs_nos,
              review_status, void_status, source, created_at
       FROM finance_invoices_out
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY issue_date DESC NULLS LAST, id DESC LIMIT $${vals.length}`;
    const r = await pool.query(sql, vals);
    return r.rows;
  }

  if (name === "query_invoices_in") {
    // 列名依据：handoff/cols-ours.txt 生产库列快照（52 列）+ invoice-records.js FIELDS。
    // ⚠️ source 的非发票取值（bank_statement/billing_statement）按需求指定，仓内代码无字面量，
    //    实际取值清单列名待 Claude 连库核。
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      const n = vals.length;
      conds.push(`(invoice_no ILIKE $${n} OR seller_name ILIKE $${n} OR contract_nos::text ILIKE $${n} OR customs_nos::text ILIKE $${n})`);
    }
    pushYearMonth("issue_date", args, vals, conds);
    if (args.include_non_invoice !== true) {
      conds.push(`COALESCE(source,'') NOT IN ('bank_statement','billing_statement')`);
    }
    vals.push(lim);
    const sql = `SELECT invoice_no, invoice_type, issue_date, seller_name, seller_tax_id,
              buyer_name, amount_ex_tax, total_tax, amount_incl_tax, tax_rate,
              currency, contract_nos, customs_nos, deduct_status, auth_status,
              void_status, review_status, source, received_date, created_at
       FROM finance_invoices_in
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY issue_date DESC NULLS LAST, id DESC LIMIT $${vals.length}`;
    const r = await pool.query(sql, vals);
    return r.rows;
  }

  if (name === "query_customs_chain") {
    // v_customs_spine 两仓均无 DDL；存在性与底表字段（finance_rebate_ckts_lines：customs_no/
    // contract_no/export_date/hs_code/goods_name/deal_amount/currency/amount_cny/usd_fob）
    // 依据记忆库 project_staging_link_layer_built_0913。视图输出列名未连库核 → SELECT *
    // 原样返回，WHERE 只用已确证的 customs_no/contract_no。
    // ⚠️ 视图的「票/工厂/提单号」列被 DISTINCT ON(customs_no) 削成每报关单一票，
    //    订单/提单侧不信视图，按 contract_no 另查 orders/shipping_plans（列均现役已用）。
    const like = args.q ? `%${args.q}%` : null;
    const sqlCustoms = `SELECT * FROM v_customs_spine
       ${like ? `WHERE "报关单号" ILIKE $1 OR "合同号" ILIKE $1 OR "提单号" ILIKE $1
             OR "合同号" IN (
               SELECT contract_no FROM orders
                WHERE order_no ILIKE $1 AND COALESCE(contract_no,'') <> ''
               UNION
               SELECT contract_no FROM shipping_plans
                WHERE bl_no ILIKE $1 AND COALESCE(contract_no,'') <> ''
             )` : ""}
       ORDER BY "出口日" DESC NULLS LAST
       LIMIT $${like ? 2 : 1}`;
    const customs = await pool.query(sqlCustoms, like ? [like, lim] : [lim]);

    const contracts = customs.rows.map((r) => r["合同号"]).filter(Boolean);
    if (like) {
      const sqlDirect = `SELECT DISTINCT contract_no FROM (
           SELECT contract_no FROM orders
            WHERE (order_no ILIKE $1 OR contract_no ILIKE $1) AND COALESCE(contract_no,'') <> ''
           UNION ALL
           SELECT contract_no FROM shipping_plans
            WHERE (bl_no ILIKE $1 OR contract_no ILIKE $1) AND COALESCE(contract_no,'') <> ''
         ) t LIMIT 100`;
      const direct = await pool.query(sqlDirect, [like]);
      direct.rows.forEach((r) => r.contract_no && contracts.push(r.contract_no));
    }
    const uniq = [...new Set(contracts)];

    let orders = [];
    if (uniq.length) {
      const sqlOrders = `SELECT o.contract_no, o.order_no, o.status AS order_status, COALESCE(c.name_cn, c.name, c.name_en) AS customer,
                sp.bl_no, sp.vessel, sp.etd, sp.pod
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN shipping_plans sp ON sp.contract_no = o.contract_no
         WHERE o.contract_no = ANY($1::text[])
         ORDER BY o.created_at DESC LIMIT 200`;
      const o = await pool.query(sqlOrders, [uniq]);
      orders = o.rows;
    }
    return { matched_contracts: uniq, customs: customs.rows, orders };
  }

  if (name === "query_customs_docs") {
    // 列名依据：api/db/doc-uploads.js 与 api/db/shipping-transfer-gen.js 两处相同 DDL；
    // customs-doc-upload.js 实插 doc_type='customs_decl'、doc_id=订单号、contract_no 由 orders 解析。
    // ⛔ 只返回元数据，不返回 url（文件链接走站内签名，不外放）。
    const vals = [];
    const conds = [];
    if (args.q) {
      vals.push(`%${args.q}%`);
      const n = vals.length;
      conds.push(`(contract_no ILIKE $${n} OR bl_no ILIKE $${n} OR doc_id ILIKE $${n} OR name ILIKE $${n})`);
    }
    if (args.doc_type) { vals.push(args.doc_type); conds.push(`doc_type=$${vals.length}`); }
    vals.push(lim);
    const sql = `SELECT id, doc_id, doc_type, contract_no, bl_no, name, size, note, uploader, uploaded_at
       FROM document_uploads
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY uploaded_at DESC NULLS LAST LIMIT $${vals.length}`;
    const r = await pool.query(sql, vals);
    return r.rows;
  }

  if (name === "get_stats") {
    const pool2 = getPool();
    const [rebate, orders, fe] = await Promise.all([
      pool2.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(rebate_expected),0) AS total
                   FROM finance_export_rebates
                   WHERE EXTRACT(YEAR FROM export_date)=EXTRACT(YEAR FROM NOW())
                     AND EXTRACT(MONTH FROM export_date)=EXTRACT(MONTH FROM NOW())`),
      pool2.query(`SELECT COUNT(*) AS cnt FROM orders WHERE status NOT IN ('completed','cancelled')`),
      pool2.query(`SELECT COUNT(*) AS cnt FROM export_certs WHERE status IN ('pending','暂存')`),
    ]);
    return {
      this_month_rebates: { count: rebate.rows[0].cnt, total_cny: rebate.rows[0].total },
      active_orders: orders.rows[0].cnt,
      pending_fe: fe.rows[0].cnt,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function jsonrpc(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function jsonrpcErr(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-mcp-key, authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Auth
  const key = req.headers["x-mcp-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!MCP_SECRET || key !== MCP_SECRET) return res.status(401).json({ error: "invalid mcp key" });

  const { method, params, id } = req.body || {};

  try {
    if (method === "initialize") {
      return res.json(jsonrpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      }));
    }

    if (method === "tools/list") {
      return res.json(jsonrpc(id, { tools: TOOLS }));
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      const pool = getPool();
      const data = await handleTool(name, args, pool);
      return res.json(jsonrpc(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: false,
      }));
    }

    return res.json(jsonrpcErr(id, -32601, `Method not found: ${method}`));
  } catch (err) {
    console.error("[mcp]", err.message);
    return res.json(jsonrpcErr(id, -32603, err.message));
  }
}
