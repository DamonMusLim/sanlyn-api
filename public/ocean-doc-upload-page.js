const params = new URLSearchParams(location.search);
const KEY = params.get("k") || "";
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const fnameEl = document.getElementById("fname");
const submitBtn = document.getElementById("submit");
const resultEl = document.getElementById("result");
const jwtEl = document.getElementById("jwt");
const reviewEl = document.getElementById("review");
const allowedExts = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);
let pickedFiles = [];
let pendingRows = [];
let currentIntake = null;
let pollTimer = null;

jwtEl.value = sessionStorage.getItem("oceanDocReviewJwt") || "";
jwtEl.addEventListener("input", () => {
  sessionStorage.setItem("oceanDocReviewJwt", jwtEl.value.trim());
  if (jwtEl.value.trim()) startPolling();
});
if (jwtEl.value.trim()) startPolling();

function htmlEscape(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function showResult(kind, html) {
  resultEl.className = "result " + kind;
  resultEl.innerHTML = html;
}

function appendResultLine(kind, html) {
  if (!resultEl.className) resultEl.className = "result";
  if (kind === "err") resultEl.className = "result err";
  else if (kind === "dup" && !resultEl.className.includes("err")) resultEl.className = "result dup";
  else if (!resultEl.className.includes("err") && !resultEl.className.includes("dup")) resultEl.className = "result ok";
  const line = document.createElement("div");
  line.innerHTML = html;
  resultEl.appendChild(line);
}

function fileSizeLabel(file) {
  return file.size >= 1024 * 1024 ? (file.size / 1024 / 1024).toFixed(1) + " MB" : (file.size / 1024).toFixed(0) + " KB";
}

function validateFile(file) {
  if (file.size > 15 * 1024 * 1024) return file.name + "超过15MB，已跳过";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!allowedExts.has(ext)) return file.name + "格式不支持，已跳过";
  return "";
}

function renderFileList() {
  submitBtn.disabled = !pickedFiles.length;
  if (!pickedFiles.length) { fnameEl.innerHTML = ""; return; }
  fnameEl.innerHTML = `已选择${pickedFiles.length}个文件：` +
    `<ul style="margin:6px 0 0;padding-left:18px">${pickedFiles.map((f, idx) =>
      `<li>${htmlEscape(f.name)}（${fileSizeLabel(f)}） <a href="#" class="removeFile" data-idx="${idx}" style="color:#b91c1c;text-decoration:none">移除</a></li>`
    ).join("")}</ul>` +
    `<a href="#" id="clearFiles" style="font-size:12px;color:#64748b">清空重选</a>`;
  fnameEl.querySelectorAll(".removeFile").forEach(el => el.addEventListener("click", e => {
    e.preventDefault();
    pickedFiles.splice(Number(el.dataset.idx), 1);
    renderFileList();
  }));
  document.getElementById("clearFiles")?.addEventListener("click", e => {
    e.preventDefault();
    pickedFiles = [];
    renderFileList();
  });
}

function addFiles(files) {
  const skipped = [];
  files.forEach(file => {
    const error = validateFile(file);
    if (error) { skipped.push(error); return; }
    if (pickedFiles.some(f => f.name === file.name && f.size === file.size)) { skipped.push(file.name + " 已经选过了"); return; }
    pickedFiles.push(file);
  });
  renderFileList();
  resultEl.className = skipped.length ? "result err" : "";
  resultEl.innerHTML = skipped.map(htmlEscape).join("<br>");
}

fileInput.addEventListener("change", e => { addFiles([...e.target.files]); fileInput.value = ""; });
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => addFiles([...e.dataTransfer.files]));

function authHeaders() {
  const token = jwtEl.value.trim();
  return token ? { Authorization: "Bearer " + token } : {};
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadOneFile(file) {
  try {
    const b64 = await toBase64(file);
    const res = await fetch("/api/db/ocean-doc-upload?" + new URLSearchParams({ k: KEY }).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        data: b64,
        uploader: "web-upload",
        note: document.getElementById("note").value || ""
      })
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) return { ok: false, filename: file.name, error: json.error || res.status };
    return { ok: true, filename: file.name, duplicate: !!json.duplicate, id: json.id, existing: json.existing };
  } catch (e) {
    return { ok: false, filename: file.name, error: e.message };
  }
}

submitBtn.addEventListener("click", async () => {
  if (!pickedFiles.length) return;
  if (!KEY) { showResult("err", "链接缺少 ?k= 参数，无法上传。"); return; }
  submitBtn.disabled = true;
  submitBtn.textContent = "上传中...";
  resultEl.className = "result ok";
  resultEl.innerHTML = "";
  for (const file of pickedFiles) {
    appendResultLine("ok", htmlEscape(file.name) + "：上传中...");
    const last = resultEl.lastElementChild;
    const result = await uploadOneFile(file);
    if (!result.ok) {
      last.innerHTML = `${htmlEscape(result.filename)}：上传失败：${htmlEscape(result.error)}`;
      resultEl.className = "result err";
    } else if (result.duplicate) {
      last.innerHTML = `${htmlEscape(result.filename)}：之前传过了（登记时间：${htmlEscape(result.existing?.created_at || "—")}，状态：${htmlEscape(result.existing?.processing_status || "—")}）`;
      if (!resultEl.className.includes("err")) resultEl.className = "result dup";
    } else {
      last.innerHTML = `${htmlEscape(result.filename)}：上传成功，识别中（上传编号：${htmlEscape(result.id || "—")}）`;
    }
  }
  startPolling();
  pickedFiles = [];
  renderFileList();
  submitBtn.textContent = "上传";
});

function ensureReviewShell() {
  if (!document.getElementById("pendingList")) {
    reviewEl.innerHTML = '<div id="pendingList"></div><div id="reviewDetail"></div>';
  }
}

function keyLine(extracted) {
  const fields = ["bl_no", "container_no", "seal_no", "customs_no", "contract_no", "invoice_no", "booking_no", "customer"];
  return fields
    .map(k => extracted?.[k] ? `${k}: ${extracted[k]}` : "")
    .filter(Boolean)
    .join(" ｜ ") || "未提取到关键号";
}

function candidateTitle(c) {
  return `${c.shipment_no || "未绑定CY"} · ${c.customer || c.customer_cn || c.customer_en || "未知客户"}`;
}

function candidateDetail(c) {
  return `合同号：${(c.contract_nos || []).join(", ") || "—"} ｜ 订单：${(c.order_nos || []).join(", ") || "—"} ｜ BL：${c.bl_no || "—"} ｜ 柜号：${(c.container_nos || []).join(", ") || "—"}`;
}

function renderPendingList(rows) {
  ensureReviewShell();
  const el = document.getElementById("pendingList");
  if (!rows.length) {
    el.innerHTML = "<h2>等待确认</h2><div class=\"muted\">暂无待确认记录。</div>";
    return;
  }
  el.innerHTML = `<h2>待确认列表（${rows.length}）</h2>` + rows.map((row, idx) => `
    <div class="candidate">
      <div class="candidate-body">
        <strong>${htmlEscape(row.doc_type || "无法识别")} <span class="tag">${htmlEscape(row.confidence || "low")}</span></strong>
        <span class="muted">${htmlEscape(keyLine(row.extracted || {}))}</span>
        <span class="muted">候选：${htmlEscape((row.candidates || []).map(candidateTitle).join("；") || "无")}</span>
        <span class="muted">上传人：${htmlEscape(row.uploader || "—")} ｜ ${htmlEscape(row.created_at || "—")}</span>
      </div>
      <button type="button" class="reviewPick" data-idx="${idx}" style="width:112px;margin-top:0;padding:9px 10px;font-size:13px">确认</button>
    </div>`).join("");
  el.querySelectorAll(".reviewPick").forEach(btn => btn.addEventListener("click", () => renderReview(pendingRows[Number(btn.dataset.idx)])));
}

function renderReview(row) {
  currentIntake = row;
  ensureReviewShell();
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const one = candidates.length === 1;
  document.getElementById("reviewDetail").innerHTML = `
    <h2>确认归属</h2>
    <div class="grid">
      <div class="label">类型</div><div>${htmlEscape(row.doc_type || "—")} / ${htmlEscape(row.confidence || "—")}</div>
      <div class="label">关键号</div><div>${htmlEscape(keyLine(row.extracted || {}))}</div>
      <div class="label">摘要</div><div>${htmlEscape(row.extracted?.raw_text_summary || "—")}</div>
      <div class="label">文件</div><div>${htmlEscape(row.file_url || "—")}</div>
    </div>
    <div class="label">候选归属</div>
    <div>${candidates.length ? candidates.map((c, idx) => `
      <label class="candidate">
        <input type="radio" name="candidate" class="cand" data-idx="${idx}" ${one ? "checked" : ""}>
        <span class="candidate-body">
          <strong>${htmlEscape(candidateTitle(c))}<span class="tag">${htmlEscape(c.matched_by || "match")}</span></strong>
          <span class="muted">${htmlEscape(candidateDetail(c))}</span>
        </span>
      </label>`).join("") : '<div class="muted" style="margin:8px 0">系统未匹配到候选，请手动输入 shipping_plan_id 或 order_no。</div>'}</div>
    <input type="text" id="manualPlan" placeholder="手动 shipping_plan_id（候选为空或需修正时填写）">
    <input type="text" id="manualOrder" placeholder="手动 order_no（可选）">
    <textarea id="confirmNote" placeholder="确认备注（选填）"></textarea>
    <div class="actions"><button id="confirmBtn">确认归属</button><button id="rejectBtn" class="danger">驳回</button></div>`;
  document.getElementById("confirmBtn").onclick = confirmIntake;
  document.getElementById("rejectBtn").onclick = rejectIntake;
}

async function fetchPending() {
  if (!jwtEl.value.trim()) {
    ensureReviewShell();
    document.getElementById("pendingList").innerHTML = "<h2>等待确认</h2><div class=\"muted\">请先粘贴内部 JWT token。</div>";
    return;
  }
  const res = await fetch("/api/db/ocean-doc-review?action=pending", { headers: authHeaders() });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error || res.status);
  pendingRows = Array.isArray(json.rows) ? json.rows : [];
  renderPendingList(pendingRows);
}

function startPolling() {
  if (pollTimer || !jwtEl.value.trim()) return;
  fetchPending().catch(e => showResult("err", "读取待确认列表失败：" + htmlEscape(e.message)));
  pollTimer = setInterval(() => fetchPending().catch(() => {}), 3000);
}

async function refreshAfterReview() {
  currentIntake = null;
  document.getElementById("reviewDetail").innerHTML = "";
  await fetchPending().catch(e => showResult("err", "刷新失败：" + htmlEscape(e.message)));
}

function selectedCandidate() {
  const checked = document.querySelector(".cand:checked");
  if (!checked || !currentIntake) return null;
  return (currentIntake.candidates || [])[Number(checked.dataset.idx)] || null;
}

async function confirmIntake() {
  const c = selectedCandidate();
  const manualPlan = document.getElementById("manualPlan").value.trim();
  const manualOrder = document.getElementById("manualOrder").value.trim();
  const body = {
    intake_id: currentIntake?.id,
    matched_shipping_plan_id: manualPlan || c?.shipping_plan_id || null,
    matched_order_no: manualOrder || c?.order_nos?.[0] || null,
    note: document.getElementById("confirmNote").value.trim()
  };
  if (!body.matched_shipping_plan_id && !body.matched_order_no) {
    showResult("err", "请选择候选或手动输入归属。");
    return;
  }
  const res = await fetch("/api/db/ocean-doc-review?action=confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) { showResult("err", "确认失败：" + htmlEscape(json.error || res.status)); return; }
  showResult("ok", "已确认归属。");
  await refreshAfterReview();
}

async function rejectIntake() {
  const res = await fetch("/api/db/ocean-doc-review?action=reject", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ intake_id: currentIntake?.id, reason: "user rejected on ocean doc page" })
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) { showResult("err", "驳回失败：" + htmlEscape(json.error || res.status)); return; }
  showResult("ok", "已驳回。");
  await refreshAfterReview();
}
