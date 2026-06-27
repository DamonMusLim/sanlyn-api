// templates/iv.js — COMMERCIAL INVOICE layout
// LOCKED 2026-06-17 v1.0
// chattr +i — 改版必须先: chattr -i iv.js → 改 → chattr +i iv.js → 告知团队
// Layout: docHdr → buyerBlock → portBar → product table → terms+bank → sig
export function renderIV(d, h) {
  return h.wrap((d.ordNo||d.noIV)+"_IV", `
    ${h.docHdr(d.cfg,"商业发票","COMMERCIAL INVOICE",d.audience)}
    ${h.buyerBlock(d.cust,d.caddr,d.ctel,d.noIV,"NO",d.ordNo,d.date,d.curr)}
    <table><thead><tr><th style="width:36px">NO.</th>${d.colsIV.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
    <tbody>${h.productRows(d.prods,d.colsIV)}${d.totRow}</tbody></table>
    <div class="details-grid">${h.termsCard(d.cfg.terms.iv)}${h.bankCard(d.cfg.bank,d.curr)}</div>
  `, d.ap);
}
