// Best-effort SO text cutoff parser. Only fills empty fields.
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1] || m[0];
  }
  return "";
}

function normalizeDate(v, year) {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}${m[4] ? ` ${m[4].padStart(2, "0")}:${m[5]}` : ""}`;
  m = s.match(/(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}${m[3] ? ` ${m[3].padStart(2, "0")}:${m[4]}` : ""}`;
  return "";
}

function parseSoCutoffs(text, fallbackYear) {
  const src = String(text || "").replace(/\u0000/g, " ");
  const year = String(fallbackYear || new Date().getFullYear());
  const vgm = normalizeDate(firstMatch(src, [
    /VGM\s*CUT[- ]?OFF[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
    /截\s*VGM[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
  ]), year);
  const si = normalizeDate(firstMatch(src, [
    /SI\s*CUT[- ]?OFF[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
    /截\s*单[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
  ]), year);
  const cargo = normalizeDate(firstMatch(src, [
    /FCL\s*DELIVERY[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
    /进\s*场[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
    /截\s*港[:：\s]*(\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?:\s+\d{1,2}:\d{2})?)/i,
  ]), year);
  return { vgm_cutoff: vgm, doc_cutoff: si, cargo_cutoff: cargo, port_cutoff_at: cargo };
}

async function backfillSoCutoffs(pool, planId, text) {
  const plan = (await pool.query("SELECT etd FROM shipping_plans WHERE id=$1", [planId])).rows[0] || {};
  const year = plan.etd ? new Date(plan.etd).getFullYear() : new Date().getFullYear();
  const parsed = parseSoCutoffs(text, year);
  if (!parsed.vgm_cutoff && !parsed.doc_cutoff && !parsed.cargo_cutoff) return parsed;
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='shipping_plans'
        AND column_name = ANY($1::text[])`,
    [["vgm_cutoff", "doc_cutoff", "cargo_cutoff", "port_cutoff_at"]]
  );
  const types = Object.fromEntries(cols.rows.map(r => [r.column_name, r.data_type]));
  const expr = (col, idx) => {
    const cast = /timestamp|date/i.test(types[col] || "") ? `::timestamptz` : "";
    return `${col} = CASE WHEN ${col} IS NULL AND $${idx}<>'' THEN $${idx}${cast} ELSE ${col} END`;
  };
  await pool.query(
    `UPDATE shipping_plans SET
       ${expr("vgm_cutoff", 2)},
       ${expr("doc_cutoff", 3)},
       ${expr("cargo_cutoff", 4)},
       ${expr("port_cutoff_at", 5)},
       raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('so_cutoff_parse', $6::jsonb),
       updated_at = NOW()
     WHERE id=$1`,
    [planId, parsed.vgm_cutoff, parsed.doc_cutoff, parsed.cargo_cutoff, parsed.port_cutoff_at, JSON.stringify(parsed)]
  );
  return parsed;
}

export { backfillSoCutoffs, parseSoCutoffs };
