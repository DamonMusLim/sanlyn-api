// templates/pl.js — PACKING LIST layout
// LOCKED 2026-06-17 v1.0
// chattr +i — 改版必须先: chattr -i pl.js → 改 → chattr +i pl.js → 告知团队
// Layout: docHdr → buyerBlock → portBar → product table (NW/GW/CBM) → sig
export function renderPL(d, h) {
  return h.wrap((d.ordNo||d.noPL)+"_PL", `
    ${h.docHdr(d.cfg,"装箱单","PACKING LIST",d.audience)}
    ${h.buyerBlock(d.cust,d.caddr,d.ctel,d.noPL,"NO",d.ordNo,d.date,d.curr)}
    <table><thead><tr><th style="width:36px">NO.</th>${d.colsPL.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
    <tbody>${h.productRows(d.prods,d.colsPL)}
    <tr class="total-row"><td colspan="2" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; TOTAL:</td><td style="text-align:center">${h.fmtM(d.tqty,0)}</td><td class="text-right">${h.fmtM(d.tnw)}</td><td class="text-right">${h.fmtM(d.tgw)}</td><td class="text-right">${h.fmtM(d.tcbmPL,3)}</td></tr>
    </tbody></table>
  `, d.ap);
}
