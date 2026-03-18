import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { contract_no, limit = 500 } = req.query;

    // 始终从OSS读取（最新数据）
    const ossRes = await fetch("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/documents.json");
    const ossRaw = await ossRes.json();
    const ossDocs = Array.isArray(ossRaw) ? ossRaw : (ossRaw.documents || ossRaw.data || []);

    // 按contract_no过滤
    const filtered = contract_no
      ? ossDocs.filter(d => d.contractNo === contract_no || d.orderNo === contract_no)
      : ossDocs.slice(0, parseInt(limit));

    return res.status(200).json({ success: true, data: filtered, count: filtered.length, source: "oss" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
