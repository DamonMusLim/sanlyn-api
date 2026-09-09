import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERDICTS = Object.assign(Object.create(null), {
  not_comparable: 1,
  priced_ok: 1,
  intentional: 1,
  cannot_follow: 1,
  todo: 1,
});

const PEER_PATTERN = "宠物|宠|猫粮|狗粮|猫砂|猫罐|猫条|喵|汪|犬|萌宠|萌鸟|爱宠|羊奶粉";

function json(res, s, d) { return res.status(s).json(d); }
function cleanText(v, m = 500) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function save(req, who) {
  const b = req.body || {};
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (!rawItems.length) return { code: 400, body: { ok: false, error: "no_items" } };
  if (rawItems.length > 200) return { code: 400, body: { ok: false, error: "too_many_items" } };

  const recheckPct = num(b.recheck_pct);
  const pct = recheckPct === null ? 20 : recheckPct;

  const items = [];
  for (const it of rawItems) {
    const productCode = cleanText(it?.product_code, 80);
    if (!productCode) return { code: 400, body: { ok: false, error: "bad_product_code" } };

    const verdict = cleanText(it?.verdict, 40);
    if (!verdict || !Object.hasOwn(VERDICTS, verdict)) {
      return { code: 400, body: { ok: false, error: "bad_verdict" } };
    }

    items.push({
      product_code: productCode,
      verdict,
      note: cleanText(it?.note, 500),
    });
  }

  const codes = items.map(x => x.product_code);
  const verdicts = items.map(x => x.verdict);
  const notes = items.map(x => x.note);

  const client = await getPool().connect();
  let changed = 0;
  let readback = [];
  try {
    await client.query("BEGIN");

    const r = await client.query(
      `WITH input AS (
          SELECT *
            FROM unnest($1::text[], $2::text[], $3::text[])
                 AS t(product_code, verdict, note)
        ),
        l AS (
          SELECT DISTINCT ON (q.product_code, q.competitor_name)
                 q.product_code,
                 q.price,
                 (q.competitor_name ~ $6::text) AS is_peer,
                 -- 🔴 口径必须和罗盘的 lo 完全一致(同行 + 同品牌 + 可用价),
                 --    否则存下来的基准是另一套算法算的,以后「附近价变了没」会判错。
                 (position(substring(r.product_name from '^[A-Za-z0-9一-鿿]{2,6}') in q.title) > 0) AS same_brand,
                 (CASE
                    WHEN q.orig_price > 0 AND q.price < q.orig_price * 0.3 THEN false
                    WHEN q.title ~ '第1件|首件|第一件|爆品价|新客|限购|券后' THEN false
                    ELSE true END) AS price_usable
            FROM public.petstore_market_quotes_raw q
            JOIN public.petstore_ops_row r ON r.product_code = q.product_code
           WHERE q.product_code = ANY($1::text[])
             AND q.match_status = 'MATCHED'
             AND q.price IS NOT NULL
           ORDER BY q.product_code, q.competitor_name, q.captured_at DESC
        ),
        lo AS (
          SELECT product_code,
                 round(min(price) FILTER (WHERE is_peer AND same_brand IS TRUE AND price_usable)::numeric, 2) AS lo
            FROM l
           GROUP BY product_code
        ),
        store AS (
          SELECT product_code, store_price::numeric AS store_price
            FROM public.petstore_ops_row
           WHERE product_code = ANY($1::text[])
        )
        INSERT INTO public.petstore_price_review
                (product_code, verdict, note, decided_by, decided_at,
                 lo_at_decision, store_price_at_decision, recheck_pct)
        SELECT i.product_code,
               i.verdict,
               i.note,
               $4::text,
               now(),
               lo.lo,
               store.store_price,
               $5::numeric
          FROM input i
          LEFT JOIN lo ON lo.product_code = i.product_code
          LEFT JOIN store ON store.product_code = i.product_code
        ON CONFLICT (product_code) DO UPDATE
           SET verdict = EXCLUDED.verdict,
               note = EXCLUDED.note,
               decided_by = EXCLUDED.decided_by,
               decided_at = EXCLUDED.decided_at,
               lo_at_decision = EXCLUDED.lo_at_decision,
               store_price_at_decision = EXCLUDED.store_price_at_decision,
               recheck_pct = EXCLUDED.recheck_pct
        RETURNING product_code`,
      [codes, verdicts, notes, who, pct, PEER_PATTERN]);
    changed = r.rows.length;

    const back = await client.query(
      `SELECT product_code, verdict, note, decided_by, decided_at,
              lo_at_decision, store_price_at_decision, recheck_pct
         FROM public.petstore_price_review
        WHERE product_code = ANY($1::text[])
        ORDER BY product_code`,
      [codes]);
    readback = back.rows;

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return { code: 200, body: { ok: true, requested: items.length, changed, readback } };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const who = req.user?.username || req.user?.name || "unknown";
    if (!who || who === "unknown") return json(res, 401, { ok: false, error: "no_identity" });

    const out = await save(req, who);
    return json(res, out.code, out.body);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || "server_error" });
  }
}
