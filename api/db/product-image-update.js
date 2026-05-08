// api/db/product-image-update.js
// POST { id, image_url, type? }
// Updates products.image_url and appends to products.images JSONB array
// Auth: any authenticated user (factory or admin)

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const { id, image_url, type = "raw" } = req.body || {};
  if (!id || !image_url) {
    return res.status(400).json({ success: false, error: "id and image_url are required" });
  }

  try {
    const pool = getPool();

    // Append new entry to images JSONB array, avoid duplicates by url
    const newEntry = JSON.stringify({ type, url: image_url, created_at: new Date().toISOString() });

    const result = await pool.query(
      `UPDATE products
       SET image_url = $1,
           images    = COALESCE(
             (SELECT jsonb_agg(e) FROM jsonb_array_elements(COALESCE(images, '[]'::jsonb)) e
              WHERE e->>'url' != $1),
             '[]'::jsonb
           ) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, sku, product_name, image_url, images`,
      [image_url, newEntry, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("[product-image-update]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
