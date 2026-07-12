// containers_detail 写入规范器 — 防「订舱占位壳 + 真柜条目」并存导致柜数虚增
// 事故背景(2026-07-12, CY00376): 订舱时按 container_qty=4 存了 4 个
// {container_type:"40HQ"} 占位壳,后续录真柜(带 container_no)的调用方整包
// 覆盖时把 4 条真柜追加在壳后面,UI 按数组长度显示成 8 柜。
// 规则:
//  - 真柜条目 = container_no 非空;按柜号去重(后写的字段合并覆盖先写的)
//  - 占位壳 = 无 container_no;仅在真柜数不足 container_qty 时保留差额个
//  - 没有 container_qty 时:只要有真柜就不留壳
export function normalizeContainersDetail(detail, containerQty) {
  if (!Array.isArray(detail)) return detail; // null/非数组原样放行,不猜
  const reals = [];
  const byNo = new Map();
  const stubs = [];
  for (const e of detail) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const no = String(e.container_no || "").trim();
    if (no) {
      if (byNo.has(no)) Object.assign(byNo.get(no), e);
      else { const copy = { ...e }; byNo.set(no, copy); reals.push(copy); }
    } else {
      stubs.push(e);
    }
  }
  const qty = parseInt(containerQty, 10);
  const keepStubs = Number.isFinite(qty) && qty > 0
    ? Math.max(0, qty - reals.length)
    : (reals.length ? 0 : stubs.length);
  return reals.concat(stubs.slice(0, keepStubs));
}
