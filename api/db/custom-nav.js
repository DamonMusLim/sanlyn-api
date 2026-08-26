// GET/PUT /api/db/custom-nav — 工作台自定义导航，复用 system_settings 配置真源。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PREFIX = "workbench.custom_nav.";
const MAX_ITEMS = 30;
const KNOWN_ITEMS = [
  ["工作台", "/wb"], ["运价管理", "/rates"], ["海运出口", "/ship-grid"], ["订单录入", "/order-entry"],
  ["服务项目", "/order-services"], ["订单人员槽", "/order-staff-slots"], ["上海-舱单发送", "/manifest-send"],
  ["青岛-舱单发送", "/qingdao-manifest-send"], ["天津/大连-舱单", "/tianjin-dalian-manifest-send"],
  ["厦门-舱单发送", "/xiamen-manifest-send"], ["AFR发送", "/afr-send"], ["AMS发送", "/ams-send"],
  ["ISF发送", "/isf-send"], ["ICS2", "/ics2-send"], ["在线报关", "/online-customs"], ["VGM发送", "/vgm-send"],
  ["盯箱宝", "/container-watch"], ["全程货物跟踪", "/shipment-tracking"], ["货运保险", "/cargo-insurance"],
  ["集运费用明细", "/consolidated-fee-details"], ["账单管理", "/ocean"], ["开票记录", "/invoice-records"],
  ["收付管理", "/receipt-payment-management"], ["核销管理", "/settlement-management"], ["提成管理", "/commission-management"],
  ["提单管理", "/bl-management"], ["箱货信息", "/cargo-info"], ["审核提交记录", "/ops-todos"],
  ["报价审核", "/audit-review?type=quote"], ["费用审核", "/audit-review?type=fee"], ["业务预警", "/biz-alerts"],
  ["费用预警", "/fee-alerts"]
].map(([title, url]) => ({ title, url }));

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function actorFrom(req) {
  const u = req.user || {};
  return clean(u.employee_code || u.staff_no || u.username || u.account || u.email || u.uid || u.id || u.sub || u.name || "unknown", 80);
}

function settingKey(req) {
  return PREFIX + actorFrom(req).replace(/[^A-Za-z0-9_.@:-]+/g, "_");
}

function basis(state, note, extra = {}) {
  return { state, note, ...extra };
}

function pct(filled, total) {
  if (!total) return 0;
  return Number(((Number(filled || 0) / Number(total)) * 100).toFixed(1));
}

async function tableStatus(pool) {
  const exists = Boolean((await pool.query("SELECT to_regclass($1) AS name", ["public.system_settings"])).rows[0]?.name);
  if (!exists) return { ok: false, missing: ["system_settings"], coverage: { filled: 0, total: 1, fill_rate_percent: 0 } };
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    ["system_settings"]
  );
  const cols = new Set(r.rows.map((x) => x.column_name));
  const missing = ["key", "value", "updated_at"].filter((x) => !cols.has(x));
  return { ok: missing.length === 0, missing, coverage: { filled: missing.length ? 0 : 1, total: 1, fill_rate_percent: missing.length ? 0 : 100 } };
}

function normalizeItems(input) {
  const byUrl = new Map(KNOWN_ITEMS.map((x) => [x.url, x.title]));
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const url = clean(raw?.url, 180);
    if (!byUrl.has(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: byUrl.get(url), url });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

async function loadConfig(pool, key) {
  const r = await pool.query("SELECT value, updated_at FROM system_settings WHERE key=$1 LIMIT 1", [key]);
  if (!r.rows.length) return null;
  let parsed = [];
  try { parsed = JSON.parse(r.rows[0].value || "[]"); } catch {}
  return { items: normalizeItems(parsed), updated_at: r.rows[0].updated_at };
}

function responseForMissing(status) {
  return {
    success: true,
    state: "not_connected",
    can_save: false,
    custom_items: [],
    default_items: KNOWN_ITEMS,
    generated_at: new Date().toISOString(),
    basis: basis("not_connected", `未接入: 缺 ${status.missing.join(" / ")}；当前填充率 ${status.coverage.fill_rate_percent}%`, {
      table: "system_settings",
      missing_fields: status.missing,
      coverage: status.coverage,
    }),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PUT, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!["GET", "PUT"].includes(req.method)) return res.status(405).json({ success: false, error: "GET/PUT required" });
  try {
    const pool = getPool();
    const status = await tableStatus(pool);
    if (!status.ok) return res.status(req.method === "GET" ? 200 : 409).json(responseForMissing(status));
    const key = settingKey(req);
    if (req.method === "GET") {
      const cfg = await loadConfig(pool, key);
      if (!cfg || !cfg.items.length) {
        const missing = cfg ? "custom_items 至少 1 项" : `system_settings.key=${key} 配置行`;
        return res.status(200).json({
          success: true,
          state: "not_connected",
          can_save: true,
          custom_items: [],
          default_items: KNOWN_ITEMS,
          generated_at: new Date().toISOString(),
          basis: basis("not_connected", `未接入: 缺 ${missing}；当前填充率 ${pct(cfg?.items?.length || 0, 1)}%`, {
            table: "system_settings",
            setting_key: key,
            coverage: { filled: cfg?.items?.length ? 1 : 0, total: 1, fill_rate_percent: cfg?.items?.length ? 100 : 0 },
          }),
        });
      }
      return res.status(200).json({
        success: true,
        state: "ready",
        can_save: true,
        custom_items: cfg.items,
        default_items: KNOWN_ITEMS,
        updated_at: cfg.updated_at,
        generated_at: new Date().toISOString(),
        basis: basis("ready", `已接入 system_settings.key=${key}；当前填充率 100%`, { table: "system_settings", setting_key: key }),
      });
    }
    const items = normalizeItems(req.body?.items);
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, JSON.stringify(items)]
    );
    return res.status(200).json({ success: true, state: items.length ? "ready" : "not_connected", custom_items: items, generated_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
