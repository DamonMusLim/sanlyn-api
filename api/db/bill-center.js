import { setCors } from "../db.js";
import { getSummary, getCompany, getOrder } from "./bill-center-queries.js";
import { markPayment } from "./bill-center-payment.js";
import { getEstimates } from "./bill-center-estimates.js";
import { createCollabToken } from "./bill-center-collab-token.js";
import { validateCollab, submitCollab, reviewCollab } from "./bill-center-collab.js";

function suffix(req) {
  return String(req.path || "").replace(/^\/api\/db\/bill-center\/?/, "").replace(/^\/+/, "");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const path = suffix(req) || String(req.query.action || "");

  try {
    if (req.method === "GET" && path === "summary") return getSummary(req, res);
    if (req.method === "GET" && path === "company") return getCompany(req, res);
    if (req.method === "GET" && path === "order") return getOrder(req, res);
    if (req.method === "GET" && path === "estimates") return getEstimates(req, res);
    if (req.method === "POST" && path === "payment") return markPayment(req, res);
    if (req.method === "PATCH" && path === "payment") return markPayment(req, res);
    if (req.method === "POST" && path === "collab-token") return createCollabToken(req, res);
    if (req.method === "GET" && path === "collab/validate") return validateCollab(req, res);
    if (req.method === "POST" && path === "collab/submit") return submitCollab(req, res);
    if (req.method === "POST" && path === "collab/review") return reviewCollab(req, res);
    return res.status(404).json({ success: false, error: "not_found" });
  } catch (err) {
    console.error("[bill-center]", err);
    return res.status(500).json({ success: false, error: "internal_error", message: err.message });
  }
}
