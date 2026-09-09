// 写操作模块闸 · 0903。⚠️ 任何【写】接口必须先过这里。
//
// 🔴 为什么要有它:今天做完 15 个模块,read_only 态只在读接口返回 writable:false,
//    但那只是【告诉前端】—— 前端按钮禁不禁用是前端的事,接口照样能 POST。
//    等寄养/次卡/诊疗的写口一建,就会出现「界面上禁用了但 curl 能写」。
//    审查(codex 第9条)也点了这一条。
//
// 五态里能写的【只有 enabled】:
//   enabled    可读可写
//   read_only  只读 —— 客户不续费了,历史可查可导出,⛔禁新增/修改/删除
//   suspended  欠费风控暂停 —— 同只读
//   disabled   没开通 —— 连读都 403
//   retired    平台下线 —— 同只读
//
// ⚠️ 病历/处方这类【有法定保存年限】的,read_only 下也不许删 —— 这个闸就是最后一道。
import { getPool } from "./db.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 用法(放在 requireAuth 之后、动数据之前):
 *   const gate = await requireWritable(req, res, "medical");
 *   if (!gate) return;                 // 已经替你 403 了,直接 return
 *   // ... 往下写数据
 */
export async function requireWritable(req, res, moduleCode, storeCodeInput) {
  const storeCode = String(storeCodeInput || req.query?.storeCode || req.body?.storeCode || "63350001").slice(0, 32);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements WHERE store_code=$1 AND module_code=$2`,
    [storeCode, moduleCode]
  );
  const status = rows[0]?.status || "disabled";

  if (status === "disabled") {
    res.status(403).json({ error: "module_disabled", module: moduleCode,
      message: "这个模块没有开通" });
    return null;
  }
  if (WRITE_METHODS.has(req.method) && status !== "enabled") {
    // 🔴 人话:客户看到「只读」要知道为什么、以及数据还在
    const why = {
      read_only: "模块已转为只读,历史数据仍可查看和导出,但不能新增或修改",
      suspended: "模块已暂停(欠费或风控),历史数据仍在,恢复后可继续使用",
      retired: "该模块已下线,历史数据仍可查看和导出",
    }[status] || "当前状态不允许写入";
    res.status(403).json({ error: "module_read_only", module: moduleCode, status, message: why });
    return null;
  }
  return { storeCode, status, writable: status === "enabled" };
}

// 读接口用这个(disabled 拦住,其余放行并告诉前端能不能写)
export async function requireVisible(req, res, moduleCode, storeCodeInput) {
  const storeCode = String(storeCodeInput || req.query?.storeCode || "63350001").slice(0, 32);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT status::text FROM tenant_module_entitlements WHERE store_code=$1 AND module_code=$2`,
    [storeCode, moduleCode]
  );
  const status = rows[0]?.status || "disabled";
  if (status === "disabled") {
    res.status(403).json({ error: "module_disabled", module: moduleCode });
    return null;
  }
  return { storeCode, status, writable: status === "enabled" };
}
