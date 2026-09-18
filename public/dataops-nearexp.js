(function () {
  var state = { tab: "plan", data: null, selected: {} };

  var SOP = {
    plan:
      "一、折扣计划 v5\n\n" +
      ">150 天:不打折\n121-150 天:8 折\n91-120 天:7 折\n61-90 天:5 折\n31-60 天:3 折\n15-30 天:2 折\n4-14 天:1 折,最低 1 元\n≤3 天:1 元清 / 买1送2 / 会员满额送\n已过期:下架报损(报损要 Damon 批)\n\n" +
      "时间加速:进档 3 天 0 销量 → 降一档;每档最多停 7 天(库存>20件最多 5 天,大袋主粮最多 3 天)。\n" +
      "基数:真实正常售价(近期非临期成交价/当前正常价);不用官方价、没真卖过的划线价。不用进价托底。",
    sop:
      "四、谁做什么(SOP)\n\n" +
      "店员(每天)\n1. 收到「拍日期」单 → 每个品拍一张日期+批号同框特写,上传。不用自己读日期、不用判断。\n2. 收到「换签挪区」单 → 把新价签贴上,货挪到门口临期区对应的 0-原货位,点完成。\n3. 发现实物过期/破损 → 直接下架放报损筐,拍照上报。\n4. 外卖拣货:正价单只从原货位拿,不从 0- 临期区拿。\n\n" +
      "Damon(每天 1 次,约 2 分钟)\n1. 打开工作台「临期清仓」页 → 看「今日改价清单」→ 勾选批准。\n2. 看标红项(照片对不上/看不清)→ 看照片定。\n3. 报损单批准。\n\n" +
      "Claude(系统,全自动)\n同步 → 分档 → 派拍照单 → 读图比对 → 出清单 → 执行已批 → 回读 → 打签 → 派换签单 → 报告。不替 Damon 批价、不替店员读实物、不在日期没核时打折。",
    guard:
      "五、护栏\n\n" +
      "日期必须照片核过才打折:顽皮冻干狗粮系统录 2025-01-18(10→01)判已过期,照片是 2025.10.18。\n" +
      "不用进价托底:汪爸爸进价=售价55(脏)被托底卡 27.5,自动打折一分没降。\n" +
      "降价执行前 Damon 批:07-02 机器不看日期见货就打,343 乱打、141 亏本。\n" +
      "价签「临期特价」只在真降价后打:原价+「特价」字样=虚假标价。\n" +
      "条码只取系统值:0918 样张条码被手填,发出前拦下。\n" +
      "同图读两遍,不一致判不确定:药盒同图三读出两种药。"
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function money(v) {
    if (v == null || v === "") return "";
    var n = Number(v);
    return isFinite(n) ? n.toFixed(1).replace(/\.0$/, "") : esc(v);
  }

  function authHeaders() {
    var tk = "";
    try { tk = localStorage.getItem("jdc_token") || localStorage.getItem("token") || ""; } catch (e) {}
    var hd = {
      "accept": "application/json",
      "content-type": "application/json",
      "x-gateway-auth": "gw-dataops-0903"
    };
    if (tk) hd.Authorization = tk.indexOf("Bearer") === 0 ? tk : ("Bearer " + tk);
    return hd;
  }

  async function postAct(body) {
    var r = await fetch(API + "db/petstore-nearexp-act", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(body)
    });
    var j = await r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
    if (!j.ok) throw new Error(j.error || "操作失败");
    return j;
  }

  async function load() {
    state.data = await get("db/petstore-nearexp");
    return state.data;
  }

  function tabs() {
    var a = [["plan", "折扣计划"], ["today", "今日临期"], ["sop", "SOP"]];
    return '<div class="tabs">' + a.map(function (x) {
      return '<button class="tab ' + (state.tab === x[0] ? "on" : "") + '" data-ne-tab="' + x[0] + '">' + x[1] + "</button>";
    }).join("") + "</div>";
  }

  function cards() {
    var rows = (state.data && state.data.summary) || [];
    if (!rows.length) return '<div class="muted">今日暂无临期改价清单</div>';
    return '<div class="cards">' + rows.map(function (r) {
      return '<div class="card"><div class="k">' + esc(r.tier_label || "未分档") + '</div><div class="v">' +
        esc(r.product_count) + '品 / ' + money(r.stock_count) + '件</div><div class="s">建议金额 ' + money(r.amount) + '</div></div>';
    }).join("") + "</div>";
  }

  function selectedIds() {
    return Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
  }

  function today() {
    var rows = (state.data && state.data.proposals) || [];
    return cards() + '<div class="bar">' +
      '<button data-ne-act="verify_date">我已核对日期</button>' +
      '<button data-ne-act="approve">批准所选</button>' +
      '<button data-ne-act="reject">驳回所选</button>' +
      '<span class="muted">未核日期不能批准</span></div>' +
      '<table class="tbl"><thead><tr><th></th><th>商品</th><th>规格</th><th>货位</th><th>剩余</th><th>档位</th><th>价格</th><th>日期</th><th>状态</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var selectable = r.status === "proposed" || r.status === "approved";
        var cls = !r.date_verified ? "dim" : "";
        return '<tr class="' + cls + '"><td><input type="checkbox" data-ne-id="' + r.id + '"' +
          (state.selected[r.id] ? " checked" : "") + (selectable ? "" : " disabled") + '></td><td><b>' +
          esc(r.product_name) + '</b><div class="muted">' + esc(r.product_code) + '</div></td><td>' +
          esc(r.spec) + '</td><td>' + esc(r.orig_shelf || "") + ' → ' + esc(r.nearexp_shelf || "") + '</td><td>' +
          esc(r.days_left) + '天</td><td>' + esc(r.tier_label) + '</td><td>' +
          money(r.current_price) + ' → <b>' + money(r.suggest_price) + '</b></td><td>' +
          (r.date_verified ? "已核" : "待核") + '</td><td>' + esc(r.status) + '</td></tr>';
      }).join("") + "</tbody></table>";
  }

  function plan() {
    var rows = (state.data && state.data.plan) || [];
    return '<table class="tbl"><thead><tr><th>距到期</th><th>折扣</th><th>说明</th><th></th></tr></thead><tbody>' +
      rows.map(function (r) {
        var range = (r.max_days == null ? ">" + (Number(r.min_days) - 1) : r.min_days + "-" + r.max_days) + " 天";
        if (Number(r.max_days) === -1) range = "已过期";
        if (Number(r.min_days) === 0 && Number(r.max_days) === 3) range = "≤3 天";
        return '<tr><td>' + esc(range) + '</td><td><input class="inp" data-rate="' + r.id + '" value="' +
          esc(r.rate == null ? "" : r.rate) + '" placeholder="空"></td><td><input class="inp wide" data-rule="' +
          r.id + '" value="' + esc(r.rule_text) + '"></td><td><button data-ne-save="' + r.id + '">保存</button></td></tr>';
      }).join("") + "</tbody></table>";
  }

  function sop() {
    return '<div class="doc"><pre>' + esc(SOP.plan + "\n\n" + SOP.sop + "\n\n" + SOP.guard) + "</pre></div>";
  }

  function draw(host) {
    var html = '<section class="panel"><div class="row"><h2>临期清仓</h2><span class="muted">v2026.09.18-2 · ' +
      esc((state.data && state.data.generated_at) || "") + "</span></div>" + tabs();
    html += state.tab === "plan" ? plan() : state.tab === "sop" ? sop() : today();
    host.innerHTML = html + "</section>";
  }

  async function refresh(host) {
    await load();
    draw(host);
  }

  window.__nearexpOnClick && document.removeEventListener("click", window.__nearexpOnClick);
  window.__nearexpOnClick = async function (ev) {
    var t = ev.target;
    var root = t.closest("[data-nearexp-root]");
    if (!root) return;
    var tab = t.closest("[data-ne-tab]");
    if (tab) {
      state.tab = tab.getAttribute("data-ne-tab");
      draw(root);
      return;
    }
    var box = t.closest("[data-ne-id]");
    if (box) {
      state.selected[box.getAttribute("data-ne-id")] = box.checked;
      return;
    }
    var save = t.closest("[data-ne-save]");
    if (save) {
      var id = save.getAttribute("data-ne-save");
      await postAct({
        action: "plan_update",
        id: id,
        rate: root.querySelector('[data-rate="' + id + '"]').value.trim(),
        rule_text: root.querySelector('[data-rule="' + id + '"]').value.trim()
      });
      await refresh(root);
      return;
    }
    var act = t.closest("[data-ne-act]");
    if (act) {
      var ids = selectedIds();
      if (!ids.length) return alert("先勾选要处理的商品");
      await postAct({ action: act.getAttribute("data-ne-act"), ids: ids });
      state.selected = {};
      await refresh(root);
    }
  };
  document.addEventListener("click", window.__nearexpOnClick);

  window.NEAREXP = {
    render: async function (host) {
      if (!host) return;
      host.setAttribute("data-nearexp-root", "1");
      await refresh(host);
    }
  };
})();
