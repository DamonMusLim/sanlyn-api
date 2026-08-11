// 录单执行器·核验层(纯函数, 权威在服务端) — deep-reasoner 架构 2026-08-12
// 规则源自 customs-declaration-verify skill: 金额闭合/号格式/缺显缺/行项非空

const OFFICIAL_NO = /^\d{18}$/;
const DRAFT_NO = /^DRAFT-[A-Z0-9-]{6,40}$/;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

export function verifyIntake(payload) {
  const gaps = [];
  const doc = payload && payload.doc;
  const items = (payload && payload.items) || [];

  if (!doc || typeof doc !== "object")
    return { ok: false, gaps: ["缺doc对象"], normalized: { customs_no: "", official: false, total: 0 } };
  const no = String(doc.customs_no || "").trim();
  if (!no) gaps.push("缺customs_no");
  else if (!OFFICIAL_NO.test(no) && !DRAFT_NO.test(no))
    gaps.push("customs_no须为18位海关编号或DRAFT-<提运单号>(核对件)");
  if (OFFICIAL_NO.test(no) && payload.official === false) gaps.push("18位号却标official=false");
  if (!OFFICIAL_NO.test(no) && payload.official === true) gaps.push("official=true但无18位号");

  if (!String(doc.contract_no || "").trim()) gaps.push("缺contract_no");
  if (!String(doc.export_date || "").match(/^\d{4}-\d{2}-\d{2}$/)) gaps.push("export_date须YYYY-MM-DD");
  if (!String(doc.bl_no || "").trim()) gaps.push("缺bl_no(主提单,挂海运票用)");

  const total = num(doc.total_amount);
  if (!(total > 0)) gaps.push("total_amount须>0");

  if (!Array.isArray(items) || !items.length) gaps.push("行项为空");
  let sum = 0;
  items.forEach((it, i) => {
    const p = `行${i + 1}`;
    if (!/^\d{10}$/.test(String(it.hs_code || ""))) gaps.push(`${p}: hs_code须10位`);
    if (!String(it.name_cn || "").trim()) gaps.push(`${p}: 缺品名`);
    const amt = num(it.amount);
    if (!(amt > 0)) gaps.push(`${p}: amount须>0`);
    else sum += amt;
    if (!(num(it.qty) > 0)) gaps.push(`${p}: qty须>0`);
  });

  // 金额闭合: Σ行项 = 总额, 分毫不差(容差1分防浮点)
  if (total > 0 && items.length && Math.abs(sum - total) > 0.01)
    gaps.push(`金额不闭合: Σ行项${sum.toFixed(2)} ≠ 总额${total.toFixed(2)}`);

  if (!String(payload.file_sha256 || "").match(/^[a-f0-9]{64}$/)) gaps.push("缺file_sha256(64位hex)");

  return { ok: gaps.length === 0, gaps, normalized: { customs_no: no, official: OFFICIAL_NO.test(no), total } };
}
