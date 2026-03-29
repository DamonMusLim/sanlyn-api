// api/db/company.js — 查询公司开票资料（从JDY公司表实时查）
import { setCors } from "../db.js";

const JDY_API = "https://api.jiandaoyun.com/api/v5/app/entry/data/list";
const JDY_TOKEN = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const APP_ID = "689cb08a93c073210bfc772b";
const ENTRY_ID = "692a7c7d85918bdb075ee048"; // 公司表

// Widget ID mapping
const W = {
  nameCN: "_widget_1764392061244",
  nameEN: "_widget_1764392061245",
  taxNo: "_widget_1764392061247",
  addressCN: "_widget_1764392061249",
  addressEN: "_widget_1764394732272",
  contact: "_widget_1764392061252",
  phone: "_widget_1764392061253",
  bankSummary: "_widget_1767603195725",
  accountSummary: "_widget_1767603195726",
  bankSub: "_widget_1764393728384",
  companyCode: "_widget_1764478692414",
  shortName: "_widget_1764392061246",
};

function extractBanks(sub) {
  if (!Array.isArray(sub)) return [];
  return sub.map(b => ({
    currency: b._widget_1764393728388 || "",
    bankShort: b._widget_1764393728390 || "",
    bankFull: b._widget_1771863264587 || b._widget_1764393728390 || "",
    bankEN: b._widget_1764393728391 || "",
    account: b._widget_1764393728392 || "",
    swift: b._widget_1764393728393 || "",
    bankAddress: b._widget_1764393728398 || "",
  })).filter(b => b.account);
}

function normalize(r) {
  return {
    nameCN: r[W.nameCN] || "",
    nameEN: r[W.nameEN] || "",
    taxNo: r[W.taxNo] || "",
    addressCN: r[W.addressCN] || "",
    addressEN: r[W.addressEN] || "",
    contact: r[W.contact] || "",
    phone: r[W.phone] || "",
    shortName: r[W.shortName] || "",
    companyCode: r[W.companyCode] || "",
    bankSummary: r[W.bankSummary] || "",
    accountSummary: r[W.accountSummary] || "",
    banks: extractBanks(r[W.bankSub]),
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { name, code, currency } = req.query || {};

  try {
    // Fetch all companies from JDY (cached in future)
    const resp = await fetch(JDY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + JDY_TOKEN },
      body: JSON.stringify({ app_id: APP_ID, entry_id: ENTRY_ID, limit: 100 }),
    });
    const data = await resp.json();
    const all = (data.data || []).map(normalize);

    // Filter by name (fuzzy match)
    if (name) {
      const q = name.trim();
      const matched = all.find(c =>
        c.nameCN === q || c.nameEN === q || c.shortName === q ||
        c.nameCN.includes(q) || (c.nameEN && c.nameEN.toLowerCase().includes(q.toLowerCase()))
      );
      if (!matched) return res.status(404).json({ error: "Company not found", query: q });

      // If currency specified, filter banks
      if (currency) {
        const cur = currency.toUpperCase();
        const bank = matched.banks.find(b => b.currency === cur);
        return res.status(200).json({ ...matched, bank: bank || null });
      }
      return res.status(200).json(matched);
    }

    // Filter by code
    if (code) {
      const matched = all.find(c => c.companyCode === code);
      if (!matched) return res.status(404).json({ error: "Company not found", code });
      return res.status(200).json(matched);
    }

    // Return all
    return res.status(200).json({ data: all, total: all.length });
  } catch (err) {
    console.error("[company]", err);
    return res.status(500).json({ error: err.message });
  }
}
