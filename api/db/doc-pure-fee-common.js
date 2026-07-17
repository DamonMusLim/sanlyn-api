import { findPlanByRef, resolvePlanContracts } from "./lib/shipping-plan-contracts.js";

export const SELLER = {
  name: "上海洋宝宝国际物流有限公司",
  tax_id: "91310106MAE9L4AQ28",
  bank: "中国银行厦门文灶支行",
  acct: "433849860868",
};

export async function loadShippingPlan(pool, id) {
  const plan = await findPlanByRef(pool, id);
  if (!plan) return null;
  const contracts = await resolvePlanContracts(pool, plan);
  if (!contracts.legacy && contracts.freightUsdNo) {
    return { ...plan, contract_no: contracts.freightUsdNo, contract_nos: contracts.allNos };
  }
  return plan;
}

export function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function moneyNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function fmtMoney(v, ccy) {
  const cur = String(ccy || "").toUpperCase();
  const sign = cur === "CNY" || cur === "RMB" ? "¥" : cur === "USD" ? "$" : "";
  const n = Number(v);
  if (!Number.isFinite(n)) return sign + "0.00";
  return sign + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function numberToRMB(v) {
  const n = moneyNumber(v);
  if (!n) return "人民币零元整";
  const cnNums = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const cnIntRadice = ["", "拾", "佰", "仟"];
  const cnIntUnits = ["", "万", "亿", "兆"];
  const cnDecUnits = ["角", "分"];
  const parts = n.toFixed(2).split(".");
  let integerNum = parts[0];
  const decimalNum = parts[1];
  let chineseStr = "";
  if (Number(integerNum) > 0) {
    let zeroCount = 0;
    for (let i = 0; i < integerNum.length; i++) {
      const p = integerNum.length - i - 1;
      const d = integerNum.substr(i, 1);
      const quotient = Math.floor(p / 4);
      const modulus = p % 4;
      if (d === "0") {
        zeroCount++;
      } else {
        if (zeroCount > 0) chineseStr += cnNums[0];
        zeroCount = 0;
        chineseStr += cnNums[Number(d)] + cnIntRadice[modulus];
      }
      if (modulus === 0 && zeroCount < 4) chineseStr += cnIntUnits[quotient];
    }
    chineseStr += "元";
  }
  let dec = "";
  for (let i = 0; i < cnDecUnits.length; i++) {
    const d = decimalNum.substr(i, 1);
    if (d !== "0") dec += cnNums[Number(d)] + cnDecUnits[i];
  }
  return "人民币" + chineseStr + (dec || "整");
}

export function copyBtn(value, label) {
  const text = value === null || value === undefined || value === "" ? "-" : String(value);
  return `<span>${esc(text)}</span><button class="copy-btn" data-copy="${esc(text)}" data-label="${esc(label || "字段")}">复制</button>`;
}

export function docShell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:12px;line-height:1.5}.page{max-width:860px;margin:24px auto;background:#fff;padding:34px 38px;box-shadow:0 8px 28px rgba(15,23,42,.08)}.top{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:20px}.seller h2{font-size:18px;margin:0 0 4px}.seller p,.muted{color:#555;margin:2px 0}.title{text-align:right}.title h1{font-size:24px;line-height:1.1;margin:0;font-weight:900}.title p{margin:6px 0 0;font-weight:700;color:#333}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}.box{border:1px solid #d7d7d7;padding:12px;background:#fff}.label{font-size:10px;font-weight:800;color:#555;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #e5e5e5;padding-bottom:5px;margin-bottom:8px}.field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0}.field b{color:#555;font-weight:700;min-width:96px}.field span:last-of-type{font-weight:700;text-align:right}.copy-btn{margin-left:6px;border:1px solid #bbb;background:#fff;color:#111;border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer}.copy-btn:hover{background:#f1f5f9}.ship{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #111;margin-bottom:18px}.ship div{padding:9px 10px;border-right:1px solid #111}.ship div:last-child{border-right:0}.ship b{display:block;font-size:10px;color:#555;margin-bottom:3px}table{width:100%;border-collapse:collapse;margin:12px 0 18px}th{background:#111;color:#fff;text-align:left;font-size:11px;padding:9px 8px}td{border-bottom:1px solid #e5e5e5;padding:9px 8px;vertical-align:top}.tc{text-align:center}.tr{text-align:right}.total td{border-top:2px solid #111;font-weight:900;background:#fafafa}.note{border:1px solid #111;padding:12px;line-height:1.8}.sign{display:flex;justify-content:space-between;margin-top:46px}.sign div{width:42%;border-top:1px solid #111;text-align:center;padding-top:8px;font-weight:800}.toast{position:fixed;right:18px;bottom:18px;background:#111;color:#fff;padding:8px 12px;border-radius:6px;opacity:0;transform:translateY(8px);transition:.18s}.toast.show{opacity:1;transform:translateY(0)}@media(max-width:720px){.page{margin:0;padding:22px}.top,.grid{grid-template-columns:1fr;display:grid}.title{text-align:left}.ship{grid-template-columns:1fr 1fr}.ship div{border-bottom:1px solid #111}.ship div:nth-child(2n){border-right:0}}@media print{body{background:#fff}.page{margin:0;max-width:none;box-shadow:none;padding:0}.copy-btn{display:none}.toast{display:none}}
</style></head><body><div class="page">${bodyHtml}</div><div class="toast" id="copyToast">已复制</div><script>
document.addEventListener("click",function(e){var b=e.target.closest(".copy-btn");if(!b)return;var v=b.getAttribute("data-copy")||"";var t=document.getElementById("copyToast");function done(){t.textContent=(b.getAttribute("data-label")||"字段")+"已复制";t.classList.add("show");setTimeout(function(){t.classList.remove("show")},1200)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(done).catch(done)}else{var ta=document.createElement("textarea");ta.value=v;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();done()}});
</script></body></html>`;
}

export function fmtDate(v) {
  if (!v) return "-";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

export function pick(...vals) {
  for (const v of vals) if (v !== null && v !== undefined && v !== "") return v;
  return "";
}
