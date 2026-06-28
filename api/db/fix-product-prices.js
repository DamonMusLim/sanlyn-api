// /api/db/fix-product-prices.js — Fix product prices in OSS products.json
// Reads from OSS, patches specific products, writes back to OSS
import OSS from "ali-oss";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const client = new OSS({
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
    });

    // 1. Read current products.json from OSS
    const result = await client.get("data/products.json");
    const products = JSON.parse(result.content.toString());

    // 2. Price fixes: code -> new price
    const fixes = {
      "9551014016989": 15.44,  // PET'S ACADEMY LAVENDER 1.3KG - was 1.28 (per bag), should be 15.44 (per CTN)
      "9551014016972": 15.44,  // PET'S ACADEMY COFFEE 1.3KG
      "9551014016996": 15.44,  // PET'S ACADEMY LEMON 1.3KG
    };

    const changes = [];
    for (const p of products) {
      if (fixes[p.code] !== undefined) {
        const oldPrice = p.price;
        p.price = fixes[p.code];
        changes.push({ code: p.code, name: p.name, oldPrice, newPrice: p.price });
      }
    }

    // 3. Write back to OSS
    const json = JSON.stringify(products, null, 1);
    await client.put("data/products.json", Buffer.from(json), {
      mime: "application/json",
      headers: { "Cache-Control": "public, max-age=60" },
    });

    return res.status(200).json({
      success: true,
      changes,
      totalProducts: products.length,
      ossSize: json.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
