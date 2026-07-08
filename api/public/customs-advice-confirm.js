import { getPool, setCors } from "../db.js";

function tokenFromUrl(req) {
  return decodeURIComponent((req.url || "").split("?")[0].split("/").filter(Boolean).pop() || "");
}

function optionCodes(options) {
  return Array.isArray(options) ? options.map(o => String(o?.option || "").trim()).filter(Boolean) : [];
}

function publicPayload(row) {
  return {
    success: true,
    company_name: row.company_name || row.company_code,
    company_code: row.company_code,
    advice_no: row.advice_no,
    options: row.options,
    recommended: row.recommended,
    status: row.status,
    chosen: row.chosen,
    confirmed_at: row.confirmed_at,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.end();
  res.setHeader("Content-Type", "application/json");

  const token = tokenFromUrl(req);
  if (!token) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Invalid token" }));
  }

  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT ca.id, ca.advice_no, ca.company_code, ca.options, ca.recommended,
           ca.status, ca.chosen, ca.token_expires, ca.confirmed_at,
           COALESCE(NULLIF(c.name_cn, ''), NULLIF(c.name_en, ''), ca.company_code) AS company_name
    FROM customs_advice ca
    LEFT JOIN companies c ON c.code = ca.company_code
    WHERE ca.confirm_token = $1
  `, [token]);

  if (!rows.length) {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  const advice = rows[0];
  if (advice.token_expires && new Date(advice.token_expires) < new Date()) {
    res.writeHead(410);
    return res.end(JSON.stringify({ error: "expired", message: "链接已过期" }));
  }

  if (req.method === "GET") {
    return res.end(JSON.stringify(publicPayload(advice)));
  }

  if (req.method === "POST") {
    if (advice.status === "confirmed") {
      res.writeHead(409);
      return res.end(JSON.stringify({ error: "Already confirmed" }));
    }
    if (!["draft", "sent"].includes(advice.status)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Advice is not confirmable" }));
    }

    const { chosen, risk_ack } = req.body || {};
    if (!optionCodes(advice.options).includes(String(chosen || "").trim())) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "chosen must match an option" }));
    }
    if (risk_ack !== true) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "risk_ack must be true" }));
    }

    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "";
    const ua = req.headers["user-agent"] || "";
    const meta = { ip, ua, method: "link" };
    const r = await pool.query(`
      UPDATE customs_advice
      SET chosen = $1,
          confirmed_at = now(),
          confirm_meta = $2,
          risk_ack = true,
          status = 'confirmed',
          updated_at = now()
      WHERE id = $3 AND status IN ('draft', 'sent') AND chosen IS NULL
      RETURNING confirmed_at, chosen, status
    `, [chosen, JSON.stringify(meta), advice.id]);

    if (!r.rowCount) {
      res.writeHead(409);
      return res.end(JSON.stringify({ error: "Already confirmed" }));
    }
    return res.end(JSON.stringify({ success: true, data: r.rows[0] }));
  }

  res.writeHead(405);
  return res.end(JSON.stringify({ error: "Method not allowed" }));
}

