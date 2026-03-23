/**
 * GET /api/db/freight-quotes
 * 从JDY货代报价表读取有效运价
 * entry ID: 692d71da9e9f7fc0d52611a9
 */
import { getPool, setCors } from "./db.js";

const JDY_TOKEN  = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP_ID = "689cb08a93c073210bfc772b";
const JDY_ENTRY  = "692d71da9e9f7fc0d52611a9";

const W = {
  carrier:    "_widget_1765191135618",
  pol:        "_widget_1764590764461",
  pod:        "_widget_1764590764463",
  validFrom:  "_widget_1766385879996",
  validTo:    "_widget_1766385879997",
  price20gp:  "_widget_1766460008891",  // 客户价20gp
  price40hq:  "_widget_1766460008892",  // 客户价40hq
  thc:        "_widget_1766460008893",  // 港杂（客户价）
  nextSailing:"_widget_1766687802819",  // 下一水
  eta:        "_widget_1767157052893",  // 预计到港
  forwarder:  "_widget_1764590764459",  // 货代公司英文
  routeCode:  "_widget_1766167914318",  // 航线代码
  remarks:    "_widget_1764585946456",  // 备注
  freeDays:   "_widget_1767157052905",  // 免费用箱天数
};

function get(d, k) {
  const v = d[W[k]];
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return v.value ?? null;
  return v;
}

function mapQuote(d) {
  const validTo   = get(d, "validTo");
  const validFrom = get(d, "validFrom");
  const nextSail  = get(d, "nextSailing");
  const eta       = get(d, "eta");

  return {
    id:          d._id || "",
    carrier:     get(d, "carrier")   || "",
    forwarder:   get(d, "forwarder") || "",
    pol:         get(d, "pol")       || "",
    pod:         get(d, "pod")       || "",
    routeCode:   get(d, "routeCode") || "",
    price20gp:   parseFloat(get(d, "price20gp"))  || null,
    price40hq:   parseFloat(get(d, "price40hq"))  || null,
    thc:         parseFloat(get(d, "thc"))         || null,
    validFrom:   validFrom  ? new Date(validFrom).toISOString().slice(0, 10)  : null,
    validTo:     validTo    ? new Date(validTo).toISOString().slice(0, 10)    : null,
    nextSailing: nextSail   ? new Date(nextSail).toISOString().slice(0, 10)   : null,
    eta:         eta        ? new Date(eta).toISOString().slice(0, 10)        : null,
    freeDays:    get(d, "freeDays")  || "",
    remarks:     get(d, "remarks")   || "",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 从JDY直接拉报价表
    let allQuotes = [];
    let hasMore   = true;
    let lastId    = null;

    while (hasMore) {
      const body = {
        app_id:   JDY_APP_ID,
        entry_id: JDY_ENTRY,
        limit:    100,
        ...(lastId ? { last_id: lastId } : {}),
      };

      const r = await fetch(
        `https://api.jiandaoyun.com/api/v5/app/entry/data/list`,
        {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${JDY_TOKEN}`,
          },
          body: JSON.stringify(body),
        }
      );

      const json = await r.json();
      const rows = json.data || [];
      allQuotes  = allQuotes.concat(rows.map(mapQuote));
      hasMore    = rows.length === 100;
      lastId     = rows.length > 0 ? rows[rows.length - 1]._id : null;
    }

    // 过滤：只保留未过期的（validTo为空或>=今天）
    const today = new Date().toISOString().slice(0, 10);
    const valid = allQuotes.filter(q =>
      !q.validTo || q.validTo >= today
    );

    // 按 pol+pod+carrier 去重，同组取最新（validFrom最大）
    const grouped = {};
    for (const q of valid) {
      const key = `${q.pol}|${q.pod}|${q.carrier}`;
      if (!grouped[key] || (q.validFrom || "") > (grouped[key].validFrom || "")) {
        grouped[key] = q;
      }
    }

    const result = Object.values(grouped).sort((a, b) => {
      // 按航线排序：先pol，再pod
      const r1 = `${a.pol}|${a.pod}`;
      const r2 = `${b.pol}|${b.pod}`;
      return r1.localeCompare(r2);
    });

    return res.status(200).json({
      success: true,
      data:    result,
      count:   result.length,
      total:   allQuotes.length,
    });

  } catch (err) {
    console.error("[freight-quotes]", err);
    return res.status(500).json({ error: err.message });
  }
}
