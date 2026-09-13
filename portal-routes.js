export function mountPortalRoutes(mount) {
  mount("/api/portal/login",     () => import("./api/portal/login.js"));
  mount("/api/portal/shipping",  () => import("./api/portal/shipping.js"));
  mount("/api/portal/documents", () => import("./api/portal/documents.js"));
  mount("/api/portal/missing",   () => import("./api/portal/missing.js"));
  mount("/api/portal/orders",    () => import("./api/portal/orders.js"));
  mount("/api/portal/logout",    () => import("./api/portal/logout.js"));
}
