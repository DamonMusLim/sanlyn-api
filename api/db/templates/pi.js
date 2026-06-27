// templates/pi.js — PROFORMA INVOICE layout
// LOCKED 2026-06-18 v1.1
// ⛔ 品名字段: 固定只用 productName（商品英文名），禁止加报关品名字段
// 修改须走 forge + Damon 拍板
// chattr +i — 改版必须先: chattr -i pi.js → 改 → chattr +i pi.js → 告知团队
// Layout: docHdr → buyerBlock → product table → terms(SC 9条)+bank → sig
// v1.1: 删 portBar(港口/贸易条款栏); T&C 改用 terms.sc(9条) 替换 terms.iv(1条)
export function renderPI(d, h) {
  return h.wrap((d.ordNo||d.noPI)+"_PI", `
    ${h.docHdr(d.cfg,"","PROFORMA INVOICE")}
    ${h.buyerBlock(d.cust,d.caddr,d.ctel,d.noPI,"NO",d.ordNo,d.date,d.curr)}
    ${d.inco?`<div style="font-size:10px;margin:4px 0 8px;padding:3px 10px;background:#fafafa;border:1px solid #e0e0e0;border-radius:3px;color:#333;"><b>Terms:</b> ${h.esc(d.inco)}${d.pol&&d.pol!=='-'?' · '+h.esc(d.pol):''}</div>`:""}
    <table><thead><tr><th style="width:36px">NO.</th>${d.colsPI.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
    <tbody>${h.productRows(d.prods,d.colsPI)}${d.totRow}</tbody></table>
    <div class="details-grid">${h.termsCard(d.cfg.terms.sc)}${h.bankCard(d.cfg.bank,d.curr)}</div>${h.sigBlock(d._seal)}
  `, d.ap);
}

