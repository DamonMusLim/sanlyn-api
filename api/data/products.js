import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setCors } from "../db.js";

var cached = null;

export default function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (!cached) {
      var dir = dirname(fileURLToPath(import.meta.url));
      var file = join(dir, "../../data/products.json");
      cached = readFileSync(file, "utf-8");
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).send(cached);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
