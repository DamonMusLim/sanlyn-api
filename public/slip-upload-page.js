const params = new URLSearchParams(location.search);
const KEY = params.get('k') || '';
const IS_STAFF = params.get('staff') === '1';
const CUSTOMER = (params.get('customer') || '').trim();
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const fnameEl = document.getElementById('fname');
const submitBtn = document.getElementById('submit');
const resultEl = document.getElementById('result');
const reviewEl = document.getElementById('review');
const staffTokenEl = document.getElementById('staffToken');
const jwtEl = document.getElementById('jwt');
const customerSearchEl = document.getElementById('customerSearch');
const customerQEl = document.getElementById('customerQ');
const customerSearchBtn = document.getElementById('customerSearchBtn');
const customerListEl = document.getElementById('customerList');
const allowedExts = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp']);
let pickedFiles = [];
let pollTimer = null;
let currentSlip = null;
let pendingRows = [];

staffTokenEl.style.display = IS_STAFF ? 'block' : 'none';
if (IS_STAFF) {
  jwtEl.value = sessionStorage.getItem('slipReviewJwt') || '';
  jwtEl.addEventListener('input', () => {
    sessionStorage.setItem('slipReviewJwt', jwtEl.value.trim());
    if (jwtEl.value.trim()) startPolling();
  });
}
if (CUSTOMER) customerSearchEl.style.display = 'block';

function htmlEscape(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showResult(kind, html) {
  resultEl.className = 'result ' + kind;
  resultEl.innerHTML = html;
}

function appendResultLine(kind, html) {
  if (!resultEl.className) resultEl.className = 'result';
  if (kind === 'err') resultEl.className = 'result err';
  else if (kind === 'dup' && !resultEl.className.includes('err')) resultEl.className = 'result dup';
  else if (!resultEl.className.includes('err') && !resultEl.className.includes('dup')) resultEl.className = 'result ok';
  const line = document.createElement('div');
  line.innerHTML = html;
  resultEl.appendChild(line);
}

function fileSizeLabel(file) {
  return file.size >= 1024 * 1024
    ? (file.size / 1024 / 1024).toFixed(1) + ' MB'
    : (file.size / 1024).toFixed(0) + ' KB';
}

function validateFile(file) {
  if (file.size > 15 * 1024 * 1024) return file.name + '超过15MB，已跳过';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!allowedExts.has(ext)) return file.name + '格式不支持，已跳过';
  return '';
}

function renderFileList() {
  submitBtn.disabled = !pickedFiles.length;
  if (!pickedFiles.length) { fnameEl.innerHTML = ''; return; }
  fnameEl.innerHTML = `已选择${pickedFiles.length}个文件（可继续一张一张拖加进来）：` +
    `<ul style="margin:6px 0 0;padding-left:18px">${pickedFiles.map((f, idx) =>
      `<li>${htmlEscape(f.name)}（${fileSizeLabel(f)}） <a href="#" class="removeFile" data-idx="${idx}" style="color:#dc2626;text-decoration:none">移除</a></li>`
    ).join('')}</ul>` +
    `<a href="#" id="clearFiles" style="font-size:12px;color:#64748b">清空重选</a>`;
  fnameEl.querySelectorAll('.removeFile').forEach(el => el.addEventListener('click', e => {
    e.preventDefault();
    pickedFiles.splice(Number(el.dataset.idx), 1);
    renderFileList();
  }));
  const clearBtn = document.getElementById('clearFiles');
  if (clearBtn) clearBtn.addEventListener('click', e => { e.preventDefault(); pickedFiles = []; renderFileList(); });
}

function addFiles(files) {
  const skipped = [];
  files.forEach(file => {
    const error = validateFile(file);
    if (error) { skipped.push(error); return; }
    const dupe = pickedFiles.some(f => f.name === file.name && f.size === file.size);
    if (dupe) { skipped.push(file.name + ' 已经选过了'); return; }
    pickedFiles.push(file);
  });
  renderFileList();
  resultEl.className = '';
  resultEl.innerHTML = skipped.map(htmlEscape).join('<br>');
  if (skipped.length) resultEl.className = 'result err';
}

fileInput.addEventListener('change', e => { addFiles([...e.target.files]); fileInput.value = ''; });
['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));

function authHeaders() {
  if (!IS_STAFF) return {};
  const token = jwtEl.value.trim();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function allocationFromText(text, amount) {
  const value = text.trim();
  if (/^CY\d+$/i.test(value)) return { shipment_no: value.toUpperCase(), amount_alloc: amount };
  if (/^FS/i.test(value)) return { contract_no: value, amount_alloc: amount };
  return { order_no: value, amount_alloc: amount };
}

function moneyNumber(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(v) {
  return (Math.round(v * 100) / 100).toFixed(2);
}

function amountInputValue(input) {
  if (!input || input.value === '') return null;
  const n = Number(input.value);
  return Number.isFinite(n) ? formatMoney(n) : null;
}

function selectedAllocationRows() {
  const rows = [...document.querySelectorAll('.cand:checked')].map(el => ({
    input: document.querySelector(`.alloc-amount[data-kind="candidate"][data-idx="${el.dataset.idx}"]`),
    freight: moneyNumber(JSON.parse(el.dataset.json).freight_total_cny)
  }));
  SlipManual.rows().forEach(r => { if (r.ref) rows.push({ input: r.amountInput, freight: 0 }); });
  return rows.filter(r => r.input);
}

function recalcAllocations(resetTouched = false) {
  const total = moneyNumber(currentSlip?.amount);
  const hint = document.getElementById('allocHint');
  document.querySelectorAll('.alloc-amount').forEach(input => {
    const isManual = input.id === 'manualAmount';
    const enabled = isManual
      ? !!document.getElementById('manualRef')?.value.trim()
      : !!document.querySelector(`.cand[data-idx="${input.dataset.idx}"]`)?.checked;
    input.disabled = !enabled;
    if (!enabled) input.value = '';
    if (resetTouched) delete input.dataset.touched;
  });
  const rows = selectedAllocationRows();
  if (!rows.length || !total) { if (hint) hint.textContent = ''; return; }
  if (rows.length === 1) {
    const only = rows[0].input;
    if (!only.dataset.touched) only.value = formatMoney(total);
    only.placeholder = '';
    if (hint) hint.textContent = '';
    return;
  }
  const validRows = rows.filter(r => r.freight > 0);
  const missingRows = rows.filter(r => !(r.freight > 0));
  const validSum = validRows.reduce((sum, r) => sum + r.freight, 0);
  let allocated = 0;
  const allocBase = missingRows.length ? Math.min(total, validSum) : total;
  validRows.forEach((row, i) => {
    if (row.input.dataset.touched) return;
    const value = i === validRows.length - 1 ? allocBase - allocated : Math.round((allocBase * row.freight / validSum) * 100) / 100;
    allocated += value;
    row.input.value = formatMoney(Math.max(0, value));
    row.input.placeholder = '';
  });
  missingRows.forEach(row => {
    if (!row.input.dataset.touched) row.input.value = '';
    row.input.placeholder = '该票报价缺失,请手动填金额';
  });
  if (hint) {
    const rest = Math.max(0, total - allocBase);
    hint.textContent = missingRows.length ? `其余¥${formatMoney(rest)}请手动分给缺报价的票` : '';
  }
}

function candidateCustomers(candidates) {
  const seen = new Set();
  const names = [];
  candidates.forEach(c => [c.customer, c.customer_cn, c.customer_en].forEach(name => {
    const v = String(name || '').trim();
    const key = v.toUpperCase();
    if (v && !seen.has(key)) { seen.add(key); names.push(v); }
  }));
  return names.join(' / ') || '—';
}

function selectedCustomerShipments() {
  return [...document.querySelectorAll('.customer-cand:checked')].map(el => el.value).filter(Boolean);
}

function renderCustomerResults(rows) {
  if (!rows.length) {
    customerListEl.innerHTML = '<div class="muted">没找到该客户名下匹配的票，可直接上传。</div>';
    return;
  }
  customerListEl.innerHTML = rows.map((c, idx) => `
    <label class="candidate">
      <input type="checkbox" class="customer-cand" value="${htmlEscape(c.shipment_no || '')}" ${idx === 0 && rows.length === 1 ? 'checked' : ''}>
      <span class="candidate-body">
        <strong>${htmlEscape(c.shipment_no || '—')} · ${htmlEscape(c.customer || '未知客户')}</strong>
        <span class="muted">合同号：${htmlEscape((c.contract_nos || []).join(', ') || '—')} ｜ 订单：${htmlEscape((c.order_nos || []).join(', ') || '—')} ｜ BL：${htmlEscape(c.bl_no || '—')}</span>
      </span>
    </label>`).join('');
}

async function searchCustomerShipments() {
  if (!CUSTOMER) return;
  if (!KEY) { showResult('err', '链接缺少 ?k= 参数，无法搜索订单'); return; }
  customerSearchBtn.disabled = true;
  customerSearchBtn.textContent = '搜索中';
  try {
    const qs = new URLSearchParams({ action: 'search', k: KEY, customer: CUSTOMER, q: customerQEl.value.trim() });
    const res = await fetch('/api/db/slip-customer-search?' + qs.toString());
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error || res.status);
    renderCustomerResults(Array.isArray(json.rows) ? json.rows : []);
  } catch (e) {
    customerListEl.innerHTML = '<div class="muted">搜索失败：' + htmlEscape(e.message) + '</div>';
  } finally {
    customerSearchBtn.disabled = false;
    customerSearchBtn.textContent = '搜索';
  }
}

function findingMessages(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter(f => f && f.severity !== 'low')
    .map(f => `<li>${htmlEscape(f.message || f.rule || '审核异常')}（${htmlEscape(f.severity || '')}）</li>`)
    .join('') || '<li>审核已记录，无需人工二次处理。</li>';
}

function ensureReviewShell() {
  reviewEl.style.display = 'block';
  if (!document.getElementById('pendingList')) {
    reviewEl.innerHTML = '<div id="pendingList"></div><div id="reviewDetail"></div>';
  }
}

function candidateSummary(row) {
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  if (!candidates.length) return '<span style="color:#b45309">未匹配到候选票，需人工手动关联</span>';
  const companies = [...new Set(candidates.map(c => c.customer || c.customer_cn || c.customer_en).filter(Boolean))];
  const tickets = candidates.map(c => c.shipment_no).filter(Boolean);
  const companyLabel = companies.length ? companies.join(' / ') : '未知公司';
  const ticketLabel = tickets.length ? tickets.join('、') : '—';
  const multi = candidates.length > 1 ? `<span class="source-tag" style="background:#fef3c7;color:#92400e">${candidates.length}个候选</span>` : '';
  return `${htmlEscape(companyLabel)} ｜ 票号：${htmlEscape(ticketLabel)} ${multi}`;
}

function uploadStatusText(s) { if (s.status === 'failed') return '❌识别失败：' + htmlEscape(s.error || '识别失败，请联系客服核实'); if (s.status === 'matched' || s.status === 'no_match') return `✅识别完成：${htmlEscape(s.amount ?? '—')} ${htmlEscape(s.currency || '')}，汇款人：${htmlEscape(s.sender_name || '—')}，匹配：${candidateSummary(s)}`; return '请稍等，正在识别…'; }
async function waitUploadStatus(id, line, filename) {
  if (!id) return; for (let i = 0; i < 45; i++) {
    await new Promise(resolve => setTimeout(resolve, i ? 2000 : 800));
    const qs = new URLSearchParams({ action: 'status', k: KEY, id: String(id) });
    const res = await fetch('/api/db/slip-upload?' + qs.toString()); const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error || res.status);
    line.innerHTML = `${htmlEscape(filename)}：${uploadStatusText(json)}`;
    if (json.status === 'failed') resultEl.className = 'result err'; if (json.status !== 'processing') return; }
  line.innerHTML = `${htmlEscape(filename)}：请稍等，正在识别…`; }

function renderPendingList(rows) {
  ensureReviewShell();
  const pendingList = document.getElementById('pendingList');
  if (!rows.length) {
    pendingList.innerHTML = '<h2>等待确认</h2><div class="muted">暂无待确认记录。</div>';
    return;
  }
  pendingList.innerHTML = `<h2>待确认列表（${rows.length}）</h2>` + rows.map((row, idx) => `
    <div class="candidate">
      <div class="candidate-body">
        <strong>${htmlEscape(row.amount || '—')} ${htmlEscape(row.currency || '')} · ${htmlEscape(row.sender_name || '未知汇款人')}</strong>
        <span class="muted">匹配：${candidateSummary(row)}</span>
        <span class="muted">创建时间：${htmlEscape(row.created_at || '—')} ｜ 风险：${htmlEscape(row.audit_risk_level || '—')}</span>
      </div>
      <button type="button" class="reviewPick" data-idx="${idx}" style="width:112px;margin-top:0;padding:9px 10px;font-size:13px">审核这一条</button>
    </div>`).join('');
  pendingList.querySelectorAll('.reviewPick').forEach(btn => btn.addEventListener('click', () => {
    const slip = pendingRows[Number(btn.dataset.idx)];
    if (slip) renderReview(slip);
  }));
}

function renderReview(slip) {
  currentSlip = slip;
  ensureReviewShell();
  const detailEl = document.getElementById('reviewDetail');
  if (slip.audit_risk_level === 'high' && slip.audit_status === 'blocked') {
    renderAuditReview({ findings: slip.findings || [] });
    return;
  }
  const candidates = Array.isArray(slip.candidates) ? slip.candidates : [];
  const one = candidates.length === 1;
  detailEl.innerHTML = `
    <h2>待人工确认</h2>
    <div class="grid">
      <div class="label">收款人</div><input type="text" id="beneficiary" value="${htmlEscape(slip.beneficiary_name || '')}">
      <div class="label">汇款核对</div><div class="compare"><b>汇款人：</b>${htmlEscape(slip.sender_name || '—')}<br><b>候选订单客户：</b>${htmlEscape(candidateCustomers(candidates))}</div>
      <div class="label">金额</div><div>${htmlEscape(slip.amount)} ${htmlEscape(slip.currency || '')}</div>
      <div class="label">付款日</div><div>${htmlEscape(slip.payment_date || '—')}</div>
      <div class="label">备注</div><div>${htmlEscape(slip.remark_details || '—')}</div>
    </div>
    <div class="label">候选订单</div>
    <div id="candidateList">${candidates.length ? candidates.map((c, idx) => `
      <label class="candidate">
        <input type="checkbox" class="cand" data-idx="${idx}" data-json="${htmlEscape(JSON.stringify(c))}" ${one ? 'checked' : ''}>
        <span class="candidate-body">
          <strong>${htmlEscape(c.shipment_no || '—')} · ${htmlEscape(c.customer || '未知客户')}${c.matched_by === 'customer_selected' ? '<span class="source-tag">客户自选</span>' : ''}</strong>
          <span class="muted">合同号：${htmlEscape((c.contract_nos || []).join(', ') || '—')} ｜ 订单：${htmlEscape((c.order_nos || []).join(', ') || '—')} ｜ BL：${htmlEscape(c.bl_no || '—')}</span>
          <span class="muted">柜号：${htmlEscape((c.container_nos || []).join(', ') || '—')}</span>
          <span class="muted">出单人：${htmlEscape(c.issuing_company || '—')}</span>
          <input type="number" class="alloc-amount" data-kind="candidate" data-idx="${idx}" step="0.01" min="0" placeholder="勾选后自动预填金额" ${one ? '' : 'disabled'}>
        </span>
      </label>`).join('') : '<div class="muted" style="margin:8px 0">系统没找到匹配订单，请手动输入合同号/订单号/BL/CY号。</div>'}</div>
    <div id="manualRows" style="margin-top:10px"></div>
    <a href="#" id="addManualRow" style="display:inline-block;margin-top:8px;font-size:13px;color:#1e3a8a;text-decoration:none">＋ 加一行手动分摊（一笔汇款拆多票；金额可为负，如CN冲减）</a>
    <div id="manualSumHint" class="alloc-hint"></div>
    <div id="allocHint" class="alloc-hint"></div>
    <div class="actions"><button id="confirmBtn">确认入库</button><button id="rejectBtn" class="secondary">这不是我要的，重来</button></div>`;
  document.querySelectorAll('.cand').forEach(el => el.addEventListener('change', () => recalcAllocations(true)));
  document.querySelectorAll('.alloc-amount').forEach(el => el.addEventListener('input', () => { el.dataset.touched = '1'; }));
  SlipManual.init(document.getElementById('manualRows'), document.getElementById('addManualRow'), document.getElementById('manualSumHint'), () => recalcAllocations(false));
  recalcAllocations(true);
  document.getElementById('confirmBtn').onclick = confirmSlip;
  document.getElementById('rejectBtn').onclick = rejectSlip;
}

function renderAuditReview(result) {
  ensureReviewShell();
  document.getElementById('reviewDetail').innerHTML = `
    <h2>高风险二次复核</h2>
    <div class="audit high">这张水单暂未生效，需要填写复核理由后才能放行。<ul>${findingMessages(result.findings)}</ul></div>
    <textarea id="reviewNote" placeholder="复核理由（必填）"></textarea>
    <button id="approveAuditBtn">确认放行</button>`;
  document.getElementById('approveAuditBtn').onclick = approveAuditReview;
}

async function fetchPending() {
  if (!jwtEl.value.trim()) {
    ensureReviewShell();
    document.getElementById('pendingList').innerHTML = '<h2>等待确认</h2><div class="muted">请先粘贴内部 JWT token，系统会自动拉取待确认 OCR 结果。</div>';
    return;
  }
  const res = await fetch('/api/db/slip-review?action=pending', { headers: authHeaders() });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.message || json.error || res.status);
  pendingRows = Array.isArray(json.rows) ? json.rows : [];
  renderPendingList(pendingRows);
}

function startPolling() {
  if (!IS_STAFF) return;
  if (pollTimer) return;
  fetchPending().catch(e => showResult('err', '读取待确认列表失败：' + e.message));
  pollTimer = setInterval(() => fetchPending().catch(() => {}), 2000);
}

async function refreshAfterReview() {
  currentSlip = null;
  ensureReviewShell();
  document.getElementById('reviewDetail').innerHTML = '';
  await fetchPending().catch(e => showResult('err', '刷新待确认列表失败：' + e.message));
}

async function confirmSlip() {
  if (!currentSlip) return;
  const checked = [...document.querySelectorAll('.cand:checked')].map(el => ({ el, data: JSON.parse(el.dataset.json) }));
  const allocations = checked.map(({ el, data: c }) => ({
    shipment_no: c.shipment_no,
    order_no: (c.order_nos || [])[0] || null,
    contract_no: (c.contract_nos || [])[0] || null,
    bl_no: c.bl_no || null,
    amount_alloc: amountInputValue(document.querySelector(`.alloc-amount[data-kind="candidate"][data-idx="${el.dataset.idx}"]`)),
    note: c.shipment_no ? '人工确认候选 ' + c.shipment_no : '人工确认候选',
    selection_source: 'ocr_candidate'
  }));
  SlipManual.rows().forEach(r => {
    if (!r.ref) return;
    const manualAlloc = allocationFromText(r.ref, r.amount);
    manualAlloc.selection_source = 'manual_input';
    allocations.push(manualAlloc);
  });
  if (!allocations.length) { showResult('err', '请先选择候选订单，或手动输入合同号/订单号/BL/CY号。'); return; }
  const res = await fetch('/api/db/slip-review?action=confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ slip_id: currentSlip.id, corrected_beneficiary_name: document.getElementById('beneficiary').value, allocations })
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) { showResult('err', '确认失败：' + (json.error || res.status)); return; }
  if (json.needs_review) {
    showResult('dup', '审核判定为高风险，已暂存分摊但未生效。请完成二次复核。');
    renderAuditReview(json);
    return;
  }
  let msg = '已确认入库。reconcile matched=' + (json.recon?.matched ?? '—') + ' exceptions=' + (json.recon?.exceptions ?? '—');
  if (json.audit_risk_level === 'medium') msg += '<div class="audit medium">⚠️ 有轻微异常，已放行留痕。<ul>' + findingMessages(json.findings) + '</ul></div>';
  showResult('ok', msg);
  await refreshAfterReview();
}

async function approveAuditReview() {
  if (!currentSlip) return;
  const note = document.getElementById('reviewNote').value.trim();
  if (!note) { showResult('err', '请填写复核理由。'); return; }
  const res = await fetch('/api/db/slip-review?action=audit-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ slip_id: currentSlip.id, review_note: note })
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) { showResult('err', '复核放行失败：' + (json.error || res.status)); return; }
  showResult('ok', '已复核放行。reconcile matched=' + (json.recon?.matched ?? '—') + ' exceptions=' + (json.recon?.exceptions ?? '—'));
  await refreshAfterReview();
}

async function rejectSlip() {
  if (!currentSlip) return;
  const res = await fetch('/api/db/slip-review?action=reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ slip_id: currentSlip.id, reason: 'user rejected on upload page' })
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) { showResult('err', '驳回失败：' + (json.error || res.status)); return; }
  showResult('ok', '已驳回，可重新上传。');
  await refreshAfterReview();
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadOneFile(file) {
  try {
    const b64 = await toBase64(file);
    const uploadQs = new URLSearchParams({ k: KEY });
    if (CUSTOMER) uploadQs.set('customer', CUSTOMER);
    const res = await fetch('/api/db/slip-upload?' + uploadQs.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        data: b64,
        uploader: 'web-upload',
        customer: CUSTOMER,
        note: document.getElementById('note').value || '',
        customer_selected_shipments: selectedCustomerShipments()
      })
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) return { ok: false, filename: file.name, error: json.error || res.status };
    return { ok: true, filename: file.name, duplicate: !!json.duplicate, id: json.id, existing: json.existing };
  } catch (e) {
    return { ok: false, filename: file.name, error: e.message };
  }
}

customerSearchBtn.addEventListener('click', searchCustomerShipments);
customerQEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchCustomerShipments(); } });
if (CUSTOMER && KEY) searchCustomerShipments();

submitBtn.addEventListener('click', async () => {
  if (!pickedFiles.length) return;
  if (!KEY) { showResult('err', '链接缺少 ?k= 参数，无法上传（找Damon要正确的上传链接）'); return; }
  submitBtn.disabled = true;
  submitBtn.textContent = '上传中…';
  resultEl.className = 'result ok';
  resultEl.innerHTML = '';
  for (const file of pickedFiles) {
    appendResultLine('ok', htmlEscape(file.name) + '：上传中…');
    const last = resultEl.lastElementChild;
    const result = await uploadOneFile(file);
    if (!result.ok) {
      last.innerHTML = `${htmlEscape(result.filename)}：❌上传失败：${htmlEscape(result.error)}`;
      resultEl.className = 'result err';
    } else if (result.duplicate) {
      last.innerHTML = `${htmlEscape(result.filename)}：⚠️之前传过了（登记时间：${htmlEscape(result.existing?.created_at || '—')}，状态：${htmlEscape(result.existing?.processing_status || '—')}）`;
      if (!resultEl.className.includes('err')) resultEl.className = 'result dup';
    } else {
      last.innerHTML = `${htmlEscape(result.filename)}：✅上传成功，识别中（上传编号：${htmlEscape(result.id || '—')}）`;
      waitUploadStatus(result.id, last, result.filename).catch(e => { last.innerHTML = `${htmlEscape(result.filename)}：状态查询失败：${htmlEscape(e.message)}`; });
    }
  }
  if (IS_STAFF) startPolling();
  pickedFiles = [];
  renderFileList();
  submitBtn.textContent = '上传';
});
