// luvsome-gateway auth adapter for pet-slip routes.
// Mirrors admin.js's own model (X-Admin-Token header === env ADMIN_TOKEN),
// NOT sanlyn-api's JWT system — the two apps have separate login/identity stacks.
export function requireAuth(req, res) {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: "admin_disabled", message: "ADMIN_TOKEN 未配置" });
    return false;
  }
  if (req.get("x-admin-token") !== ADMIN_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
