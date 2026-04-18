// api/db/m3-writer.js
// M3 Phase 1 — 统一写入工具
// 被 ocr-booking.js (接入点 B) 和 upsert.js (接入点 A) 调用
// 所有函数：写入失败不 throw，按 [M3_WRITE_FAIL] JSON 格式记录后 return null

// ── 文件列 → doc_type + 是否需要提取 ──────────────────────────────
const FILE_COL_MAP = {
  bl_final:             { doc_type: "bl_final",             extract: true  },
  bl_draft:             { doc_type: "bl_draft",             extract: true  },
  booking_note:         { doc_type: "booking_note",         extract: true  },
  customs_dec:          { doc_type: "customs_dec",          extract: true  },
  customs_dec_official: { doc_type: "customs_dec_official", extract: false },
  release_note:         { doc_type: "release_note",         extract: false },
  origin_cert:          { doc_type: "origin_cert",          extract: false },
  quarantine_report:    { doc_type: "quarantine_report",    extract: false },
  seal_photos:          { doc_type: "seal_photos",          extract: false },
  factory_sign:         { doc_type: "factory_sign",         extract: false },
};

// ── ocr-booking 返回字段 → M3 field_name + Phase 1 baseline confidence ──
const OCR_FIELD_MAP = [
  { ocrField: "blNo",          m3Field: "bl_no",          confidence: 0.90 },
  { ocrField: "vessel",        m3Field: "vessel",         confidence: 0.85 },
  { ocrField: "etd",           m3Field: "etd",            confidence: 0.88 },
  { ocrField: "eta",           m3Field: "eta",            confidence: 0.85 },
  { ocrField: "pol",           m3Field: "pol",            confidence: 0.82 },
  { ocrField: "pod",           m3Field: "pod",            confidence: 0.82 },
  { ocrField: "containerNos",  m3Field: "container_no",   confidence: 0.88 },
  { ocrField: "containerSize", m3Field: "container_type", confidence: 0.90 },
  { ocrField: "cutoffDate",    m3Field: "cutoff_date",    confidence: 0.80 },
  { ocrField: "shipper",       m3Field: "shipper",        confidence: 0.75 },
  { ocrField: "consignee",     m3Field: "consignee",      confidence: 0.75 },
  { ocrField: "grossWeight",   m3Field: "gross_weight",   confidence: 0.80 },
  { ocrField: "volume",        m3Field: "total_cbm",      confidence: 0.80 },
];

// ── ID 生成器 ─────────────────────────────────────────────────────
export function genM3Id(prefix) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${ts}-${rand}`;
}

// ── URL 解析：从 JSON "[{url:'...'}]" 中取第一个 url ──────────────
function parseFileUrl(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr[0]?.url) return arr[0].url;
    } catch (_) {}
    // raw 本身就是 url 字符串
    if (raw.startsWith("http")) return raw;
  }
  return null;
}

// ── 统一失败日志 ──────────────────────────────────────────────────
function logM3Fail({ stage, shipment_no, file_type, source_engine, error }) {
  console.error("[M3_WRITE_FAIL]", JSON.stringify({
    stage:         stage        || "unknown",
    shipment_no:   shipment_no  || "unknown",
    file_type:     file_type    || "unknown",
    source_engine: source_engine|| "unknown",
    error:         error instanceof Error ? error.message : String(error),
    ts:            new Date().toISOString(),
  }));
}

// ─────────────────────────────────────────────────────────────────
// 接入点 A：registerFiles
// 在 upsert.js customs_data 分支成功后调用
// 检测文件列变化，将新增文件注册到 document_files
//
// @param {string}  shipment_no
// @param {string}  contract_no
// @param {Object}  record        - 已 normalize 的 customs record（写入后状态）
// @param {Object}  existing_row  - upsert 前的原始数据库行（可为 null，首次写入时）
// @param {string}  upload_by
// @param {Object}  pool          - pg Pool
// @returns {{ registered: number, skipped: number } | null}
// ─────────────────────────────────────────────────────────────────
export async function registerFiles({ shipment_no, contract_no, record, existing_row, upload_by, pool }) {
  let registered = 0;
  let skipped = 0;

  for (const [col, meta] of Object.entries(FILE_COL_MAP)) {
    const newUrl = parseFileUrl(record[col] || record[toCamel(col)]);
    if (!newUrl) { skipped++; continue; }

    // 比对旧值，避免重复注册（existing_row 为 null 时视为首次写入）
    const oldUrl = existing_row ? parseFileUrl(existing_row[col]) : null;
    if (newUrl === oldUrl) { skipped++; continue; }

    const extract_status = meta.extract ? "pending" : "skip";
    const fileId = genM3Id("DF");

    try {
      await pool.query(
        `INSERT INTO document_files
           (_id, shipment_no, contract_no, doc_type, file_url,
            file_name, upload_by, extract_status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (file_url) DO NOTHING`,
        [
          fileId,
          shipment_no  || "",
          contract_no  || null,
          meta.doc_type,
          newUrl,
          meta.doc_type,     // file_name 占位（URL 无法拆出原始文件名）
          upload_by    || "system",
          extract_status,
        ]
      );
      registered++;
    } catch (err) {
      logM3Fail({
        stage:         "register_files",
        shipment_no:   shipment_no,
        file_type:     meta.doc_type,
        source_engine: "system",
        error:         err,
      });
      // 单列失败不中断，继续处理其他列
    }
  }

  return { registered, skipped };
}

// ─────────────────────────────────────────────────────────────────
// 接入点 B：registerOcrResult
// 在 ocr-booking.js extractBookingFields() 成功后调用
// 写入 document_files + document_extract_tasks + document_field_results
//
// @param {string}  ossUrl
// @param {string}  filename
// @param {string}  shipment_no   （可能为空，从 matchedOrders 推断）
// @param {Object}  extracted     （ocr-booking 返回的提取结果）
// @param {string}  triggered_by  'upload' | 'manual'
// @param {Object}  pool
// @returns {{ file_id, task_id, result_count } | null}
// ─────────────────────────────────────────────────────────────────
export async function registerOcrResult({ ossUrl, filename, shipment_no, extracted, triggered_by, pool }) {
  if (!ossUrl || !extracted || extracted.parseError) return null;

  const sno = shipment_no || "";
  const fname = filename || "booking_note";
  const fileId = genM3Id("DF");
  const taskId = genM3Id("DT");

  // ── Step 1: document_files ───────────────────────────────────
  try {
    await pool.query(
      `INSERT INTO document_files
         (_id, shipment_no, doc_type, file_url, file_name,
          mime_type, upload_by, extract_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (file_url) DO UPDATE SET
         extract_status = 'extracting',
         updated_at     = NOW()`,
      [fileId, sno, "booking_note", ossUrl, fname,
       "application/pdf", "ocr-booking", "extracting"]
    );
  } catch (err) {
    logM3Fail({
      stage:         "register_ocr_result.step1_file",
      shipment_no:   sno,
      file_type:     "booking_note",
      source_engine: "qwen_vl",
      error:         err,
    });
    return null;
  }

  // ── Step 2: document_extract_tasks ──────────────────────────
  try {
    await pool.query(
      `INSERT INTO document_extract_tasks
         (_id, file_id, shipment_no, doc_type,
          model, stage, status, attempt_count,
          started_at, triggered_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,NOW(),NOW())`,
      [taskId, fileId, sno, "booking_note",
       "qwen_vl", "extract", "running", 1,
       triggered_by || "upload"]
    );
  } catch (err) {
    logM3Fail({
      stage:         "register_ocr_result.step2_task",
      shipment_no:   sno,
      file_type:     "booking_note",
      source_engine: "qwen_vl",
      error:         err,
    });
    return null;
  }

  // ── Step 3: document_field_results（逐字段）─────────────────
  // ⚠️ Phase 1 baseline confidence 标注：
  //    raw 列写入 confidence_type='baseline_p1' 以区分真实模型置信度
  let result_count = 0;
  const failedFields = [];

  for (const { ocrField, m3Field, confidence } of OCR_FIELD_MAP) {
    const value = extracted[ocrField];
    if (value === null || value === undefined || value === "") continue;

    const resultId = genM3Id("DR");
    try {
      await pool.query(
        `INSERT INTO document_field_results
           (_id, task_id, file_id, shipment_no,
            field_name, field_value,
            confidence, format_valid, business_valid,
            source_engine, source_stage,
            is_accepted, status,
            raw, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,NOW())
         ON CONFLICT (_id) DO NOTHING`,
        [
          resultId, taskId, fileId, sno,
          m3Field, String(value),
          confidence, null, null,    // format_valid / business_valid → Phase 2
          "qwen_vl", "extract",
          false, "pending",
          JSON.stringify({
            confidence_type: "baseline_p1",
            ocr_model:       "qwen_vl_max",
            ocr_field:       ocrField,
          }),
        ]
      );
      result_count++;
    } catch (err) {
      failedFields.push(m3Field);
      logM3Fail({
        stage:         "register_ocr_result.step3_field_result",
        shipment_no:   sno,
        file_type:     `booking_note.${m3Field}`,
        source_engine: "qwen_vl",
        error:         err,
      });
    }
  }

  // ── Step 4: 完成 task + 更新 file status ────────────────────
  try {
    await pool.query(
      `UPDATE document_extract_tasks
       SET status='done', result_count=$1, completed_at=NOW(), updated_at=NOW()
       WHERE _id=$2`,
      [result_count, taskId]
    );
    await pool.query(
      `UPDATE document_files
       SET extract_status='done', updated_at=NOW()
       WHERE _id=$1`,
      [fileId]
    );
  } catch (err) {
    logM3Fail({
      stage:         "register_ocr_result.step4_finalize",
      shipment_no:   sno,
      file_type:     "booking_note",
      source_engine: "qwen_vl",
      error:         err,
    });
    // 不 return null：字段已写入，task 状态更新失败不影响核心数据
  }

  if (failedFields.length > 0) {
    console.warn(`[M3] registerOcrResult: ${failedFields.length} field(s) failed to write:`, failedFields.join(", "));
  }

  return { file_id: fileId, task_id: taskId, result_count };
}

// ─────────────────────────────────────────────────────────────────
// insertMissingItem（Phase 2 主力调用，Phase 1 建架子）
// 写入 document_missing_items，含 result_id 合法性校验
//
// @param {Object} item
// @param {Object} pool
// ─────────────────────────────────────────────────────────────────
export async function insertMissingItem(item, pool) {
  const {
    shipment_no, contract_no,
    issue_type, severity,
    field_name, doc_type, description,
    expected_val, actual_val,
    result_id,
    auto_generated = true,
  } = item;

  // ── result_id 合法性校验（见 M3_phase1_plan_v2.md §九.3）────
  const REQUIRES_RESULT_ID = ["conflict", "low_confidence", "invalid_format"];
  if (REQUIRES_RESULT_ID.includes(issue_type) && !result_id) {
    logM3Fail({
      stage:         "insert_missing_item.result_id_validation",
      shipment_no:   shipment_no || "unknown",
      file_type:     doc_type    || "unknown",
      source_engine: "system",
      error:         `result_id required for issue_type=${issue_type} but got null/undefined`,
    });
    return null;
  }

  const _id = genM3Id("DM");

  try {
    await pool.query(
      `INSERT INTO document_missing_items
         (_id, shipment_no, contract_no,
          issue_type, severity,
          field_name, doc_type, description,
          expected_val, actual_val, result_id,
          status, auto_generated,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
       ON CONFLICT (_id) DO NOTHING`,
      [
        _id,
        shipment_no  || "",
        contract_no  || null,
        issue_type,
        severity     || "warning",
        field_name   || null,
        doc_type     || null,
        description,
        expected_val || null,
        actual_val   || null,
        result_id    || null,
        "open",
        auto_generated,
      ]
    );
    return { _id };
  } catch (err) {
    logM3Fail({
      stage:         "insert_missing_item",
      shipment_no:   shipment_no || "unknown",
      file_type:     doc_type    || "unknown",
      source_engine: "system",
      error:         err,
    });
    return null;
  }
}

// ── 内部工具：snake_case → camelCase ──────────────────────────────
function toCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
