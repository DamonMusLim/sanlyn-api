import { requireAuth } from "../auth.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);

export function requireFinance(req, res) {
  if (!requireAuth(req, res)) return false;
  if (!FINANCE_ROLES.has(req.user?.role)) {
    res.status(403).json({ success: false, error: "forbidden", message: "admin/finance only" });
    return false;
  }
  return true;
}

export function actor(req) {
  return req.user?.username || req.user?.email || req.user?.uid || req.user?.id || "system";
}

export function bad(res, status, error, message) {
  return res.status(status).json({ success: false, error, message });
}
