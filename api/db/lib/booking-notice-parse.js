// 入货通知/订舱确认解析回填：只补空，冲突留痕，不写费用。
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BL_PREFIX = {
  COAU: "COSCO", COSU: "COSCO", OOLU: "OOCL", MAEU: "MAERSK", MEDU: "MSC",
  ESLU: "ESL", TSLU: "TSL", YMLU: "YML", EGLV: "EMC", HLCU: "HAPAG",
  ONEY: "ONE", PCIU: "PIL", PILU: "PIL", CMDU: "CMA", APLU: "CMA"
};
const CARRIER_ALIASES = {
  COSCO: ["中远", "COSCO", "中远海运"], OOCL: ["东方海外", "OOCL"], MSC: ["地中海", "MSC"],
  MAERSK: ["马士基", "MAERSK"], ESL: ["ESL"], TSL: ["德翔", "TSL"], YML: ["阳明", "YML"],
  EMC: ["长荣", "EVERGREEN", "EMC"], HAPAG: ["赫伯罗特", "HAPAG"], ONE: ["ONE"],
  PIL: ["太平", "PIL"], CMA: ["达飞", "CMA", "APL"]
};

function clean(s, max = 120) {
  return String(s || "").replace(/\u0000/g, " ").replace(/[ \t]{2,}/g, " ").trim().slice(0, max);
}

function cleanLine(s) {
  return clean(s, 220).replace(/^[\s"'`]+|[\s"'`]+$/g, "");
}

function normalizeDate(value, year) {
  const s = clean(value).replace(/[年月]/g, "-").replace(/日/g, " ");
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D{0,6}(\d{1,2}):(\d{2}))?/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}${m[4] ? ` ${m[4].padStart(2, "0")}:${m[5]}` : ""}`;
  m = s.match(/(\d{1,2})[-/.](\d{1,2})(?:\D{0,6}(\d{1,2}):(\d{2}))?/);
  if (m) return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}${m[3] ? ` ${m[3].padStart(2, "0")}:${m[4]}` : ""}`;
  return "";
}

function pick(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && clean(m[1])) return clean(m[1]);
  }
  return "";
}

function compactLines(text) {
  const seen = new Set(), out = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const line = cleanLine(raw);
    if (!line || line.length > 220) continue;
    if (/^(?:[A-Z]{2,}|[CD-FGILNOPTQV]{2,}|[耀-鿿]{1,3})$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join("\n");
}

function utf16Runs(buf, offset) {
  const out = [];
  let cur = "";
  for (let i = offset; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    const ok = (code >= 0x20 && code <= 0x7e) || (code >= 0x4e00 && code <= 0x9fff) ||
      [0x3000, 0x3001, 0x3002, 0xff08, 0xff09, 0xff0c, 0xff1a].includes(code);
    if (ok) cur += String.fromCharCode(code);
    else {
      if (cleanLine(cur).length >= 2) out.push(cur);
      cur = "";
    }
  }
  if (cleanLine(cur).length >= 2) out.push(cur);
  return out;
}

function textFromOleStrings(buf) {
  return compactLines([...utf16Runs(buf, 0), ...utf16Runs(buf, 1)].join("\n"));
}

function textFromSheetJs(buf) {
  try {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buf, { type: "buffer", cellDates: false, WTF: false });
    return wb.SheetNames.map((name) => {
      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
      return rows.map((r) => r.map((c) => clean(c, 200)).filter(Boolean).join(" ")).filter(Boolean).join("\n");
    }).join("\n");
  } catch (_) {
    return "";
  }
}

async function textFromPdf(buf) {
  try {
    const mod = require("pdf-parse");
    const parsed = await mod(buf);
    return parsed && parsed.text ? parsed.text : "";
  } catch (_) {
    return "";
  }
}

async function ocrImageBuffer(buf, mime) {
  const key = process.env.MINIMAX_API_KEY || "";
  if (!key) return "";
  const mediaType = String(mime || "image/png").toLowerCase().replace("image/jpg", "image/jpeg");
  if (!/^image\/(png|jpe?g|webp)$/.test(mediaType)) return "";
  const body = {
    model: "MiniMax-M3",
    max_tokens: 4096,
    messages: [{ role: "user", content: [
      { type: "text", text: "请把这份入货通知/订舱确认/SO里的全部文字原样提取出来，保留字段名、日期、编号、场站、联系人，输出纯文本，不要编造。" },
      { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } }
    ] }]
  };
  const r = await fetch("https://api.minimaxi.com/anthropic/v1/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  if (!r.ok) return "";
  try {
    const j = JSON.parse(raw);
    return (j.content || []).filter((x) => x.type === "text").map((x) => x.text || "").join("\n");
  } catch (_) {
    return raw;
  }
}

export async function extractTextFromUpload(buf, filename, mime) {
  const name = String(filename || "").toLowerCase();
  const mt = String(mime || "").toLowerCase();
  if (/\.(xls|xlsx)$/.test(name) || /spreadsheet|excel/.test(mt)) {
    const t = textFromSheetJs(buf);
    if (clean(t).length > 20) return t;
    const ole = textFromOleStrings(buf);
    if (clean(ole).length > 20) return ole;
  }
  if (/\.pdf$/i.test(name) || mt === "application/pdf") {
    const t = await textFromPdf(buf);
    if (clean(t).length > 20) return t;
  }
  if (/^image\//.test(mt) || /\.(png|jpe?g|webp)$/i.test(name)) {
    const t = await ocrImageBuffer(buf, mt);
    if (clean(t).length > 20) return t;
  }
  const latin = buf.toString("latin1").replace(/[^\x20-\x7e\n:：./-]/g, " ");
  const utf16 = buf.toString("utf16le").replace(/[^\x20-\x7e一-龥\n:：./\\-]/g, "\n");
  return `${latin}\n${utf16}`.replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n");
}

function lineAfter(text, labelRe, valueRe) {
  const lines = String(text || "").split(/\n+/).map(cleanLine).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    const same = lines[i].replace(labelRe, "").replace(/^[:：\s]+/, "");
    if (same && (!valueRe || valueRe.test(same))) return clean(same);
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      if (!valueRe || valueRe.test(lines[j])) return clean(lines[j]);
    }
  }
  return "";
}

function firstLine(text, re) {
  const lines = String(text || "").split(/\n+/).map(cleanLine).filter(Boolean);
  const hit = lines.find((line) => re.test(line));
  return hit ? clean(hit) : "";
}

function dateLine(text) {
  const lines = String(text || "").split(/\n+/).map(cleanLine).filter(Boolean);
  return lines.find((line) => !/^DATE[:：]/i.test(line) && /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(line)) || "";
}

function contactName(value) {
  return clean(String(value || "").replace(/[\/,，\s-]*\d[\d\- /]{5,}.*/, "")) || clean(value);
}

function parseContainer(text) {
  const m = text.match(/(\d{1,3})\s*[xX×*]\s*(20GP|20DC|40GP|40HQ|40HC|45HQ|20|40)\b/i);
  if (!m) return { container_qty: null, container_type: "" };
  const type = m[2].toUpperCase().replace(/^20$/, "20GP").replace(/^40$/, "40GP").replace("40HC", "40HQ");
  return { container_qty: Number(m[1]), container_type: type };
}

function parseCarrier(text, blNo) {
  const prefix = blNo ? Object.keys(BL_PREFIX).find((p) => blNo.startsWith(p)) : "";
  if (prefix) return BL_PREFIX[prefix];
  const name = pick(text, [/(?:舱单|船公司|承运人)\s*[:：]?\s*([一-龥A-Za-z ]{2,30})/]);
  const u = name.toUpperCase();
  for (const [code, aliases] of Object.entries(CARRIER_ALIASES)) {
    if (aliases.some((a) => u.includes(a.toUpperCase()))) return code;
  }
  return "";
}

export function parseBookingNotice(text, fallbackYear, filename = "") {
  const src = compactLines(`${filename}\n${text}`);
  const year = String(fallbackYear || new Date().getFullYear());
  const bl = pick(src, [/提运?单号\s*[:：]?\s*([A-Z]{3,4}\d{7,12})/i, /B\/?L\s*(?:NO\.?|号)?\s*[:：]?\s*([A-Z]{3,4}\d{7,12})/i, /\b([A-Z]{4}\d{8,12})\b/]);
  const so = pick(src, [/(?:S\/?O|订舱号|订舱确认号)\s*(?:NO\.?|号)?\s*[:：]?\s*((?!ProductBuildVer)[A-Z0-9][A-Z0-9-]{5,24})/i]);
  const terminal = pick(src, [/(?:入货场站|进仓场站|场站)[ \t]*[:：][ \t]*([^\n；;]{4,80})/]) ||
    lineAfter(src, /^(?:入货场站|进仓场站|场站)\s*[:：]?$/, /货运|物流|代理|有限公司/) ||
    firstLine(src, /货运|物流|代理|有限公司/);
  const contact = pick(src, [/(?:场站联系人|联系人)[ \t]*[:：][ \t]*([^\n；;]{2,60})/]) ||
    lineAfter(src, /^(?:场站联系人|联系人)\s*[:：]?$/, /^(?!舱单|备注|联系电话)[一-龥]{2,8}$/) ||
    pick(src, [/\n([一-龥]{2,8})\n\d{7,12}\b/]);
  const phone = pick(src, [/(?:联系电话|电话)[ \t]*[:：][ \t]*([0-9\- /]{6,40})/, /\b(\d{7,12}(?:[-/ ]\d{2,8})?)\b/]);
  const etd = normalizeDate(pick(src, [/(?:开船时间|ETD|离港日?)[^\d]{0,20}(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/i, /(?:开船时间|ETD)[^\d]{0,20}(\d{1,2}[-/.]\d{1,2})/i]), year) ||
    normalizeDate(lineAfter(src, /^(?:船名\/航次|船名|Vessel)/i, /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/), year) ||
    normalizeDate(dateLine(src), year);
  const portCutoff = normalizeDate(pick(src, [/(?:截港时间|截港|CY\s*CUT[- ]?OFF)\s*[:：]?\s*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\D{0,6}\d{1,2}:\d{2})?)/i]), year);
  const docCutoff = normalizeDate(pick(src, [/(?:截单时间|截单|SI\s*CUT[- ]?OFF)\s*[:：]?\s*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\D{0,6}\d{1,2}:\d{2})?)/i]), year);
  const vgmCutoff = normalizeDate(pick(src, [/(?:截\s*VGM|VGM\s*CUT[- ]?OFF)\s*[:：]?\s*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\D{0,6}\d{1,2}:\d{2})?)/i]), year);
  const ctn = parseContainer(src);
  return {
    bl_no: bl, so_no: so, carrier: parseCarrier(src, bl), etd,
    terminal, terminal_contact: contactName(contact), terminal_tel: phone,
    container_qty: ctn.container_qty, container_type: ctn.container_type,
    port_cutoff_at: portCutoff, cargo_cutoff: portCutoff, doc_cutoff: docCutoff, vgm_cutoff: vgmCutoff
  };
}

async function existingColumns(pool, cols) {
  const r = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='shipping_plans' AND column_name = ANY($1::text[])`,
    [cols]
  );
  return new Map(r.rows.map((x) => [x.column_name, x.data_type || ""]));
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

async function resolveCarrierCompany(pool, carrier) {
  if (!carrier) return { code: null, status: "empty" };
  const aliases = CARRIER_ALIASES[carrier] || [carrier];
  const sql = (where) =>
    `SELECT code, name_cn, name_en FROM companies
      WHERE code NOT LIKE 'DEPRECATED%' AND COALESCE(active,true)
        AND (${where})
      ORDER BY (UPPER(COALESCE(code,''))=UPPER($1)) DESC, id LIMIT 2`;
  const direct = await pool.query(
    sql(aliases.map((_, i) => `UPPER(COALESCE(code,''))=UPPER($${i + 1}) OR UPPER(COALESCE(name_en,'')) LIKE '%'||UPPER($${i + 1})||'%' OR name_cn LIKE '%'||$${i + 1}||'%'`).join(" OR ")),
    aliases
  );
  if (direct.rows.length === 1) return { code: direct.rows[0].code, status: "matched" };
  if (direct.rows.length > 1) return { code: null, status: "ambiguous" };
  const normalized = aliases.map((x) => String(x).trim().toUpperCase());
  const byAlias = await pool.query(
    `SELECT c.code, c.name_cn, c.name_en
       FROM company_aliases a JOIN companies c ON c.code = a.company_code
      WHERE COALESCE(a.status,'active')='active' AND c.code NOT LIKE 'DEPRECATED%' AND COALESCE(c.active,true)
        AND UPPER(a.normalized_alias) = ANY($1::text[])
      ORDER BY c.id LIMIT 2`,
    [normalized]
  ).catch(() => ({ rows: [] }));
  return byAlias.rows.length === 1 ? { code: byAlias.rows[0].code, status: "matched_alias" } : { code: null, status: byAlias.rows.length ? "ambiguous" : "not_found" };
}

export async function backfillBookingNotice(pool, planId, text, filename) {
  const plan = (await pool.query(
    `SELECT id, bl_no, so_no, carrier_code, etd, container_qty, container_type,
            cargo_cutoff, port_cutoff_at, doc_cutoff, vgm_cutoff, raw
       FROM shipping_plans WHERE id=$1`, [planId])).rows[0];
  if (!plan) return { error: "plan not found" };
  const year = plan.etd ? new Date(plan.etd).getFullYear() : new Date().getFullYear();
  const parsed = parseBookingNotice(text, year, filename);
  const carrier = await resolveCarrierCompany(pool, parsed.carrier);
  const conflicts = [];
  const cmp = (a, b) => clean(a) && clean(b) && clean(a) !== clean(b);
  if (cmp(plan.bl_no, parsed.bl_no)) conflicts.push(`BL不一致: 系统${plan.bl_no} vs 通知${parsed.bl_no}`);
  if (plan.etd && parsed.etd && String(plan.etd).slice(0, 10) !== parsed.etd.slice(0, 10)) conflicts.push(`ETD不一致: 系统${String(plan.etd).slice(0, 10)} vs 通知${parsed.etd.slice(0, 10)}`);
  if (parsed.carrier && !carrier.code) conflicts.push(`船公司未唯一匹配companies: ${parsed.carrier}(${carrier.status})`);

  const candidates = ["bl_no", "so_no", "carrier_code", "container_qty", "container_type", "cargo_cutoff", "port_cutoff_at", "doc_cutoff", "vgm_cutoff", "terminal", "terminal_contact", "terminal_tel"];
  const cols = await existingColumns(pool, candidates);
  if (cols.size) {
    const selectCols = [...cols.keys()].map(quoteIdent).join(", ");
    const current = (await pool.query(`SELECT ${selectCols} FROM shipping_plans WHERE id=$1`, [planId])).rows[0] || {};
    Object.assign(plan, current);
  }
  const values = { ...parsed, carrier_code: carrier.code };
  const sets = [], vals = [planId]; let idx = 1;
  for (const col of candidates) {
    if (!cols.has(col) || values[col] == null || values[col] === "" || (plan[col] != null && plan[col] !== "")) continue;
    vals.push(values[col]);
    const cast = /timestamp|date/i.test(cols.get(col)) ? "::timestamptz" : "";
    sets.push(`${col}=$${++idx}${cast}`);
  }
  const note = { parsed, carrier_code: carrier.code, carrier_status: carrier.status, conflicts, file: filename || null, at: new Date().toISOString() };
  vals.push(JSON.stringify(note));
  await pool.query(
    `UPDATE shipping_plans SET ${sets.length ? sets.join(", ") + "," : ""}
       raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('booking_notice', $${++idx}::jsonb,
         'terminal', COALESCE(NULLIF(raw->>'terminal',''), NULLIF($${idx}::jsonb->'parsed'->>'terminal','')),
         'terminal_contact', COALESCE(NULLIF(raw->>'terminal_contact',''), NULLIF($${idx}::jsonb->'parsed'->>'terminal_contact','')),
         'terminal_tel', COALESCE(NULLIF(raw->>'terminal_tel',''), NULLIF($${idx}::jsonb->'parsed'->>'terminal_tel',''))),
       updated_at = now()
     WHERE id=$1`, vals);
  if (conflicts.length) {
    await pool.query(
      `INSERT INTO public.tasks(id, title, reason, status, source, owner_object_type, owner_object_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'open', 'booking-notice', 'logistics', $4, now(), now())
       ON CONFLICT (id) DO UPDATE SET reason=EXCLUDED.reason, updated_at=now()`,
      [`bn-conflict-${planId}`, `入货通知与系统不一致 plan#${planId}`, conflicts.join("; "), String(planId)]).catch(() => {});
  }
  return { filled: sets.map((s) => s.split("=")[0]), carrier_code: carrier.code, conflicts, parsed };
}
