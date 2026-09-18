import { getPool, setCors } from "../db.js";
import { invalidateNearexpCache } from "./petstore-nearexp.js";

function json(res, code, body) { return res.status(code).json(body); }

function idsOf(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
}

async function bodyOf(req) {
  if (req.body) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function noteAppendSql(text) {
  return `trim(both E'\\n' from concat_ws(E'\\n', NULLIF(note,''), ${text}))`;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
    return json(res, 403, { ok: false, error: "gateway_auth_required" });
  }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

  const body = await bodyOf(req).catch(() => null);
  if (!body) return json(res, 400, { ok: false, error: "bad_json" });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (body.action === "plan_update") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) {
        await client.query("ROLLBACK");
        return json(res, 400, { ok: false, error: "bad_id" });
      }
      const rate = body.rate === "" || body.rate == null ? null : Number(body.rate);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
        await client.query("ROLLBACK");
        return json(res, 400, { ok: false, error: "bad_rate" });
      }
      const ruleText = String(body.rule_text || "").trim();
      const r = await client.query(
        `UPDATE public.petstore_nearexp_plan
            SET rate=$2, rule_text=$3, updated_at=now(), updated_by='damon'
          WHERE id=$1
          RETURNING id,min_days,max_days,rate,rule_text,sort,updated_at,updated_by`,
        [id, rate, ruleText]
      );
      await client.query("COMMIT");
      invalidateNearexpCache();
      return json(res, 200, { ok: true, row: r.rows[0] || null });
    }

    if (body.action === "verify_date") {
      const ids = idsOf(body.ids);
      if (!ids.length) {
        await client.query("ROLLBACK");
        return json(res, 400, { ok: false, error: "bad_ids" });
      }
      const r = await client.query(
        `UPDATE public.petstore_nearexp_proposals
            SET date_verified=true,
                note=${noteAppendSql("$2")},
                updated_at=now()
          WHERE id = ANY($1::bigint[])
            AND status IN ('proposed','approved')
          RETURNING id`,
        [ids, "Damon 已核日期 " + new Date().toISOString()]
      );
      await client.query("COMMIT");
      invalidateNearexpCache();
      return json(res, 200, { ok: true, count: r.rowCount });
    }

    if (body.action === "approve") {
      const ids = idsOf(body.ids);
      if (!ids.length) {
        await client.query("ROLLBACK");
        return json(res, 400, { ok: false, error: "bad_ids" });
      }
      const bad = await client.query(
        `SELECT id FROM public.petstore_nearexp_proposals
          WHERE id = ANY($1::bigint[]) AND date_verified IS NOT TRUE
          LIMIT 1`,
        [ids]
      );
      if (bad.rowCount) {
        await client.query("ROLLBACK");
        return json(res, 400, { ok: false, error: "日期未核,不能批" });
      }
      const r = await client.query(
        `UPDATE public.petstore_nearexp_proposals
            SET status='approved', approved_by='damon', approved_at=now(), updated_at=now()
          WHERE id = ANY($1::bigint[]) AND status='proposed'
          RETURNING id`,
        [ids]
      );
      await client.query("COMMIT");
      invalidateNearexpCache();
      return json(res, 200, { ok: true, count: r.rowCount });
    }

    if (body.action === "reject") {
      const ids = idsOf(body.ids);
      if (!ids.length) {
        await client.query("ROLLBACK");
        return json(res, 400, { ok: false, error: "bad_ids" });
      }
      const r = await client.query(
        `UPDATE public.petstore_nearexp_proposals
            SET status='rejected', updated_at=now()
          WHERE id = ANY($1::bigint[]) AND status IN ('proposed','approved')
          RETURNING id`,
        [ids]
      );
      await client.query("COMMIT");
      invalidateNearexpCache();
      return json(res, 200, { ok: true, count: r.rowCount });
    }

    await client.query("ROLLBACK");
    return json(res, 400, { ok: false, error: "bad_action" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[petstore-nearexp-act]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  } finally {
    client.release();
  }
}
