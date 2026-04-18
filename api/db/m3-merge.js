// api/db/m3-merge.js
// M3 Phase 2 — Merge 引擎
// 三道门（confidence / format / business）+ missing_items 生成 + auto-merge + 审计链
//
// 导出：
//   runMerge({ shipment_no, pool })      主入口，由 ocr-booking.js 自动触发 + HTTP 端点调用
//   scanMissingItems({ shipment_no, pool })  文件级缺失扫描
//
// 所有内部错误按 [M3_WRITE_FAIL] JSON 格式记录，不 throw
//
// Fix1: shipment_no 级 in-memory 互斥锁（单进程 PM2 fork 模式有效）
// Fix2: 跨文档冲突预检查（dedupByField 之前）
// Fix3: vessel 不截斜杠；pol/pod 高频港口 alias 标准化
// Fix4: missing_item 去重键增加 doc_type 维度

import { genM3Id, insertMissingItem } from "./m3-writer.js";

// ── Fix1: shipment_no 级互斥锁 ─────────────────────────────────────
// 单进程有效（PM2 fork 模式）；集群/多进程场景升级为 Redis advisory lock
const _mergeLocks = new Set();

// ── L3 冲突锁定表（来自 T5_conflict_register）──────────────────────────
const CONFLICT_LOCKS = {
  "CY00031": ["eta"],
  "CY00033": ["eta"],
  "CY00034": ["eta"],
  "CY00039": ["eta"],
  "CY00042": ["vessel", "etd", "eta"],
  "CY00044": ["eta"],
  "CY00045": ["vessel", "etd", "eta"],
};

// ── auto-merge 白名单（仅 shipping_plans 顶层列）──────────────────────
const TARGET_MAP = {
  bl_no:          { table: "shipping_plans", col: "bl_no",          type: "text" },
  vessel:         { table: "shipping_plans", col: "vessel",         type: "text" },
  voyage:         { table: "shipping_plans", col: "voyage",         type: "text" },
  pol:            { table: "shipping_plans", col: "pol",            type: "text" },
  pod:            { table: "shipping_plans", col: "pod",            type: "text" },
  etd:            { table: "shipping_plans", col: "etd",            type: "date" },
  eta:            { table: "shipping_plans", col: "eta",            type: "date" },
  container_no:   { table: "shipping_plans", col: "container_no",   type: "text" },
  container_type: { table: "shipping_plans", col: "container_type", type: "text" },
  cutoff_date:    { table: "shipping_plans", col: "cutoff_date",    type: "date" },
};

// ── 来源优先级（source_engine → 数值，越大越优先）────────────────────
const SOURCE_PRIORITY = {
  manual:        4,
  claude_review: 3,
  qwen_vl:       2,
  minimax:       1,
};

// ── container_type 枚举标准化映射 ────────────────────────────────────
const CONTAINER_TYPE_MAP = {
  "20'":  "20GP", "20GP": "20GP", "20": "20GP",
  "40'":  "40GP", "40GP": "40GP", "40": "40GP",
  "40HC": "40HQ", "40HQ": "40HQ", "HQ": "40HQ",
  "45HC": "45HQ", "45HQ": "45HQ",
};

// ── Fix3: pol/pod 高频港口别名映射（最小集，覆盖当前主要贸易港）──────
// key 一律大写，value 为标准英文港口名
const PORT_ALIAS_MAP = {
  // 中国主要出口港
  "上海":      "SHANGHAI",  "SHA":    "SHANGHAI",
  "深圳":      "SHENZHEN",  "SZX":    "SHENZHEN",
  "宁波":      "NINGBO",    "NGC":    "NINGBO",    "NGB": "NINGBO",
  "天津":      "TIANJIN",   "TSN":    "TIANJIN",
  "广州":      "GUANGZHOU", "GZ":     "GUANGZHOU",
  "厦门":      "XIAMEN",    "XMN":    "XIAMEN",
  "青岛":      "QINGDAO",   "TAO":    "QINGDAO",
  "大连":      "DALIAN",    "DLC":    "DALIAN",
  // 主要目的港
  "洛杉矶":    "LOS ANGELES", "LAX":  "LOS ANGELES", "LOSANGELES": "LOS ANGELES",
  "长滩":      "LONG BEACH",  "LGB":  "LONG BEACH",  "LONGBEACH":  "LONG BEACH",
  "纽约":      "NEW YORK",    "NYC":  "NEW YORK",    "NEWYORK":    "NEW YORK",
  "鹿特丹":    "ROTTERDAM",   "RTM":  "ROTTERDAM",
  "汉堡":      "HAMBURG",     "HAM":  "HAMBURG",
  "安特卫普":  "ANTWERP",     "ANR":  "ANTWERP",
  "新加坡":    "SINGAPORE",   "SIN":  "SINGAPORE",  "SGP": "SINGAPORE",
};

// ─────────────────────────────────────────────────────────────────────
// 统一失败日志
// ─────────────────────────────────────────────────────────────────────
function logM3Fail({ stage, shipment_no, file_type, source_engine, error }) {
  console.error("[M3_WRITE_FAIL]", JSON.stringify({
    stage:         stage         || "unknown",
    shipment_no:   shipment_no   || "unknown",
    file_type:     file_type     || "unknown",
    source_engine: source_engine || "unknown",
    error:         error instanceof Error ? error.message : String(error),
    ts:            new Date().toISOString(),
  }));
}

// ─────────────────────────────────────────────────────────────────────
// normalizeValue
// 标准化字段值，用于存入目标表 + 比对已有值
// ─────────────────────────────────────────────────────────────────────
export function normalizeValue(field_name, value) {
  if (value === null || value === undefined || value === "") return null;
  const v = String(value).trim();

  // 日期字段 → YYYY-MM-DD
  if (["etd", "eta", "cutoff_date"].includes(field_name)) {
    return parseToYYYYMMDD(v);
  }

  // bl_no → 大写去空格
  if (field_name === "bl_no") {
    return v.replace(/\s+/g, "").toUpperCase();
  }

  // container_no → 大写去空格（多箱号支持，取第一个）
  if (field_name === "container_no") {
    const first = v.split(/[,，\s]+/)[0];
    return first.toUpperCase().replace(/\s+/g, "");
  }

  // container_type → 枚举标准化
  if (field_name === "container_type") {
    const key = v.replace(/\s+/g, "").toUpperCase();
    return CONTAINER_TYPE_MAP[key] || null; // 无法标准化则 null
  }

  // Fix3: vessel → 大写 + 合并多余空格，不截斜杠（保留 voyage 差异用于比对）
  // 原实现截斜杠会把 "VESSEL A/113S" 和 "VESSEL A" 归一，掩盖跨文档冲突
  if (field_name === "vessel") {
    return v.toUpperCase().replace(/\s+/g, " ").trim();
  }

  // Fix3: pol/pod → alias 标准化 + 大写，防止中文/缩写差异误判一致
  if (field_name === "pol" || field_name === "pod") {
    const upper = v.toUpperCase().replace(/\s+/g, " ").trim();
    return PORT_ALIAS_MAP[upper] || upper;
  }

  return v;
}

// ── 日期解析辅助：多格式 → YYYY-MM-DD ────────────────────────────────
function parseToYYYYMMDD(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // 已是 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // YYYY/MM/DD 或 DD/MM/YYYY 或 MM/DD/YYYY
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) return s.replace(/\//g, "-");
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [a, b, c] = s.split("/");
    // 假设 MM/DD/YYYY
    return `${c}-${a.padStart(2,"0")}-${b.padStart(2,"0")}`;
  }
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [a, b, c] = s.split("-");
    return `${c}-${a.padStart(2,"0")}-${b.padStart(2,"0")}`;
  }

  // 尝试 Date.parse（ISO / UTC）
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return null;
}

// ─────────────────────────────────────────────────────────────────────
// getTargetMapping — 从白名单获取目标表/列信息
// ─────────────────────────────────────────────────────────────────────
function getTargetMapping(field_name) {
  return TARGET_MAP[field_name] || null;
}

// ─────────────────────────────────────────────────────────────────────
// isConflictLocked — 查询 L3 冲突锁定
// ─────────────────────────────────────────────────────────────────────
function isConflictLocked(shipment_no, field_name) {
  const locks = CONFLICT_LOCKS[shipment_no];
  return Array.isArray(locks) && locks.includes(field_name);
}

// ─────────────────────────────────────────────────────────────────────
// sameValue — 规范化后比对
// ─────────────────────────────────────────────────────────────────────
function sameValue(a, b, field_name) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const na = normalizeValue(field_name, String(a));
  const nb = normalizeValue(field_name, String(b));
  if (na === null || nb === null) return false;
  return na === nb;
}

// ─────────────────────────────────────────────────────────────────────
// Fix2: preCheckCrossDocConflict
// 在 dedupByField 之前对 rawResults 做跨文档冲突扫描：
//   同 shipment_no + field_name 若存在规范化后不一致的候选值
//   → 为每条候选分别生成 conflict missing_item
//   → 不阻断后续 dedupByField + 主 merge 流程
// @param {Array}  rawResults - 未去重的全量 pending field_results
// @param {Object} pool
// @returns {Set<string>}    有跨文档冲突的 field_name 集合（供调用方记录日志）
// ─────────────────────────────────────────────────────────────────────
async function preCheckCrossDocConflict(rawResults, pool) {
  const conflictFields = new Set();

  // 按 field_name 分组
  const byField = new Map();
  for (const r of rawResults) {
    if (!byField.has(r.field_name)) byField.set(r.field_name, []);
    byField.get(r.field_name).push(r);
  }

  for (const [field_name, candidates] of byField.entries()) {
    if (candidates.length < 2) continue;

    // 过滤出能规范化的候选
    const normalized = candidates
      .map(r => ({ result: r, norm: normalizeValue(field_name, r.field_value) }))
      .filter(x => x.norm !== null);

    if (normalized.length < 2) continue;

    const distinctValues = new Set(normalized.map(x => x.norm));
    if (distinctValues.size < 2) continue;

    // 有不一致 → 记录冲突字段，为每条候选生成 conflict missing_item
    conflictFields.add(field_name);
    const allNorms = [...distinctValues].join(" / ");

    for (const { result, norm } of normalized) {
      await generateMissingItem({
        result,
        gateResult: {
          issue_type:  "conflict",
          severity:    "warning",
          description: `字段 "${field_name}" 在多份文件中存在不一致提取值（本文件："${norm}"，所有候选：${allNorms}），已由优先级规则选取，需人工核查`,
        },
        pool,
      }).catch(err => logM3Fail({
        stage:         "preCheckCrossDocConflict.generate",
        shipment_no:   result.shipment_no,
        file_type:     field_name,
        source_engine: result.source_engine,
        error:         err,
      }));
    }
  }

  return conflictFields;
}

// ─────────────────────────────────────────────────────────────────────
// dedupByField
// 同 field_name 保留：source_priority 最高；相同 priority 取 confidence 最高
// @param {Array} results - document_field_results 行数组
// @returns {{ winners: Array, loserIds: Set<string> }}
//   winners  — 每个 field_name 的胜出结果（进入三道门）
//   loserIds — 被淘汰候选的 _id 集合（调用方标记 superseded）
// ─────────────────────────────────────────────────────────────────────
function dedupByField(results) {
  const best = new Map();
  for (const r of results) {
    const fn = r.field_name;
    const pri = SOURCE_PRIORITY[r.source_engine] || 0;
    const conf = Number(r.confidence) || 0;
    const prev = best.get(fn);
    if (!prev) {
      best.set(fn, { ...r, _priority: pri });
      continue;
    }
    const prevPri = prev._priority;
    const prevConf = Number(prev.confidence) || 0;
    if (pri > prevPri || (pri === prevPri && conf > prevConf)) {
      best.set(fn, { ...r, _priority: pri });
    }
  }
  const winners = Array.from(best.values());
  const winnerIds = new Set(winners.map(w => w._id));
  const loserIds = new Set(
    results.filter(r => !winnerIds.has(r._id)).map(r => r._id)
  );
  return { winners, loserIds };
}

// ─────────────────────────────────────────────────────────────────────
// 门一：confidenceGate（纯计算，无 DB 操作）
// ─────────────────────────────────────────────────────────────────────
function confidenceGate(result) {
  const c = Number(result.confidence) || 0;
  if (c >= 0.85) return { pass: true };
  if (c >= 0.60) {
    return {
      pass: false,
      issue_type: "low_confidence",
      severity: "warning",
      description: `"${result.field_name}" 置信度 ${c.toFixed(2)}（0.60–0.84），需人工确认（提取值："${result.field_value}"）`,
    };
  }
  return {
    pass: false,
    issue_type: "low_confidence",
    severity: "info",
    description: `"${result.field_name}" 置信度 ${c.toFixed(2)} 过低，已拒绝提取值 "${result.field_value}"`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 门二：computeFormatValid（含 DB 更新 format_valid）
// ─────────────────────────────────────────────────────────────────────
async function computeFormatValid(result, pool) {
  const { field_name, field_value, _id } = result;
  const v = String(field_value || "").trim();
  let format_valid = true;
  let reason = null;
  let gate = { pass: true };

  // ── 日期字段 ──
  if (["etd", "eta", "cutoff_date"].includes(field_name)) {
    const parsed = parseToYYYYMMDD(v);
    if (!parsed) {
      format_valid = false;
      reason = `无法解析为 YYYY-MM-DD：${v}`;
      gate = {
        pass: false,
        issue_type: "invalid_format",
        severity: "critical",
        description: `"${field_name}" 格式无效：提取值 "${v}" 无法解析为日期`,
      };
    }
  }

  // ── bl_no ──
  else if (field_name === "bl_no") {
    const normalized = v.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9]{10,16}$/.test(normalized)) {
      format_valid = false;
      reason = `不符合提单号格式 [A-Z0-9]{10,16}：${v}`;
      gate = {
        pass: false,
        issue_type: "invalid_format",
        severity: "critical",
        description: `"bl_no" 格式无效：提取值 "${v}" 无法解析`,
      };
    }
  }

  // ── container_type ──
  else if (field_name === "container_type") {
    const key = v.replace(/\s+/g, "").toUpperCase();
    if (!CONTAINER_TYPE_MAP[key]) {
      format_valid = false;
      reason = `不在枚举范围 [20GP/40GP/40HQ/45HQ]：${v}`;
      gate = {
        pass: false,
        issue_type: "invalid_format",
        severity: "warning",
        description: `"container_type" 格式不规范："${v}"，期望格式：20GP / 40GP / 40HQ / 45HQ`,
      };
    }
  }

  // ── container_no（多箱号支持，逐个检查）──
  else if (field_name === "container_no") {
    const parts = v.split(/[,，\s]+/).filter(Boolean);
    const invalid = parts.filter(p => !/^[A-Z]{4}\d{7}$/.test(p.toUpperCase()));
    if (invalid.length > 0) {
      format_valid = false;
      reason = `箱号格式不符 [A-Z]{4}\\d{7}：${invalid.join(", ")}`;
      gate = {
        pass: false,
        issue_type: "invalid_format",
        severity: "warning",
        description: `"container_no" 格式不规范："${invalid[0]}"，期望格式：ABCD1234567`,
      };
    }
  }

  // ── 更新 DB ──
  // 注：document_field_results 无 updated_at 列，使用 merged_at 记录处理时间（仅在 merge 步骤）
  try {
    await pool.query(
      `UPDATE document_field_results SET format_valid=$1 WHERE _id=$2`,
      [format_valid, _id]
    );
  } catch (err) {
    logM3Fail({
      stage:         "computeFormatValid.db_update",
      shipment_no:   result.shipment_no,
      file_type:     result.field_name,
      source_engine: result.source_engine,
      error:         err,
    });
    // DB 更新失败不阻断门控逻辑
  }

  return { format_valid, reason, ...gate };
}

// ─────────────────────────────────────────────────────────────────────
// 门三：computeBusinessValid（含 DB 更新 business_valid）
// context: { sp_row, customs_row, pendingByField }
// ─────────────────────────────────────────────────────────────────────
async function computeBusinessValid(result, context, pool) {
  const { field_name, field_value, shipment_no, _id } = result;
  const { sp_row, customs_row, pendingByField } = context;
  let business_valid = true;
  let reason = null;
  let gate = { pass: true };

  // 取已规范化的提取值
  const normalizedExtracted = normalizeValue(field_name, field_value);
  if (normalizedExtracted === null) {
    // 无法规范化，跳过业务校验（format gate 应已拦截）
    await _updateBusinessValid(true, _id, pool, result);
    return { business_valid: true, reason: null, pass: true };
  }

  // ── 规则 1: ETD ≤ ETA 互查（仅当两者都在本批次 pending 中）──
  if (field_name === "etd" || field_name === "eta") {
    const etdVal = field_name === "etd" ? normalizedExtracted : pendingByField["etd"];
    const etaVal = field_name === "eta" ? normalizedExtracted : pendingByField["eta"];
    if (etdVal && etaVal) {
      const parsedEtd = new Date(etdVal);
      const parsedEta = new Date(etaVal);
      if (!isNaN(parsedEtd) && !isNaN(parsedEta) && parsedEtd > parsedEta) {
        business_valid = false;
        reason = `ETD (${etdVal}) > ETA (${etaVal})`;
        gate = {
          pass: false,
          issue_type: "invalid_format",
          severity: "critical",
          description: `ETD "${etdVal}" > ETA "${etaVal}"，时间逻辑错误`,
        };
      }
    }
  }

  // ── 规则 2: 正本 BL 放单后不允许自动覆盖 ──
  if (gate.pass) {
    const blStatus = customs_row?.raw?.bl_status || customs_row?.bl_status || null;
    if (["approved", "released"].includes(blStatus)) {
      const mapping = getTargetMapping(field_name);
      if (mapping) {
        const existingVal = sp_row?.[mapping.col];
        if (existingVal !== null && existingVal !== undefined && existingVal !== "") {
          business_valid = false;
          reason = `BL 已放单（${blStatus}），不允许自动覆盖`;
          gate = {
            pass: false,
            issue_type: "conflict",
            severity: "warning",
            description: `BL 已放单，字段 "${field_name}" 不允许自动覆盖（提取值："${normalizedExtracted}"，现有："${existingVal}"）`,
          };
        }
      }
    }
  }

  // ── 规则 3: L3 冲突锁定 ──
  if (gate.pass && isConflictLocked(shipment_no, field_name)) {
    business_valid = false;
    reason = `L3 冲突锁定字段：${field_name}`;
    gate = {
      pass: false,
      issue_type: "conflict",
      severity: "warning",
      description: `字段 "${field_name}" 在 ${shipment_no} 的冲突锁定中，需人工裁定`,
    };
  }

  // ── 规则 4: 目标列已有值 ──
  if (gate.pass) {
    const mapping = getTargetMapping(field_name);
    if (mapping) {
      const existingRaw = sp_row?.[mapping.col];
      // 规范化已有值用于比对
      // 空字符串与 NULL 同等视为"无值"，不产生 conflict
      const existingStr = existingRaw instanceof Date
        ? existingRaw.toISOString().slice(0, 10)
        : (existingRaw !== null && existingRaw !== undefined ? String(existingRaw) : "");
      const existingNorm = existingStr.trim() !== ""
        ? normalizeValue(field_name, existingStr)
        : null;

      if (existingNorm !== null) {
        if (sameValue(existingNorm, normalizedExtracted, field_name)) {
          // 值一致，标记 accepted，不写入，不生成 missing_item
          gate = { pass: false, _already_accepted: true };
        } else {
          business_valid = false;
          reason = `目标列已有值且不一致`;
          gate = {
            pass: false,
            issue_type: "conflict",
            severity: "warning",
            description: `字段 "${field_name}" 已有值 "${existingNorm}"，与提取值 "${normalizedExtracted}" 不一致`,
          };
        }
      }
    }
  }

  await _updateBusinessValid(business_valid, _id, pool, result);
  return { business_valid, reason, ...gate };
}

// ── 更新 business_valid 辅助 ────────────────────────────────────────
async function _updateBusinessValid(valid, _id, pool, result) {
  try {
    await pool.query(
      `UPDATE document_field_results SET business_valid=$1 WHERE _id=$2`,
      [valid, _id]
    );
  } catch (err) {
    logM3Fail({
      stage:         "computeBusinessValid.db_update",
      shipment_no:   result?.shipment_no,
      file_type:     result?.field_name,
      source_engine: result?.source_engine,
      error:         err,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// executeFieldMerge — 写入目标表（仅 NULL 目标）
// @returns {{ success: boolean, skipped_reason?: string }}
// ─────────────────────────────────────────────────────────────────────
async function executeFieldMerge({ result, target_table, target_col, value_normalized, pool }) {
  const { shipment_no, _id } = result;

  // 额外双保险：只写 NULL/空字符串目标（即使 businessGate 已检查）
  // 注1：日期列需要显式 ::date 转型，文本列使用 ::text
  // 注2：shipping_plans 中部分列存储为 '' 而非 NULL，WHERE 需同时处理两种情况
  const mapping = getTargetMapping(result.field_name);
  const cast = mapping?.type === "date" ? "::date" : "::text";
  const safeSQL = mapping?.type === "date"
    ? `UPDATE ${target_table} SET ${target_col}=$1${cast} WHERE shipment_no=$2 AND ${target_col} IS NULL`
    : `UPDATE ${target_table} SET ${target_col}=$1${cast} WHERE shipment_no=$2 AND (${target_col} IS NULL OR ${target_col} = '')`;
  try {
    const res = await pool.query(safeSQL, [value_normalized, shipment_no]);
    if (res.rowCount === 0) {
      // 目标已有值（并发场景），幂等跳过
      return { success: false, skipped_reason: "target not NULL at write time" };
    }
  } catch (err) {
    logM3Fail({
      stage:         "executeFieldMerge.update_target",
      shipment_no,
      file_type:     target_col,
      source_engine: result.source_engine,
      error:         err,
    });
    return { success: false, skipped_reason: `db error: ${err.message}` };
  }

  // 更新 field_result status → 'merged'（使用 merged_at 记录时间，无 updated_at 列）
  try {
    await pool.query(
      `UPDATE document_field_results SET status='merged', is_accepted=true,
       merged_at=NOW(), merged_by='m3_engine' WHERE _id=$1`,
      [_id]
    );
  } catch (err) {
    logM3Fail({
      stage:         "executeFieldMerge.update_field_result_status",
      shipment_no,
      file_type:     target_col,
      source_engine: result.source_engine,
      error:         err,
    });
    // 不中断：数据已写入目标表
  }

  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────
// writeAuditLog — 写入 audit_logs 表
// ─────────────────────────────────────────────────────────────────────
async function writeAuditLog({ result, target_table, target_col, before_val, after_val, sp_row, pool }) {
  const rawMeta = (() => {
    try { return typeof result.raw === "string" ? JSON.parse(result.raw) : (result.raw || {}); }
    catch (_) { return {}; }
  })();

  const detail = {
    // 目标写入
    target_table,
    target_field:    target_col,
    before_value:    before_val,
    after_value:     after_val,
    // 来源链路
    source_engine:      result.source_engine,
    confidence:         Number(result.confidence),
    confidence_type:    rawMeta.confidence_type || null,
    source_file_id:     result.file_id,
    source_task_id:     result.task_id,
    source_result_id:   result._id,
    // 上下文
    shipment_no:  result.shipment_no,
    doc_type:     result.doc_type || "booking_note",
    field_name:   result.field_name,
    merge_ts:     new Date().toISOString(),
  };

  try {
    await pool.query(
      `INSERT INTO audit_logs (action, operator, role, company, contract_no, detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        "m3_auto_merge",
        "system",
        "m3_engine",
        "",
        sp_row?.contract_no || "",
        JSON.stringify(detail),
      ]
    );
  } catch (err) {
    logM3Fail({
      stage:         "writeAuditLog",
      shipment_no:   result.shipment_no,
      file_type:     target_col,
      source_engine: result.source_engine,
      error:         err,
    });
    // 审计写失败不阻断 merge 主流程
  }
}

// ─────────────────────────────────────────────────────────────────────
// generateMissingItem — 查重后调 insertMissingItem
// ─────────────────────────────────────────────────────────────────────
async function generateMissingItem({ result, gateResult, pool }) {
  const { shipment_no, field_name, _id: result_id } = result;
  const { issue_type, severity, description } = gateResult;
  // Fix4: doc_type 纳入去重键，防止不同文档的同名字段问题被错误吞并
  const doc_type = result.doc_type || null;

  // ── 去重：同 (shipment_no, issue_type, field_name, doc_type) 存在 open → 跳过 ──
  try {
    const existing = await pool.query(
      `SELECT id FROM document_missing_items
       WHERE shipment_no=$1 AND issue_type=$2 AND field_name=$3 AND status='open'
         AND (doc_type IS NOT DISTINCT FROM $4)
       LIMIT 1`,
      [shipment_no, issue_type, field_name, doc_type]
    );
    if (existing.rows.length > 0) return { generated: false };
  } catch (err) {
    logM3Fail({
      stage:         "generateMissingItem.dedup_check",
      shipment_no,
      file_type:     field_name,
      source_engine: result.source_engine,
      error:         err,
    });
    // Fix: 审查指出 catch 后应 return，防止 DB 异常时产生重复 missing_item
    return { generated: false };
  }

  await insertMissingItem({
    shipment_no,
    contract_no:  result.contract_no || null,
    issue_type,
    severity,
    field_name,
    doc_type:     result.doc_type || "booking_note",
    description,
    expected_val: null,
    actual_val:   result.field_value,
    result_id,
    auto_generated: true,
  }, pool);

  return { generated: true };
}

// ─────────────────────────────────────────────────────────────────────
// scanMissingItems — 文件级缺失扫描
// @param {{ shipment_no: string, pool }}
// @returns {{ generated: number, skipped: number }}
// ─────────────────────────────────────────────────────────────────────
export async function scanMissingItems({ shipment_no, pool }) {
  let generated = 0;
  let skipped = 0;

  // 加载 sp 和 customs 行
  let sp_row = null;
  let customs_row = null;
  try {
    const spRes = await pool.query(
      `SELECT * FROM shipping_plans WHERE shipment_no=$1 LIMIT 1`,
      [shipment_no]
    );
    sp_row = spRes.rows[0] || null;

    const cdRes = await pool.query(
      `SELECT * FROM customs_data WHERE shipment_no=$1 ORDER BY updated_at DESC LIMIT 1`,
      [shipment_no]
    );
    customs_row = cdRes.rows[0] || null;
  } catch (err) {
    logM3Fail({
      stage:         "scanMissingItems.load_rows",
      shipment_no,
      file_type:     "system",
      source_engine: "system",
      error:         err,
    });
    return { generated: 0, skipped: 0 };
  }

  // ── 文件缺失规则表 ──────────────────────────────────────────────
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const checks = [
    // bl_final 文件
    {
      condition: !customs_row?.bl_final,
      issue_type: "missing",
      severity: "critical",
      field_name: "bl_final",
      doc_type: "bl_final",
      description: `${shipment_no} 缺少 bl_final 文件`,
      expected_val: "bl_final 文件",
      actual_val: null,
    },
    // customs_dec 文件
    {
      condition: !customs_row?.customs_dec,
      issue_type: "missing",
      severity: "critical",
      field_name: "customs_dec",
      doc_type: "customs_dec",
      description: `${shipment_no} 缺少 customs_dec 文件`,
      expected_val: "customs_dec 文件",
      actual_val: null,
    },
    // bl_no 字段（SP 存在但无 BL 号）
    {
      condition: sp_row && !sp_row.bl_no,
      issue_type: "missing",
      severity: "critical",
      field_name: "bl_no",
      doc_type: null,
      description: `${shipment_no} 装运计划缺少 bl_no 字段`,
      expected_val: "bl_no 字段",
      actual_val: null,
    },
    // booking_note（SP 存在且 ETD 超过 7 天前）
    {
      condition: !customs_row?.booking_note &&
        sp_row?.etd && new Date(sp_row.etd) < sevenDaysAgo,
      issue_type: "missing",
      severity: "warning",
      field_name: "booking_note",
      doc_type: "booking_note",
      description: `${shipment_no} 缺少 booking_note 文件（ETD 已过 7 天）`,
      expected_val: "booking_note 文件",
      actual_val: null,
    },
    // bl_draft 文件
    {
      condition: !customs_row?.bl_draft,
      issue_type: "missing",
      severity: "warning",
      field_name: "bl_draft",
      doc_type: "bl_draft",
      description: `${shipment_no} 缺少 bl_draft 文件`,
      expected_val: "bl_draft 文件",
      actual_val: null,
    },
    // customs_dec_official（ETA 已过）
    {
      condition: !customs_row?.customs_dec_official &&
        sp_row?.eta && new Date(sp_row.eta) < now,
      issue_type: "missing",
      severity: "warning",
      field_name: "customs_dec_official",
      doc_type: "customs_dec_official",
      description: `${shipment_no} ETA 已过，缺少 customs_dec_official 文件`,
      expected_val: "customs_dec_official 文件",
      actual_val: null,
    },
  ];

  for (const check of checks) {
    if (!check.condition) continue;

    // Fix4: 去重键增加 doc_type（防止同字段不同文档来源的问题被吞并）
    try {
      const existing = await pool.query(
        `SELECT id FROM document_missing_items
         WHERE shipment_no=$1 AND issue_type=$2 AND field_name=$3 AND status='open'
           AND (doc_type IS NOT DISTINCT FROM $4)
         LIMIT 1`,
        [shipment_no, check.issue_type, check.field_name, check.doc_type || null]
      );
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }
    } catch (err) {
      logM3Fail({
        stage:         "scanMissingItems.dedup_check",
        shipment_no,
        file_type:     check.field_name,
        source_engine: "system",
        error:         err,
      });
    }

    const insertResult = await insertMissingItem({
      shipment_no,
      contract_no:    customs_row?.contract_no || sp_row?.contract_no || null,
      issue_type:     check.issue_type,
      severity:       check.severity,
      field_name:     check.field_name,
      doc_type:       check.doc_type,
      description:    check.description,
      expected_val:   check.expected_val,
      actual_val:     check.actual_val,
      result_id:      null,   // 文件级缺失，无 result_id
      auto_generated: true,
    }, pool);

    if (insertResult) generated++;
    else skipped++;
  }

  return { generated, skipped };
}

// ─────────────────────────────────────────────────────────────────────
// runMerge — 主入口
// @param {{ shipment_no: string, pool: pg.Pool }}
// @returns {Promise<{ merged, accepted, conflicts, low_confidence,
//                     invalid_format, missing, skipped, error }>}
// ─────────────────────────────────────────────────────────────────────
export async function runMerge({ shipment_no, pool }) {
  const stats = {
    merged: 0, accepted: 0, conflicts: 0,
    low_confidence: 0, invalid_format: 0,
    missing: 0, skipped: 0, error: null,
  };

  // ── Fix1: shipment_no 级互斥锁，防止同 SP 并发重复 merge ──────────
  if (_mergeLocks.has(shipment_no)) {
    console.warn(`[M3] runMerge: merge_in_progress for ${shipment_no}, skipping`);
    return { ...stats, error: "merge_in_progress" };
  }
  _mergeLocks.add(shipment_no);

  try {
    // ── Step 1: 加载 pending field_results ────────────────────────
    const frRes = await pool.query(
      `SELECT dfr.*, df.doc_type, df.file_url
       FROM document_field_results dfr
       LEFT JOIN document_files df ON df._id = dfr.file_id
       WHERE dfr.shipment_no=$1 AND dfr.status='pending'
       ORDER BY dfr.created_at ASC`,
      [shipment_no]
    );
    const rawResults = frRes.rows;

    if (rawResults.length === 0) {
      return { ...stats, error: null }; // 无 pending，正常返回空统计
    }

    // ── Step 2a: Fix2 跨文档冲突预检查（在 dedup 前）────────────
    // 同 field_name 多候选且规范化后不一致 → 生成 conflict missing_item（不阻断 merge）
    await preCheckCrossDocConflict(rawResults, pool);

    // ── Step 2b: 去重（同字段取最优来源）+ 标记落败者 superseded ──
    const { winners: results, loserIds } = dedupByField(rawResults);

    // Fix2b: 将被淘汰的候选标记为 superseded，避免长期停留在 pending
    if (loserIds.size > 0) {
      const loserArr = [...loserIds];
      try {
        await pool.query(
          `UPDATE document_field_results SET status='superseded'
           WHERE _id = ANY($1::text[]) AND status='pending'`,
          [loserArr]
        );
      } catch (err) {
        logM3Fail({
          stage:         "runMerge.mark_superseded",
          shipment_no,
          file_type:     "system",
          source_engine: "system",
          error:         err,
        });
        // 标记失败不阻断主流程
      }
    }

    // ── Step 3: 加载 context（sp + customs）──────────────────────
    let sp_row = null;
    let customs_row = null;
    try {
      const spRes = await pool.query(
        `SELECT * FROM shipping_plans WHERE shipment_no=$1 LIMIT 1`,
        [shipment_no]
      );
      sp_row = spRes.rows[0] || null;

      const cdRes = await pool.query(
        `SELECT * FROM customs_data WHERE shipment_no=$1 ORDER BY updated_at DESC LIMIT 1`,
        [shipment_no]
      );
      customs_row = cdRes.rows[0] || null;
    } catch (err) {
      logM3Fail({
        stage:         "runMerge.load_context",
        shipment_no,
        file_type:     "system",
        source_engine: "system",
        error:         err,
      });
      stats.error = err.message;
      return stats;
    }

    // ── Step 4a: Pass 1 — 门一 + 门二，收集 pendingByField ───────
    // pendingByField: { [field_name]: normalizedValue } 用于 ETD/ETA 互查
    const pendingByField = {};
    const pass1Map = new Map(); // field_name → { result, gate1, gate2, normalizedValue }

    for (const result of results) {
      const mapping = getTargetMapping(result.field_name);
      if (!mapping) {
        stats.skipped++;
        // 非白名单字段，仍需运行门一门二决定是否生成 missing_item
        const gate1 = confidenceGate(result);
        if (!gate1.pass) {
          await generateMissingItem({ result, gateResult: gate1, pool });
          stats[gate1.issue_type === "low_confidence" ? "low_confidence" : gate1.issue_type]++;
        }
        // 格式校验也跑（同步更新 DB format_valid）
        await computeFormatValid(result, pool);
        continue;
      }

      // 门一
      const gate1 = confidenceGate(result);
      if (!gate1.pass) {
        await generateMissingItem({ result, gateResult: gate1, pool });
        stats.low_confidence++;
        // 标记 status='rejected'
        await _markFieldResultStatus(result._id, "rejected", pool);
        continue;
      }

      // 门二
      const gate2 = await computeFormatValid(result, pool);
      if (!gate2.pass) {
        await generateMissingItem({ result, gateResult: gate2, pool });
        stats.invalid_format++;
        await _markFieldResultStatus(result._id, "rejected", pool);
        continue;
      }

      // 规范化提取值
      const normalizedValue = normalizeValue(result.field_name, result.field_value);
      if (normalizedValue === null) {
        stats.skipped++;
        await _markFieldResultStatus(result._id, "rejected", pool);
        continue;
      }

      // 收集到 pendingByField（供门三 ETD/ETA 互查）
      pendingByField[result.field_name] = normalizedValue;
      pass1Map.set(result.field_name, { result, gate1, gate2, normalizedValue, mapping });
    }

    // ── Step 4b: Pass 2 — 门三，带 pendingByField 上下文 ─────────
    const mergedFileIds = new Set();

    for (const [field_name, { result, normalizedValue, mapping }] of pass1Map.entries()) {
      const context = { sp_row, customs_row, pendingByField };
      const gate3 = await computeBusinessValid(result, context, pool);

      if (gate3._already_accepted) {
        // 值一致，标 accepted
        stats.accepted++;
        await pool.query(
          `UPDATE document_field_results SET status='accepted', is_accepted=true WHERE _id=$1`,
          [result._id]
        ).catch(err => logM3Fail({
          stage: "runMerge.mark_accepted", shipment_no, file_type: field_name,
          source_engine: result.source_engine, error: err,
        }));
        continue;
      }

      if (!gate3.pass) {
        await generateMissingItem({ result, gateResult: gate3, pool });
        stats.conflicts++;
        await _markFieldResultStatus(result._id, "rejected", pool);
        continue;
      }

      // ── 全通过：执行写入 ────────────────────────────────────────
      // 获取写入前的值（用于审计）
      const before_val = sp_row?.[mapping.col] ?? null;
      const before_val_str = before_val instanceof Date
        ? before_val.toISOString().slice(0, 10)
        : (before_val !== null ? String(before_val) : null);

      const mergeResult = await executeFieldMerge({
        result,
        target_table: mapping.table,
        target_col:   mapping.col,
        value_normalized: normalizedValue,
        pool,
      });

      if (mergeResult.success) {
        stats.merged++;
        mergedFileIds.add(result.file_id);
        await writeAuditLog({
          result,
          target_table: mapping.table,
          target_col:   mapping.col,
          before_val:   before_val_str,
          after_val:    normalizedValue,
          sp_row,
          pool,
        });
      } else {
        // 写入被幂等跳过（并发场景，目标在本批次写入后不再为 NULL）
        stats.skipped++;
        console.warn(`[M3] runMerge: executeFieldMerge skipped: ${mergeResult.skipped_reason} (${shipment_no}.${field_name})`);
      }
    }

    // ── Step 5: 更新 document_files.extract_status = 'merged' ────
    for (const fileId of mergedFileIds) {
      try {
        await pool.query(
          `UPDATE document_files SET extract_status='merged', updated_at=NOW() WHERE _id=$1`,
          [fileId]
        );
      } catch (err) {
        logM3Fail({
          stage:         "runMerge.update_file_status",
          shipment_no,
          file_type:     "document_files",
          source_engine: "system",
          error:         err,
        });
      }
    }

    // ── Step 6: 文件级缺失扫描 ───────────────────────────────────
    const scanResult = await scanMissingItems({ shipment_no, pool });
    stats.missing += scanResult.generated;
    stats.skipped += scanResult.skipped;

  } catch (err) {
    logM3Fail({
      stage:         "runMerge.outer",
      shipment_no,
      file_type:     "system",
      source_engine: "system",
      error:         err,
    });
    stats.error = err.message || String(err);
  } finally {
    // Fix1: 无论成功/失败/异常，释放锁
    _mergeLocks.delete(shipment_no);
  }

  return stats;
}

// ── 更新 field_result status 辅助（document_field_results 无 updated_at）─
async function _markFieldResultStatus(id, status, pool) {
  try {
    await pool.query(
      `UPDATE document_field_results SET status=$1 WHERE _id=$2`,
      [status, id]
    );
  } catch (_) {
    // 忽略，非核心路径
  }
}
