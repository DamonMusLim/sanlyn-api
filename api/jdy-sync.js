import { setCors } from "./db.js";

const CN_WIDGET    = "_widget_1766730818801";
const BL_NO_WIDGET = "_widget_1773596720903";
const DOCS_ENTRY   = "691e76b3cb637ee7ef1f25ca";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-sync" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) return res.status(200).json({ ok: true });

    const entryId = body.data?.entryId || body.entryId || "";
    if (entryId !== DOCS_ENTRY && entryId !== "") {
      return res.status(200).json({ ok: true, skip: "unknown entryId", entryId });
    }

    // 转发到docs-sync处理
    const row = body.data || body;
    const contractNo = row[CN_WIDGET] || "";
    const docsRes = await fetch("https://sanlyn-api.vercel.app/api/jdy/docs-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: row, contractNo })
    });
    const result = await docsRes.json();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
