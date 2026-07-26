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

export async function notifyDamonCard({ title, applicant = "", urgency = "普通", deadline = "", count = 1, url = "" } = {}) {
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
