    (function() {
        const API_URL = '/api/db/rates-hub';
        let allPlans = [];
        let allBills = [];
        let filteredPlans = [];
        let currentQuick = 'ongoing';
        let expandedBL = new Set();
        let colVisibility = {
            arrow: true, bl: true, etd: true, route: true, customer: true, term: true,
            cost: true, sale: true, margin: true,
            category: true, currency: true, costD: true, saleD: true, termD: true,
            rebill: true, supplier: true, payStatus: true
        };
        const COL_KEY = 'ocean_cols';
        function getToken() { return localStorage.getItem('sanlyn_jwt') || localStorage.getItem('sanlyn_token') || localStorage.getItem('token') || ''; }
        function fmtMoney(v) {
            if (v === null || v === undefined || v === '') return '—';
            const num = Number(v);
            if (isNaN(num)) return '—';
            return num.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        }
        function fmtDate(etd) { if (!etd) return '—'; const d = new Date(etd); return isNaN(d) ? etd : d.toISOString().slice(0,10); }
        function escapeCsv(val) {
            if (val === null || val === undefined) return '';
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        }
        function getRebillLabel(status) {
            if (!status) return {text: '未录', cls: 'badge-rebill-missing'};
            switch(status) {
                case 'rebilled_to_customer': return {text: '已转客户', cls: 'badge-rebill'};
                case 'factory': case '转工厂': return {text: '转工厂', cls: 'badge-rebill-factory'};
                case 'self_absorbed': return {text: '自己吃', cls: 'badge-rebill-self'};
                case 'direct': return {text: '直付', cls: 'badge-rebill-direct'};
                case 'buyer': return {text: '转买方', cls: 'badge-rebill-buyer'};
                case 'voided': return {text: '已作废', cls: 'badge-rebill-void'};
                default: return {text: '未录', cls: 'badge-rebill-missing'};
            }
        }
        function isBlank(v) { return v === null || v === undefined || v === ''; }
        function toNum(v) { if (isBlank(v)) return null; const n = Number(v); return isNaN(n) ? null : n; }
        function attr(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
        function openWorkbenchTab(title,url){if(window.parent!==window)window.parent.postMessage({type:'sanlyn:open-tab',title:title,url:url},location.origin);else window.open(url,'_blank');}
        async function loadData() {
            const container = document.getElementById('table-container');
            container.innerHTML = '<div class="status-msg">⏳ 加载中...</div>';
            try {
                const token = getToken();
                const resp = await fetch(API_URL, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
                const json = await resp.json();
                if (!json.success) throw new Error('API 返回 success=false');
                const data = json.data || {};
                allPlans = Array.isArray(data.ocean_plans) ? data.ocean_plans : [];
                allBills = Array.isArray(data.ocean_bills) ? data.ocean_bills : [];
                document.getElementById('gen-time').textContent = new Date().toLocaleString('zh-CN', {hour12: false});
                populateFilters();
                applyQuickFilter();
                renderTable();
                renderUnmatched();
            } catch (err) {
                container.innerHTML = `<div class="status-msg error-msg">❌ 加载失败: ${err.message}</div>`;
            }
        }
        function populateFilters() {
            const polSet = new Set(), podSet = new Set(), carrierSet = new Set(), custSet = new Set();
            allPlans.forEach(p => {
                if (p.pol) polSet.add(p.pol);
                if (p.pod) podSet.add(p.pod);
                if (p.carrier_code) carrierSet.add(p.carrier_code);
                if (p.customer) custSet.add(p.customer);
            });
            fillSelect('filter-pol', polSet);
            fillSelect('filter-pod', podSet);
            fillSelect('filter-carrier', carrierSet);
            fillSelect('filter-customer', custSet);
        }
        function fillSelect(id, set) {
            const sel = document.getElementById(id);
            const current = sel.value;
            sel.innerHTML = '<option value="">全部</option>';
            [...set].sort().forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                sel.appendChild(opt);
            });
            if (current) sel.value = current;
        }
        function getFilteredPlans() {
            const pol = document.getElementById('filter-pol').value;
            const pod = document.getElementById('filter-pod').value;
            const carrier = document.getElementById('filter-carrier').value;
            const cust = document.getElementById('filter-customer').value;
            const today = new Date();
            const cutoff = new Date(today);
            cutoff.setDate(today.getDate() - 45);
            return allPlans.filter(p => {
                if (pol && p.pol !== pol) return false;
                if (pod && p.pod !== pod) return false;
                if (carrier && p.carrier_code !== carrier) return false;
                if (cust && p.customer !== cust) return false;
                if (currentQuick === 'ongoing') {
                    if (p.etd && new Date(p.etd) < cutoff) return false;
                } else if (currentQuick === 'missing_sale') {
                    if (!isBlank(p.freight_sale_usd)) return false;
                } else if (currentQuick === 'missing_term') {
                    if (p.freight_term && p.freight_term.trim() !== '') return false;
                } else if (currentQuick === 'term_conflict') {
                    if (!p.term_conflict) return false;
                } else if (currentQuick === 'multi_container') {
                    if (!p.container_qty || Number(p.container_qty) <= 1) return false;
                }
                return true;
            });
        }
        function applyQuickFilter() {
            filteredPlans = getFilteredPlans();
            updateQuickCounts();
        }
        function updateQuickCounts() {
            const counts = {ongoing:0, all:allPlans.length, missing_sale:0, missing_term:0, term_conflict:0, multi_container:0};
            const today = new Date();
            const cutoff = new Date(today); cutoff.setDate(today.getDate()-45);
            allPlans.forEach(p => {
                if (!(p.etd && new Date(p.etd) < cutoff)) counts.ongoing++;
                if (isBlank(p.freight_sale_usd)) counts.missing_sale++;
                if (!p.freight_term || p.freight_term.trim()==='') counts.missing_term++;
                if (p.term_conflict) counts.term_conflict++;
                if (p.container_qty && Number(p.container_qty)>1) counts.multi_container++;
            });
            document.querySelectorAll('.quick-btn').forEach(btn => {
                const key = btn.dataset.key;
                const countSpan = btn.querySelector('.count');
                if (countSpan && counts[key] !== undefined) countSpan.textContent = counts[key];
            });
        }
        function renderTable() {
            const container = document.getElementById('table-container');
            if (!filteredPlans.length) {
                container.innerHTML = '<div class="status-msg">📭 没有符合条件的票</div>';
                return;
            }
            let html = `<div class="table-wrapper"><table><thead><tr>`;
            const headers = [
                {key:'arrow', label:''},
                {key:'bl', label:'提单号'},
                {key:'etd', label:'开航日'},
                {key:'route', label:'航线'},
                {key:'customer', label:'客户'},
                {key:'term', label:'条款'},
                {key:'cost', label:'成本'},
                {key:'sale', label:'卖价'},
                {key:'margin', label:'毛差'}
            ];
            headers.forEach(h => {
                if (colVisibility[h.key]) html += `<th>${h.label}</th>`;
            });
            html += '</tr></thead><tbody>';
            filteredPlans.forEach((plan) => {
                const bl = (plan.bl_no || '').trim();
                const isExpanded = expandedBL.has(bl);
                const multi = plan.container_qty && Number(plan.container_qty) > 1;
                const termLabel = plan.freight_term || '';
                const termConflict = plan.term_conflict;
                const costUSD = plan.freight_cost_currency === 'USD' ? toNum(plan.freight_cost) : null;
                const costCNY = plan.freight_cost_currency === 'CNY' ? toNum(plan.freight_cost) : null;
                const saleUSD = toNum(plan.freight_sale_usd);
                const saleCNY = null;
                const marginUSD = (costUSD !== null && saleUSD !== null) ? (saleUSD - costUSD) : null;
                const marginCNY = (costCNY !== null && saleCNY !== null) ? (saleCNY - costCNY) : null;
                const key = plan.shipment_no || bl || plan.id || plan._id || '';
                html += `<tr class="bl-row ${isExpanded?'expanded':''}" data-bl="${attr(bl)}" data-title="${attr(bl || key || '海运票')}" data-url="/ship-entry?id=${encodeURIComponent(key)}">`;
                if (colVisibility.arrow) html += `<td data-action="toggle">${isExpanded?'▼':'▶'}</td>`;
                if (colVisibility.bl) {
                    html += `<td><span>${bl}</span>${multi ? `<span class="badge badge-multi">×${plan.container_qty}柜</span>` : ''}</td>`;
                }
                if (colVisibility.etd) html += `<td>${fmtDate(plan.etd)}</td>`;
                if (colVisibility.route) html += `<td>${plan.pol || '?'} → ${plan.pod || '?'}</td>`;
                if (colVisibility.customer) html += `<td>${plan.customer || '—'}</td>`;
                if (colVisibility.term) {
                    if (termConflict) html += `<td><span class="badge badge-conflict">冲突</span></td>`;
                    else if (!termLabel) html += `<td><span class="badge badge-missing">缺</span></td>`;
                    else html += `<td><span class="badge" style="background:#e0e0e0;">${termLabel}</span></td>`;
                }
                if (colVisibility.cost) {
                    html += `<td class="num">`;
                    if (costUSD !== null) html += `USD ${fmtMoney(costUSD)}<br>`;
                    if (costCNY !== null) html += `CNY ${fmtMoney(costCNY)}<br>`;
                    if (costUSD === null && costCNY === null) html += '—';
                    html += `</td>`;
                }
                if (colVisibility.sale) {
                    html += `<td class="num">`;
                    if (saleUSD !== null) html += `USD ${fmtMoney(saleUSD)}<br>`;
                    else html += `<span class="badge badge-missing">未填</span>`;
                    if (saleCNY !== null) html += `CNY ${fmtMoney(saleCNY)}`;
                    html += `</td>`;
                }
                if (colVisibility.margin) {
                    html += `<td class="num">`;
                    if (marginUSD !== null) html += `USD ${fmtMoney(marginUSD)}<br>`;
                    if (marginCNY !== null) html += `CNY ${fmtMoney(marginCNY)}<br>`;
                    if (marginUSD === null && marginCNY === null) html += '—';
                    html += `</td>`;
                }
                html += `</tr>`;
                if (isExpanded) {
                    const bills = allBills.filter(b => (b.bl_no || '').trim() === bl);
                    html += `<tr class="detail-row"><td colspan="9" style="padding:0;">`;
                    html += `<div class="detail-inner">`;
                    html += `<table class="detail-table"><thead><tr>`;
                    const dHeaders = [
                        {key:'category', label:'费目'},
                        {key:'currency', label:'币种'},
                        {key:'costD', label:'成本'},
                        {key:'saleD', label:'转客户价'},
                        {key:'termD', label:'条款'},
                        {key:'rebill', label:'转客户'},
                        {key:'supplier', label:'供应商'},
                        {key:'payStatus', label:'付款状态'}
                    ];
                    dHeaders.forEach(h => {
                        if (colVisibility[h.key]) html += `<th>${h.label}</th>`;
                    });
                    html += `</tr></thead><tbody>`;
                    let sumCost = {CNY:0, USD:0};
                    let sumSale = {CNY:0, USD:0};
                    let sumMargin = {CNY:0, USD:0};
                    let rebillSum = {customer:{CNY:0,USD:0}, factory:{CNY:0,USD:0}, self:{CNY:0,USD:0}};
                    let hasSaleCNY = false, hasSaleUSD = false;
                    let hasCostCNY = false, hasCostUSD = false;
                    bills.forEach(bill => {
                        const cur = bill.currency || '';
                        const costNum = toNum(bill.amount);
                        const saleNum = toNum(bill.sale_amount);
                        if (cur === 'CNY') {
                            if (costNum !== null) { sumCost.CNY += costNum; hasCostCNY = true; }
                            if (saleNum !== null) { sumSale.CNY += saleNum; hasSaleCNY = true; }
                            if (costNum !== null && saleNum !== null) sumMargin.CNY += (saleNum - costNum);
                        } else if (cur === 'USD') {
                            if (costNum !== null) { sumCost.USD += costNum; hasCostUSD = true; }
                            if (saleNum !== null) { sumSale.USD += saleNum; hasSaleUSD = true; }
                            if (costNum !== null && saleNum !== null) sumMargin.USD += (saleNum - costNum);
                        }
                        const rebill = getRebillLabel(bill.rebill_status);
                        if (bill.rebill_status === 'rebilled_to_customer' && saleNum !== null) {
                            if (cur === 'CNY') rebillSum.customer.CNY += saleNum;
                            else if (cur === 'USD') rebillSum.customer.USD += saleNum;
                        } else if ((bill.rebill_status === 'factory' || bill.rebill_status === '转工厂') && saleNum !== null) {
                            if (cur === 'CNY') rebillSum.factory.CNY += saleNum;
                            else if (cur === 'USD') rebillSum.factory.USD += saleNum;
                        } else if (bill.rebill_status === 'self_absorbed' && saleNum !== null) {
                            if (cur === 'CNY') rebillSum.self.CNY += saleNum;
                            else if (cur === 'USD') rebillSum.self.USD += saleNum;
                        }
                        html += `<tr>`;
                        if (colVisibility.category) html += `<td>${bill.cost_category || '—'}</td>`;
                        if (colVisibility.currency) {
                            if (!cur) html += `<td><span class="badge badge-currency-missing">缺币种</span></td>`;
                            else html += `<td>${cur}</td>`;
                        }
                        if (colVisibility.costD) html += `<td class="num">${costNum!==null?fmtMoney(costNum):'—'}</td>`;
                        if (colVisibility.saleD) html += `<td class="num">${saleNum!==null?fmtMoney(saleNum):'<span class="badge badge-missing">未填</span>'}</td>`;
                        if (colVisibility.termD) html += `<td>${bill.incoterm || '—'}</td>`;
                        if (colVisibility.rebill) html += `<td><span class="badge ${rebill.cls}">${rebill.text}</span></td>`;
                        if (colVisibility.supplier) html += `<td>${bill.supplier || '—'}</td>`;
                        if (colVisibility.payStatus) html += `<td>${bill.payment_status || '—'}</td>`;
                        html += `</tr>`;
                    });
                    html += `<tr class="sum-row">`;
                    if (colVisibility.category) html += `<td>合计</td>`;
                    if (colVisibility.currency) html += `<td></td>`;
                    if (colVisibility.costD) {
                        html += `<td class="num">`;
                        if (hasCostCNY) html += `CNY ${fmtMoney(sumCost.CNY)}<br>`;
                        if (hasCostUSD) html += `USD ${fmtMoney(sumCost.USD)}<br>`;
                        if (!hasCostCNY && !hasCostUSD) html += '—';
                        html += `</td>`;
                    }
                    if (colVisibility.saleD) {
                        html += `<td class="num">`;
                        if (hasSaleCNY) html += `CNY ${fmtMoney(sumSale.CNY)}<br>`;
                        if (hasSaleUSD) html += `USD ${fmtMoney(sumSale.USD)}<br>`;
                        if (!hasSaleCNY && !hasSaleUSD) html += '<span class="badge badge-missing">未填</span>';
                        html += `</td>`;
                    }
                    if (colVisibility.termD) html += `<td></td>`;
                    if (colVisibility.rebill) html += `<td></td>`;
                    if (colVisibility.supplier) html += `<td></td>`;
                    if (colVisibility.payStatus) html += `<td></td>`;
                    html += `</tr>`;
                    html += `<tr class="margin-row">`;
                    if (colVisibility.category) html += `<td>毛差</td>`;
                    if (colVisibility.currency) html += `<td></td>`;
                    if (colVisibility.costD) {
                        html += `<td class="num">`;
                        if (hasCostCNY && hasSaleCNY) html += `CNY ${fmtMoney(sumMargin.CNY)}<br>`;
                        if (hasCostUSD && hasSaleUSD) html += `USD ${fmtMoney(sumMargin.USD)}<br>`;
                        if (!(hasCostCNY && hasSaleCNY) && !(hasCostUSD && hasSaleUSD)) html += '—';
                        html += `</td>`;
                    }
                    if (colVisibility.saleD) html += `<td></td>`;
                    if (colVisibility.termD) html += `<td></td>`;
                    if (colVisibility.rebill) html += `<td></td>`;
                    if (colVisibility.supplier) html += `<td></td>`;
                    if (colVisibility.payStatus) html += `<td></td>`;
                    html += `</tr>`;
                    html += `</tbody></table>`;
                    let rebillParts = [];
                    if (rebillSum.customer.CNY !== 0 || rebillSum.customer.USD !== 0) {
                        let parts = [];
                        if (rebillSum.customer.CNY !== 0) parts.push(`CNY ${fmtMoney(rebillSum.customer.CNY)}`);
                        if (rebillSum.customer.USD !== 0) parts.push(`USD ${fmtMoney(rebillSum.customer.USD)}`);
                        rebillParts.push(`已转客户 ${parts.join(' / ')}`);
                    }
                    if (rebillSum.factory.CNY !== 0 || rebillSum.factory.USD !== 0) {
                        let parts = [];
                        if (rebillSum.factory.CNY !== 0) parts.push(`CNY ${fmtMoney(rebillSum.factory.CNY)}`);
                        if (rebillSum.factory.USD !== 0) parts.push(`USD ${fmtMoney(rebillSum.factory.USD)}`);
                        rebillParts.push(`转工厂 ${parts.join(' / ')}`);
                    }
                    if (rebillSum.self.CNY !== 0 || rebillSum.self.USD !== 0) {
                        let parts = [];
                        if (rebillSum.self.CNY !== 0) parts.push(`CNY ${fmtMoney(rebillSum.self.CNY)}`);
                        if (rebillSum.self.USD !== 0) parts.push(`USD ${fmtMoney(rebillSum.self.USD)}`);
                        rebillParts.push(`自己吃 ${parts.join(' / ')}`);
                    }
                    if (rebillParts.length) {
                        html += `<div style="margin-top:6px;font-size:12px;">${rebillParts.join(' · ')}</div>`;
                    }
                    html += `<div style="margin-top:8px;"><button class="link-btn" data-action="edit" data-bl="${attr(bl)}">改这票费用</button> <button class="link-btn" data-action="bill" data-bl="${attr(bl)}">出港杂账单</button></div>`;
                    html += `</div></td></tr>`;
                }
            });
            html += '</tbody></table></div>';
            container.innerHTML = html;
            container.querySelectorAll('.bl-row').forEach(row => {
                row.addEventListener('click', function(e) {
                    const bl = this.dataset.bl;
                    if (e.target.closest('[data-action="toggle"]')) {
                        if (expandedBL.has(bl)) expandedBL.delete(bl); else expandedBL.add(bl);
                        renderTable();
                    } else openWorkbenchTab(this.dataset.title, this.dataset.url);
                });
            });
            container.querySelectorAll('.link-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const bl = btn.dataset.bl || '';
                    const bill = btn.dataset.action === 'bill';
                    openWorkbenchTab((bill ? '港杂账单 ' : '海运费用 ') + (bl || '未设置'), bill ? '/wb-tabs-placeholder?module=' + encodeURIComponent('港杂账单 ' + (bl || '未设置')) : '/ship-entry?id=' + encodeURIComponent(bl));
                });
            });
        }
        function renderUnmatched() {
            const matchedBLs = new Set(allPlans.map(p => (p.bl_no||'').trim()));
            const unmatched = allBills.filter(b => !matchedBLs.has((b.bl_no||'').trim()));
            const section = document.getElementById('unmatched-section');
            if (!unmatched.length) {
                section.innerHTML = '';
                return;
            }
            let html = `<h3>⚠️ 未挂到票的费用行 (${unmatched.length})</h3>`;
            html += `<table class="unmatched-table"><thead><tr><th>BL</th><th>费目</th><th>币种</th><th>金额</th><th>供应商</th></tr></thead><tbody>`;
            unmatched.forEach(b => {
                html += `<tr><td>${b.bl_no||'—'}</td><td>${b.cost_category||'—'}</td><td>${b.currency||'缺币种'}</td><td class="num">${fmtMoney(b.amount)}</td><td>${b.supplier||'—'}</td></tr>`;
            });
            html += '</tbody></table>';
            section.innerHTML = html;
        }
        function initColPanel() {
            const panel = document.getElementById('col-panel');
            const overlay = document.getElementById('overlay');
            const btn = document.getElementById('btn-cols');
            const allCols = [
                {key:'arrow', label:'展开箭头'}, {key:'bl', label:'提单号'}, {key:'etd', label:'开航日'},
                {key:'route', label:'航线'}, {key:'customer', label:'客户'}, {key:'term', label:'条款'},
                {key:'cost', label:'成本'}, {key:'sale', label:'卖价'}, {key:'margin', label:'毛差'},
                {key:'category', label:'费目'}, {key:'currency', label:'币种'}, {key:'costD', label:'成本(明细)'},
                {key:'saleD', label:'转客户价'}, {key:'termD', label:'条款(明细)'}, {key:'rebill', label:'转客户'},
                {key:'supplier', label:'供应商'}, {key:'payStatus', label:'付款状态'}
            ];
            function renderPanel() {
                let html = `<h4>自定义列</h4>`;
                allCols.forEach(c => {
                    html += `<label><input type="checkbox" data-col="${c.key}" ${colVisibility[c.key]?'checked':''}> ${c.label}</label>`;
                });
                html += `<button class="btn restore-btn" id="restore-cols">恢复默认</button>`;
                panel.innerHTML = html;
                panel.querySelectorAll('input[type=checkbox]').forEach(chk => {
                    chk.addEventListener('change', function() {
                        colVisibility[this.dataset.col] = this.checked;
                        localStorage.setItem(COL_KEY, JSON.stringify(colVisibility));
                        renderTable();
                    });
                });
                document.getElementById('restore-cols').addEventListener('click', () => {
                    colVisibility = {
                        arrow: true, bl: true, etd: true, route: true, customer: true, term: true,
                        cost: true, sale: true, margin: true, category: true, currency: true,
                        costD: true, saleD: true, termD: true, rebill: true, supplier: true, payStatus: true
                    };
                    localStorage.setItem(COL_KEY, JSON.stringify(colVisibility));
                    renderPanel();
                    renderTable();
                });
            }
            btn.addEventListener('click', () => {
                renderPanel();
                panel.style.display = 'block';
                overlay.style.display = 'block';
            });
            overlay.addEventListener('click', () => {
                panel.style.display = 'none';
                overlay.style.display = 'none';
            });
            const saved = localStorage.getItem(COL_KEY);
            if (saved) {
                try { colVisibility = {...colVisibility, ...JSON.parse(saved)}; } catch(e) {}
            }
        }
        function exportCSV() {
            const rows = [];
            rows.push(['类型','提单号','开航日','航线','客户','条款','成本USD','成本CNY','卖价USD','毛差USD','毛差CNY']);
            filteredPlans.forEach(p => {
                const bl = (p.bl_no||'').trim();
                const costUSD = p.freight_cost_currency==='USD'?p.freight_cost:'';
                const costCNY = p.freight_cost_currency==='CNY'?p.freight_cost:'';
                const saleUSD = p.freight_sale_usd;
                const marginUSD = (costUSD!=='' && saleUSD!==null && saleUSD!==undefined)?(saleUSD-costUSD):'';
                rows.push(['票', bl, fmtDate(p.etd), `${p.pol||''}→${p.pod||''}`, p.customer||'', p.freight_term||'', costUSD, costCNY, saleUSD, marginUSD, '']);
                allBills.filter(b => (b.bl_no||'').trim()===bl).forEach(b => {
                    rows.push(['费用', bl, '', '', '', b.incoterm||'', b.currency==='USD'?b.amount:'', b.currency==='CNY'?b.amount:'', b.sale_amount||'', '', '']);
                });
            });
            const matchedBLs = new Set(allPlans.map(p => (p.bl_no||'').trim()));
            allBills.filter(b => !matchedBLs.has((b.bl_no||'').trim())).forEach(b => {
                rows.push(['未挂票', b.bl_no||'', '', '', '', '', b.currency==='USD'?b.amount:'', b.currency==='CNY'?b.amount:'', b.sale_amount||'', '', '']);
            });
            const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');
            const blob = new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8;'});
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = '海运总表.csv';
            link.click();
        }
        function bindEvents() {
            document.getElementById('filter-pol').addEventListener('change', applyAndRender);
            document.getElementById('filter-pod').addEventListener('change', applyAndRender);
            document.getElementById('filter-carrier').addEventListener('change', applyAndRender);
            document.getElementById('filter-customer').addEventListener('change', applyAndRender);
            document.getElementById('btn-export').addEventListener('click', exportCSV);
            const quickDefs = [
                {key:'ongoing', label:'在办'},
                {key:'all', label:'全部'},
                {key:'missing_sale', label:'缺卖价'},
                {key:'missing_term', label:'缺条款'},
                {key:'term_conflict', label:'条款冲突'},
                {key:'multi_container', label:'多柜'}
            ];
            const wrap = document.getElementById('quick-btns');
            wrap.innerHTML = quickDefs.map(q => `<button class="quick-btn ${currentQuick===q.key?'active':''}" data-key="${q.key}">${q.label} <span class="count">0</span></button>`).join('');
            wrap.querySelectorAll('.quick-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    currentQuick = this.dataset.key;
                    wrap.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
                    this.classList.add('active');
                    applyQuickFilter();
                    renderTable();
                    renderUnmatched();
                });
            });
            initColPanel();
        }
        function applyAndRender() {
            applyQuickFilter();
            renderTable();
            renderUnmatched();
        }
        document.addEventListener('DOMContentLoaded', () => {
            bindEvents();
            loadData();
        });
    })();
