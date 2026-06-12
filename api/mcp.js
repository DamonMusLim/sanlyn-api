// api/mcp.js — Sanlyn MCP Server (streamable-HTTP, MCP 2024-11-05)
// WorkBuddy connects here as a connector: https://ai.sanlyn.cn/api/mcp
// Auth: x-mcp-key header = MCP_SECRET env var
import { getPool } from "./db.js";

const MCP_SECRET = process.env.MCP_SECRET || "sanlyn-mcp-2026";
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
    name: "get_stats",
    description: "获取 Sanlyn 业务看板摘要：本月退税金额、在途订单数、待处理 FE 数。",
    inputSchema: { type: "object", properties: {} },
  },
];

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
              o.created_at, c.company_name AS customer
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
  if (key !== MCP_SECRET) return res.status(401).json({ error: "invalid mcp key" });

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
