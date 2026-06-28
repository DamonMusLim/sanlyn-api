// /api/db/migrate-countries.mjs — Create countries table + seed 16 countries
import { getPool } from "./db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS countries (
        code        text PRIMARY KEY,
        code3       text,
        name_en     text NOT NULL,
        name_cn     text,
        currency    text,
        region      text,
        flag_emoji  text,
        sanlyn_market boolean DEFAULT false,
        notes       text,
        created_at  timestamp DEFAULT now()
      );
    `);

    const SEED = [
      ["MY","MYS","Malaysia",   "马来西亚","MYR","ASEAN",        "🇲🇾",true],
      ["CN","CHN","China",      "中国",    "CNY","GreaterChina","🇨🇳",true],
      ["HK","HKG","Hong Kong",  "香港",    "HKD","GreaterChina","🇭🇰",true],
      ["SG","SGP","Singapore",  "新加坡",  "SGD","ASEAN",        "🇸🇬",true],
      ["TH","THA","Thailand",   "泰国",    "THB","ASEAN",        "🇹🇭",false],
      ["VN","VNM","Vietnam",    "越南",    "VND","ASEAN",        "🇻🇳",false],
      ["ID","IDN","Indonesia",  "印尼",    "IDR","ASEAN",        "🇮🇩",false],
      ["PH","PHL","Philippines","菲律宾",  "PHP","ASEAN",        "🇵🇭",false],
      ["TW","TWN","Taiwan",     "台湾",    "TWD","GreaterChina","🇹🇼",false],
      ["JP","JPN","Japan",      "日本",    "JPY","EastAsia",    "🇯🇵",false],
      ["KR","KOR","Korea",      "韩国",    "KRW","EastAsia",    "🇰🇷",false],
      ["AU","AUS","Australia",  "澳大利亚","AUD","Oceania",     "🇦🇺",false],
      ["NZ","NZL","New Zealand","新西兰",  "NZD","Oceania",     "🇳🇿",false],
      ["US","USA","USA",        "美国",    "USD","NorthAmerica","🇺🇸",false],
      ["GB","GBR","UK",         "英国",    "GBP","Europe",      "🇬🇧",false],
      ["DE","DEU","Germany",    "德国",    "EUR","Europe",      "🇩🇪",false],
    ];

    let seeded = 0;
    for (const row of SEED) {
      const r = await pool.query(
        `INSERT INTO countries(code,code3,name_en,name_cn,currency,region,flag_emoji,sanlyn_market)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(code) DO NOTHING`,
        row
      );
      seeded += r.rowCount;
    }
    return res.json({ success: true, message: `countries table ready, ${seeded} rows seeded` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
