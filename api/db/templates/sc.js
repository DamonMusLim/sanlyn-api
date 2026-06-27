// templates/sc.js — SALES CONTRACT layout
// LOCKED 2026-06-17 v1.0
// chattr +i — 改版必须先: chattr -i sc.js → 改 → chattr +i sc.js → 告知团队
// Layout: docHdr → buyerBlock → portBar → product table → terms+bank → sig
export function renderSC(d, h) {
  return h.wrap((d.ordNo||d.no)+"_SC", `
    ${h.docHdr(d.cfg,"销售合同","SALES CONTRACT",d.audience)}
    ${h.buyerBlock(d.cust,d.caddr,d.ctel,d.no,"NO",d.ordNo,d.date,d.curr)}
    <table><thead><tr><th style="width:36px">NO.</th>${d.colsSC.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
    <tbody>${h.productRows(d.prods,d.colsSC)}${d.totRow}</tbody></table>
    <div class="details-grid">${h.termsCard(d.cfg.terms.sc)}${h.bankCard(d.cfg.bank,d.curr)}</div>
  `, d.ap);
}
