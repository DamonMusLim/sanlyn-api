// recon-board 运费成本/销售价编辑(每柜价根治)。
// 根因:Damon 填的是每柜价,多柜票系统曾把它当总价存进 shipping_plans.freight_sale_usd。
// 修复:后端只接每柜价 + 柜数,当场算总价再存库;定位键强制 plan_uid(_id),绝不用 bl_no(有重复)。
import { parseBody, actorLabel } from "./recon-board-invoice-confirm.js";

const MAX_AMOUNT = 100000;
const MAX_QTY = 50;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 金额字段:null/空 = "不改该项,保持原值"。空字符串绝不当 0。
function normAmount(raw, label) {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { error: `${label}必须是数字` };
  if (num < 0 || num > MAX_AMOUNT) return { error: `${label}须在 0-${MAX_AMOUNT} 之间` };
  const rounded = round2(num);
  if (Math.abs(num - rounded) > 1e-9) return { error: `${label}最多2位小数` };
  return { value: rounded };
}

export function projectFreight(row) {
  return {
    plan_uid: row._id,
    bl_no: row.bl_no,
    cost_total: row.freight_cost == null ? null : Number(row.freight_cost),
    sale_total: row.freight_sale_usd == null ? null : Number(row.freight_sale_usd),
    container_qty: row.container_qty == null ? null : Number(row.container_qty),
    container_type: row.container_type || null,
  };
}

export async function editFreight(pool, req) {
  if (req.user?.role !== "admin") {
    return { status: 403, payload: { error: "forbidden", message: "仅管理员可编辑运费" } };
  }
  const body = parseBody(req.body);

  const costPerCtr = normAmount(body.freight_cost_per_ctr, "每柜成本");
  if (costPerCtr.error) return { status: 400, payload: { error: "bad_request", message: costPerCtr.error } };
  const salePerCtr = normAmount(body.freight_sale_per_ctr, "每柜销售价");
  if (salePerCtr.error) return { status: 400, payload: { error: "bad_request", message: salePerCtr.error } };

  if (body.container_qty === undefined || body.container_qty === null || body.container_qty === "") {
    return { status: 400, payload: { error: "bad_request", message: "柜数必须填写" } };
  }
  const qty = Number(body.container_qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return { status: 400, payload: { error: "bad_request", message: `柜数须为 1-${MAX_QTY} 的整数` } };
  }

  const containerType = body.container_type === undefined || body.container_type === null
    ? undefined // 未传该字段 = 不改
    : String(body.container_type).trim().slice(0, 20);

  let planUid = body.plan_uid != null ? String(body.plan_uid).trim() : "";
  const blNo = body.bl_no != null ? String(body.bl_no).trim() : "";
  if (!planUid && !blNo) {
    return { status: 400, payload: { error: "bad_request", message: "需提供 plan_uid 或 bl_no" } };
  }

  const actor = actorLabel(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (!planUid) {
      // 只给了 bl_no:先数命中,严禁一次改多票。
      const r = await client.query(
        `SELECT _id FROM shipping_plans WHERE bl_no=$1 AND deleted_at IS NULL`,
        [blNo]
      );
      if (r.rows.length === 0) {
        await client.query("ROLLBACK");
        return { status: 404, payload: { error: "not_found", message: "未找到该提单号对应的海运票" } };
      }
      if (r.rows.length > 1) {
        await client.query("ROLLBACK");
        return {
          status: 409,
          payload: {
            error: "ambiguous_bl",
            message: `该提单号对应 ${r.rows.length} 票,请用 plan_uid 精确定位`,
            candidates: r.rows.map(x => x._id),
          },
        };
      }
      planUid = r.rows[0]._id;
    }

    const oldR = await client.query(
      `SELECT _id, bl_no, freight_cost, freight_sale_usd, container_qty, container_type
         FROM shipping_plans WHERE _id=$1 FOR UPDATE`,
      [planUid]
    );
    if (!oldR.rows.length) {
      await client.query("ROLLBACK");
      return { status: 404, payload: { error: "not_found", message: "未找到该海运票(plan_uid)" } };
    }
    const old = oldR.rows[0];
    const oldQty = old.container_qty == null ? null : Number(old.container_qty);

    // P3:柜数变了但金额留空(=不改)→ 每柜价会被旧总价/新柜数悄悄改写,直接拒绝,不许静默发生。
    if (qty !== oldQty && (costPerCtr.value == null || salePerCtr.value == null)) {
      await client.query("ROLLBACK");
      return { status: 400, payload: { error: "bad_request", message: "柜数变了,每柜成本/每柜销售价必须一并确认(否则每柜价会被静默改写)" } };
    }

    const newCostTotal = costPerCtr.value == null ? (old.freight_cost == null ? null : Number(old.freight_cost)) : round2(costPerCtr.value * qty);
    const newSaleTotal = salePerCtr.value == null ? (old.freight_sale_usd == null ? null : Number(old.freight_sale_usd)) : round2(salePerCtr.value * qty);
    const newContainerType = containerType === undefined ? (old.container_type || null) : (containerType || null);

    // P2:只认"算出来的结果是否真的变了",别让重复点保存产生一条内容相同的噪音 audit。
    const oldCostTotal = old.freight_cost == null ? null : Number(old.freight_cost);
    const oldSaleTotal = old.freight_sale_usd == null ? null : Number(old.freight_sale_usd);
    const changed =
      newCostTotal !== oldCostTotal ||
      newSaleTotal !== oldSaleTotal ||
      oldQty !== qty ||
      (old.container_type || null) !== newContainerType;
    if (!changed) {
      await client.query("ROLLBACK");
      return { status: 400, payload: { error: "no_change", message: "无改动" } };
    }

    const upd = await client.query(
      `UPDATE shipping_plans
          SET freight_cost=$2, freight_sale_usd=$3, container_qty=$4, container_type=$5, updated_at=now()
        WHERE _id=$1
        RETURNING _id, bl_no, freight_cost, freight_sale_usd, container_qty, container_type`,
      [planUid, newCostTotal, newSaleTotal, qty, newContainerType]
    );

    const detail = {
      bl_no: old.bl_no,
      container_qty: { old: oldQty, new: qty },
      container_type: { old: old.container_type || null, new: newContainerType },
      freight_cost: { old: old.freight_cost == null ? null : Number(old.freight_cost), new: newCostTotal, per_ctr: costPerCtr.value },
      freight_sale_usd: { old: old.freight_sale_usd == null ? null : Number(old.freight_sale_usd), new: newSaleTotal, per_ctr: salePerCtr.value },
      note: "每柜价×柜数=总价",
    };
    await client.query(
      `INSERT INTO shipping_plan_audit (plan_id, plan_uid, action, actor, detail)
       VALUES ((SELECT id FROM shipping_plans WHERE _id=$1), $1, 'freight_edit', $2, $3::jsonb)`,
      [planUid, actor, JSON.stringify(detail)]
    );

    await client.query("COMMIT");
    return { status: 200, payload: { success: true, plan: projectFreight(upd.rows[0]) } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
