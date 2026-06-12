// api/external/me.js — Returns party info for this token
// GET /api/external/me  (token via X-External-Token header)
import { externalAuth } from "./middleware.js";

async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const e = req.external;
  return res.status(200).json({
    success: true,
    me: {
      party_type:    e.party_type,
      company_id:    e.company_id,
      company_name:  e.company_name,
      company_code:  e.company_code,
      contact_name:  e.contact_name,
    },
  });
}

export default async function (req, res) {
  await externalAuth(req, res, () => handler(req, res));
}
