// api/lib/audit-actor.js
// 在同一事务里注入审计 actor/source 再跑写 orders 的语句。热点交互路径用它包住 UPDATE,
// 让 orders 上的 trg_orders_field_audit 触发器把「谁/哪条路径」记进 order_field_changes。
//
// 铁律(deep-reasoner 审):
//   * set_config 第三参 true = 事务级(is_local),COMMIT/ROLLBACK 即清,绝不串到别的请求。
//     禁用 SET(session 级)/ set_config(...,false) —— 连接池复用下会静默串味。
//   * fn 必须用回调里的 client 跑写入,不能用外层 pool —— 否则不在同一事务,GUC 失效,actor 记不到。
export async function withAuditActor(pool, { actor, source }, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('sanlyn.actor',$1,true), set_config('sanlyn.source',$2,true)",
      [actor || "", source || ""]
    );
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
