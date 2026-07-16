// /api/db/share-link.js - admin-only read-only share URL token issuer.
import { getPool, setCors } from "../db.js";
import { extractUser, generateToken } from "../auth.js";

const KIND_TO_ROLE = {
  customers: "customer",
  factories: "factory",
  suppliers: "supplier",
};

const PAGE_PATHS = {
  customer: {
    stock: "/public/templates/product-stock.html?token=",
    orders: "/public/templates/customer-portal.html?token=",
    "sku-recon": "/public/templates/sku-recon.html?token=",
    "collection": "/public/templates/customer-collection.html?token=",
  },
  factory: {
    "factory-bags": "/public/templates/factory-bags.html?token=",
    "sku-recon": "/public/templates/sku-recon.html?token=",
    "stocktake": "/public/templates/factory-stocktake.html?token=",
  },
  supplier: {
    "supplier-catalog": "/public/templates/supplier-catalog.html?token=",
  },
};

function json(res, status, body) {
  return res.status(status).json({
    success: !!body.success,
    data: body.data ?? null,
    error: body.error ?? null,
  });
}

function companyCodes(row) {
  if (Array.isArray(row.company_codes) && row.company_codes.length) return row.company_codes;
  if (typeof row.company_codes === "string") {
    try {
      const parsed = JSON.parse(row.company_codes);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
  }
  return row.company_code ? [row.company_code] : [];
}

function defaultPageFor(role) {
  if (role === "factory") return "factory-bags";
  if (role === "supplier") return "supplier-catalog";
  return "stock";
}

function genCode() {
  const cs = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 8; i++) c += cs[Math.floor(Math.random() * cs.length)];
  return c;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!req.user) extractUser(req);
  if (!req.user || req.user.role !== "admin") {
    return json(res, 403, { success: false, error: "Forbidden: admin only" });
  }

  const pool = getPool();

  try {
    if (req.method === "GET") {
      const role = KIND_TO_ROLE[String(req.query?.kind || "")];
      if (!role) return json(res, 400, { success: false, error: "kind must be customers or factories" });

      const r = await pool.query(
        `SELECT id, username, company_code, company
           FROM accounts
          WHERE role = $1
            AND COALESCE(is_active, true) = true
          ORDER BY company NULLS LAST, username`,
        [role]
      );
      return json(res, 200, { success: true, data: r.rows });
    }

    if (req.method !== "POST") {
      return json(res, 405, { success: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const id = body.id;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    if (!id && !username) return json(res, 400, { success: false, error: "username or id required" });

    const params = [];
    const where = [];
    if (id) {
      params.push(id);
      where.push(`id::text = $${params.length}::text`);
    }
    if (username) {
      params.push(username);
      where.push(`username = $${params.length}`);
    }

    const r = await pool.query(
      `SELECT id, username, role, company, company_code, company_codes, token_version
         FROM accounts
        WHERE (${where.join(" OR ")})
          AND role IN ('customer', 'factory', 'supplier')
          AND COALESCE(is_active, true) = true
        LIMIT 1`,
      params
    );
    const u = r.rows[0];
    if (!u) return json(res, 404, { success: false, error: "Account not found" });

    const requestedPage = typeof body.page === "string" && body.page ? body.page : defaultPageFor(u.role);
    const prefix = PAGE_PATHS[u.role]?.[requestedPage];
    if (!prefix) return json(res, 400, { success: false, error: "Invalid page for account role" });

    const token = generateToken({
      uid: u.id,
      username: u.username,
      role: u.role,
      company: u.company,
      companyCode: u.company_code,
      companyCodes: companyCodes(u),
      tv: u.token_version || 1,
    });

    // 生成短码入库(对外分享=短码,不塞JWT)
    let code = "";
    const expIso = new Date(Date.now() + 7 * 864e5).toISOString();
    for (let i = 0; i < 6; i++) {
      const c = genCode();
      try {
        await pool.query(
          `INSERT INTO share_links(code, account_id, page, path, created_by, expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [c, u.id, requestedPage, prefix, req.user?.username || "admin", expIso]
        );
        code = c;
        break;
      } catch (e) { /* 撞码重试 */ }
    }
    const host = req.headers.host || "ai.sanlyn.cn";
    const short_url = code ? `https://${host}/v/${code}` : "";

    return json(res, 200, {
      success: true,
      data: { code, short_url, path: prefix + token, expires_days: 7 },
    });
  } catch (err) {
    console.error("[share-link]", err);
    return json(res, 500, { success: false, error: err.message });
  }
}
