// api/db/products.js — S71 产品数据API
// 部署到 sanlyn-api (Vercel)

const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_HOST,
      port: 5432,
      database: process.env.PG_DATABASE || 'sanlyn_db',
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      ssl: false,
      max: 5,
    });
  }
  return pool;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const p = getPool();
    const { brand, category, search, limit } = req.query;
    
    let sql = 'SELECT * FROM products';
    const conditions = [];
    const params = [];
    let idx = 1;

    if (brand) {
      conditions.push(`(brand = $${idx} OR raw->>'brand' = $${idx} OR raw->>'_widget_1755320381921' = $${idx})`);
      params.push(brand);
      idx++;
    }
    if (category) {
      conditions.push(`(category = $${idx} OR raw->>'category' = $${idx} OR raw->>'_widget_1759256456320' = $${idx})`);
      params.push(category);
      idx++;
    }
    if (search) {
      const q = `%${search}%`;
      conditions.push(`(
        sku ILIKE $${idx} OR product_name ILIKE $${idx} OR product_name_cn ILIKE $${idx}
        OR raw->>'_widget_1755320381920' ILIKE $${idx}
        OR raw->>'_widget_1755320381922' ILIKE $${idx}
        OR raw->>'_widget_1764952417030' ILIKE $${idx}
      )`);
      params.push(q);
      idx++;
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY id DESC';

    if (limit) {
      sql += ` LIMIT $${idx}`;
      params.push(parseInt(limit));
    }

    const result = await p.query(sql, params);
    res.status(200).json({ data: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('Products API error:', err);
    res.status(500).json({ error: err.message });
  }
};
