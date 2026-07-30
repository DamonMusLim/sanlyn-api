// 内部提醒 Damon 走微信服务号模板消息(push-card, 最正规, 无 48h 窗口/无条数限)。
// 服务号服务 = 本机 wechat-mp-push :3791; token 从 env MP_NOTIFY_TOKEN(server .env, 绝不进 git)。
// 铁律: 通知是旁路, 发送失败绝不阻断业务; 无 token = 静默跳过(不报错)。
const PUSH_URL = process.env.MP_PUSH_URL || "http://127.0.0.1:3791/push-card";
const TOKEN = process.env.MP_NOTIFY_TOKEN || "";

// 服务号模板字段约束(单据待审批提醒卡片)：
//   title→thing1 / applicant→thing6 均 ≤20 字；deadline→time14 必须合法日期(否则微信 47003 拒发)。
function todaySGT() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // CST/SGT 当天
}

// route-to-taskcenter(2026-07-26 Damon定):业务事件不直推Damon,进任务中心派专责(玛雅);只urgency=紧急才推微信
async function registerTask({ title, applicant, url }) {
  try {
    const { getPool } = await import("../pool.js").catch(() => ({ getPool: null }));
    let pool = null;
    if (getPool) pool = getPool();
    if (!pool) { const pg = await import("pg"); pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL || "postgres://sanlyn_admin:Snlnb7f92c74d6fbaa8b97b0379b@127.0.0.1:5432/sanlyn_db" }); }
    const id = ("clb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 32);
    await pool.query(
      `INSERT INTO tasks (id,title,status,mode,source,priority,domain,task_type,level,current_holder,current_holder_role,relay_path,reason,notify_stage,created_at)
       VALUES ($1,$2,'open','owned','collab-event','P2','freight','协同回件','L1','玛雅','海运订舱','玛雅·海运订舱',$3,99,now()) ON CONFLICT (id) DO NOTHING`,
      [id, String(title || "").slice(0, 180) + " · " + String(applicant || "").slice(0, 16), String(url || "").slice(0, 500)]);
    return { ok: true, task: id };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function notifyDamonCard({ title, applicant = "", urgency = "普通", deadline = "", count = 1, url = "" } = {}) {
  // 非紧急业务事件 → 只进任务中心,不打扰Damon
  if (String(urgency) !== "紧急") return registerTask({ title, applicant, url });
  if (!TOKEN) return { ok: false, skipped: "MP_NOTIFY_TOKEN 未配置" };
  // deadline 只接受合法日期(YYYY-MM-DD[...])，否则填今天，绝不把业务文字塞进 time14
  const dl = /^\d{4}-\d{2}-\d{2}/.test(String(deadline || "")) ? String(deadline).slice(0, 19) : todaySGT();
  try {
    const r = await fetch(PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-notify-token": TOKEN },
      body: JSON.stringify({
        to: "damon",
        title: String(title || "").slice(0, 20),
        applicant: String(applicant || "").slice(0, 20),
        urgency: String(urgency || "普通").slice(0, 10),
        deadline: dl,
        count: Number(count) || 1,
        url: String(url || "").slice(0, 300),
      }),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.ok !== false, resp: d };
  } catch (e) {
    console.warn("[notify-damon] push-card 失败(不阻断业务):", e.message);
    return { ok: false, error: e.message };
  }
}
