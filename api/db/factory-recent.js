// /api/db/factory-recent.js — 当前客户最近用过的工厂（for Forward to Factory 选择器）
//
// GET /api/db/factory-recent?companyCode=XXX   (auth: customer/admin/sales/logistics)
// 返回：此客户（或所属集团）最近出现过的工厂 company_code（从 orders.raw.factoryCompanyCode 汇总）
// 附上 customers 表的 name_cn / email 作为预填值。
//
// 数据结构：[
//   { companyCode, nameCN, nameEN, email, contact, phone, lastUsedAt, orderCount }
// ]

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const isInternal = ["admin", "sales", "logistics"].includes(req.user.role);
  const isCustomer = req.user.role === "customer";
  if (!isInternal && !isCustomer) return res.status(403).json({ error: "Forbidden" });

  const queryCode = (req.query?.companyCode || "").trim();
  const userCodes = Array.isArray(req.user.companyCodes) ? req.user.companyCodes
                  : (req.user.companyCode ? [req.user.companyCode] : []);

  // Customer 只能查自己
  let targetCodes;
  if (isCustomer) {
    if (queryCode && !userCodes.includes(queryCode)) {
      return res.status(403).json({ error: "Forbidden: not your company" });
    }
    targetCodes = queryCode ? [queryCode] : userCodes;
  } else {
    targetCodes = queryCode ? [queryCode] : userCodes;
  }
  if (!targetCodes || targetCodes.length === 0) {
    return res.status(200).json({ success: true, factories: [] });
  }

  try {
    const pool = getPool();

    // 从 orders.raw.factoryCompanyCode 汇总最近 90 天此客户用过的工厂
    const { rows } = await pool.query(
      `SELECT raw->>'factoryCompanyCode' AS factory_code,
              MAX(updated_at)             AS last_used,
              COUNT(*)                    AS order_count
         FROM orders
        WHERE company_code = ANY($1)
          AND raw->>'factoryCompanyCode' IS NOT NULL
          AND raw->>'factoryCompanyCode' <> ''
          AND updated_at > NOW() - INTERVAL '180 days'
        GROUP BY raw->>'factoryCompanyCode'
        ORDER BY MAX(updated_at) DESC
        LIMIT 20`,
      [targetCodes]
    );

    if (rows.length === 0) {
      return res.status(200).json({ success: true, factories: [] });
    }

    const codes = rows.map(r => r.factory_code);
    const { rows: facs } = await pool.query(
      `SELECT company_code, name_cn, name_en, raw
         FROM customers
        WHERE company_code = ANY($1)`,
      [codes]
    );

    const facMap = {};
    for (const f of facs) {
      const raw = f.raw || {};
      const invoice = raw.invoice || {};
      facMap[f.company_code] = {
        companyCode: f.company_code,
        nameCN:      f.name_cn || raw.nameCN || "",
        nameEN:      f.name_en || raw.nameEN || "",
        email:       raw.contactEmail || raw.email || invoice.email || "",
        contact:     raw.contactName  || raw.contact || "",
        phone:       raw.contactPhone || raw.phone   || "",
      };
    }

    const factories = rows
      .map(r => {
        const f = facMap[r.factory_code];
        if (!f) return null;
        return { ...f, lastUsedAt: r.last_used, orderCount: Number(r.order_count) };
      })
      .filter(Boolean);

    return res.status(200).json({ success: true, factories });
  } catch (err) {
    console.error("[factory-recent]", err);
    return res.status(500).json({ error: err.message });
  }
}
