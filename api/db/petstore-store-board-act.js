import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { buildStoreBoard, invalidateStoreBoardCache } from "./petstore-store-board.js";

const GAPS = [
  { key: "barcode_missing", label: "条码缺失", assignee: "OPS-01" },
  { key: "pic_missing", label: "图片缺失", assignee: "PET-12" },
  { key: "cost_missing", label: "成本缺失", assignee: "PET-22" },
  { key: "negative_stock", label: "负库存", assignee: "PET-22" },
  { key: "source_stale", label: "数据源未更新", assignee: "OPS-01" }
];

function json(res, code, body) { return res.status(code).json(body); }
function trunc(s, n) { return Array.from(String(s || "")).slice(0, n).join(""); }
function ymd(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
}
function dod(key) {
  const m = {
    barcode_missing: ["补齐缺失条码或说明无法读取原因", "经营台数据健康该项数量下降并回读"],
    pic_missing: ["补齐商品图片或说明无法拍摄原因", "经营台数据健康该项数量下降并回读"],
    cost_missing: ["补齐成本覆盖或确认系统成本来源", "经营台数据健康该项数量下降并回读"],
    negative_stock: ["现场盘点并修正负库存来源", "经营台数据健康该项数量下降并回读"],
    source_stale: ["恢复数据源当日更新链路", "经营台数据健康该项数量下降并回读"]
  };
  return m[key] || ["补齐缺失数据", "经营台数据健康该项数量下降并回读"];
}
async function newId(client) {
  const prefix = "hb-" + ymd(new Date()) + "-";
  for (let i = 0; i < 20; i++) {
    const id = prefix + crypto.randomBytes(3).toString("hex");
    const r = await client.query("SELECT 1 FROM public.tasks WHERE id=$1", [id]);
    if (!r.rowCount) return id;
  }
  throw new Error("id_exhausted");
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") return json(res, 403, { ok: false, error: "gateway_auth_required" });
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

  const key = String((req.body || {}).gap_key || "").trim();
  const gapDef = GAPS.find((g) => g.key === key);
  if (!gapDef) return json(res, 400, { ok: false, error: "bad_gap_key" });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const board = await buildStoreBoard(client);
    const gap = (board.health?.gaps || []).find((g) => g.key === key);
    const count = Number(gap?.count || 0);
    if (!gap || count <= 0) {
      await client.query("ROLLBACK");
      return json(res, 400, { ok: false, error: "gap_empty" });
    }

    const dedupeKey = "health:" + key;
    const dup = await client.query(
      `SELECT id FROM public.tasks WHERE dedupe_key=$1 AND status NOT IN ('done','cancelled') LIMIT 1`,
      [dedupeKey]);
    if (dup.rowCount) {
      await client.query("ROLLBACK");
      return json(res, 409, { ok: false, error: "DUPLICATE", task_id: dup.rows[0].id });
    }

    const id = await newId(client);
    const due = new Date(Date.now() + 3 * 86400000);
    const snap = board.health?.last_snapshot_at || board.generated_at || new Date().toISOString();
    const label = gap.label || gapDef.label;
    const assignee = gap.assignee || gapDef.assignee;
    const title = trunc("补数据:" + label + " " + count, 120);
    const reason = label + "数量" + count + "；数据快照时间" + snap;
    const criteria = { dod: dod(key), gap_key: key, count };

    await client.query(
      `INSERT INTO public.tasks
        (id,title,status,source,dispatched_by,reason,for_role,current_holder,next_holder,verifier,acceptance_criteria,due_at,domain,dedupe_key)
       VALUES ($1,$2,'open','dataops','human_request',$3,'PET','',$4,'PET-01',$5::jsonb,$6,'petstore',$7)`,
      [id, title, reason, assignee, JSON.stringify(criteria), due, dedupeKey]);

    await client.query(
      `INSERT INTO public.task_events(task_id,event_type,actor_type,actor_id,note,metadata)
       VALUES ($1,'created','human','damon',$2,$3::jsonb)`,
      [id, reason, JSON.stringify({ gap_key: key, count })]);

    const back = await client.query("SELECT id, title, status, next_holder, dedupe_key FROM public.tasks WHERE id=$1", [id]);
    if (back.rowCount !== 1) throw new Error("created_readback_failed");

    await client.query("COMMIT");
    invalidateStoreBoardCache();
    return json(res, 200, { ok: true, task: back.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[petstore-store-board-act]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  } finally {
    client.release();
  }
}
