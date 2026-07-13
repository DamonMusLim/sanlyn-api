// api/lib/bl-order-mirror.js — mirror shipping_plans.bl_no → orders.bl_no
// 根因修复: shipping_plans.bl_no 更新后从不同步到 orders.bl_no,导致 customs-collab
// 的 COALESCE(o.bl_no,'') <> '' 过滤器把订单挡掉。所有写 bl_no 的路径都应 await 这个
// helper。绝不 throw——调用点失败不能影响主请求。

// planRef: 行对象(含 id 或 _id) | 数字 id | _id 字符串
export async function mirrorPlanBlToOrders(pool, planRef, actor) {
  try {
    let id = null, _id = null;
    if (planRef && typeof planRef === "object") {
      id = planRef.id != null ? planRef.id : null;
      _id = planRef._id != null ? String(planRef._id) : null;
    } else if (typeof planRef === "number" || (typeof planRef === "string" && /^\d+$/.test(planRef))) {
      id = Number(planRef);
    } else if (planRef != null) {
      _id = String(planRef);
    }

    let planRow;
    if (id != null) {
      const r = await pool.query(
        "SELECT id, _id, bl_no, order_nos FROM shipping_plans WHERE id = $1", [id]);
      planRow = r.rows[0];
    } else if (_id) {
      const r = await pool.query(
        "SELECT id, _id, bl_no, order_nos FROM shipping_plans WHERE _id = $1", [_id]);
      planRow = r.rows[0];
    }
    if (!planRow) return { ok: false, error: "plan_not_found" };

    const bl = String(planRow.bl_no || "").trim();
    if (!bl) return { ok: true, skipped: "no_bl", updated: [] };

    const onos = (planRow.order_nos || []).map(x => String(x || "").trim()).filter(Boolean);

    // 精确 + 挂靠
    const exact = await pool.query(
      `SELECT id, order_no, bl_no FROM orders
        WHERE deleted_at IS NULL AND (order_no = ANY($1::text[]) OR shipping_plan_id = $2)`,
      [onos, planRow.id]);
    const targets = new Map(exact.rows.map(o => [o.id, o]));
    const matchedOnos = new Set(exact.rows.map(o => String(o.order_no || "").trim()).filter(Boolean));

    // 后缀容错(双向): 对没有精确命中的 ono 单独查
    const ambiguous = [];
    const unmatched = [];
    for (const ono of onos) {
      if (matchedOnos.has(ono)) continue;
      // LIKE 元字符转义: pattern 侧的值(方向1=ono,方向2=order_no)转义 %/_/\ 防通配符误伤
      const esc = ono.replace(/[\\%_]/g, m => "\\" + m);
      const r = await pool.query(
        `SELECT id, order_no, bl_no FROM orders
          WHERE deleted_at IS NULL
            AND (order_no LIKE ('%-' || $2) ESCAPE '\\'
                 OR $1 LIKE ('%-' || replace(replace(replace(order_no, '\\', '\\\\'), '%', '\\%'), '_', '\\_')) ESCAPE '\\')`,
        [ono, esc]);
      if (r.rows.length === 1) {
        targets.set(r.rows[0].id, r.rows[0]);
      } else if (r.rows.length > 1) {
        ambiguous.push({ ono, matches: r.rows.map(o => o.order_no) });
      } else {
        unmatched.push(ono);
      }
    }

    const toUpdate = [...targets.values()].filter(o => String(o.bl_no || "") !== bl).map(o => o.id);
    let updated = [];
    if (toUpdate.length) {
      const r = await pool.query(
        `UPDATE orders SET bl_no = $1, updated_at = now()
          WHERE id = ANY($2::int[]) AND bl_no IS DISTINCT FROM $1
          RETURNING order_no`,
        [bl, toUpdate]);
      updated = r.rows.map(o => o.order_no);
    }

    if (updated.length) {
      console.log("[bl-mirror] plan " + (planRow._id || planRow.id) + " BL " + bl + " -> orders: " + updated.join(","));
      pool.query(
        "INSERT INTO shipping_plan_audit (plan_id, plan_uid, action, actor, detail) VALUES ($1,$2,'bl_mirror',$3,$4::jsonb)",
        [planRow.id, planRow._id || null, actor || "system",
         JSON.stringify({ bl_no: bl, updated, ambiguous, unmatched })]
      ).catch(() => {});
    }

    return { ok: true, bl_no: bl, updated, ambiguous, unmatched };
  } catch (e) {
    console.warn("[bl-mirror]", e.message);
    return { ok: false, error: e.message };
  }
}
