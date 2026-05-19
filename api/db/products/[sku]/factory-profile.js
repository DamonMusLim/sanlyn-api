// api/db/products/[sku]/factory-profile.js — Vercel file-based parametric route
//
// Thin re-export so PATCH /api/db/products/:sku/factory-profile works under
// Vercel's file-based routing (which doesn't pick up Express mount() calls in
// server.js). Production runs Express via pm2; this file is for vercel dev /
// preview deployments. Same handler — SKU is read from req.query.sku populated
// by Vercel's `[sku]` placeholder.

export { default } from "../../product-factory-profile.js";
