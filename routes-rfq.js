export function registerRfqPublicRoutes(app, mount) {
  mount("/api/db/rfq-fill", () => import("./api/db/rfq-fill.js"));
  app.get("/rfq/:token", (req, res) => {
    res.redirect("/public/rfq-fill.html?token=" + encodeURIComponent(req.params.token));
  });
}

export function registerRfqRoutes(app, mount) {
  mount("/api/db/rfq/:id/quotes", () => import("./api/db/rfq.js"));
  mount("/api/db/rfq/:id/invite", () => import("./api/db/rfq.js"));
  mount("/api/db/rfq/:id/convert", () => import("./api/db/rfq.js"));
  mount("/api/db/rfq/:id", () => import("./api/db/rfq.js"));
  mount("/api/db/rfq", () => import("./api/db/rfq.js"));
}
