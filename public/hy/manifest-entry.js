        (function() {
            // ---------- 枚举数据 ----------
            const ENUMS = {
                cargo_type: ['普通货物','冷冻品','危险品','冷藏危险品'],
                payment_method: ['预付','到付','第三地付款'],
                bl_type: ['OBL-正本提单','SWB-海运单','TER-电放'],
                transport_terms: ['CY-CY'],
                shipping_agent: ['(名单待补·海管家那12家是上海口岸,我们主力新港/青岛/厦门)'],
                country_code: ['CN中国','MY马来西亚','BD孟加拉','TW中国台湾']
            };
            const PORTS = ['Shanghai|CNSHA','Qingdao|CNTAO','Xingang|CNTXG','Xiamen|CNXMN','Kota Kinabalu|MYBKI','Port Klang Northport|MYPKGN','Port Klang Westport|MYPKGW','Kaohsiung|TWKHH'];

            // ---------- 状态 ----------
            let lineRows = 1;
            const requiredFields = ['master_bl_no','carrier','cargo_type','transport_terms','payment_method','bl_type','bl_copies','place_of_issue','vessel','voyage','shipping_agent','place_of_receipt','pol','pod','final_destination','shipper.name','shipper.address','shipper.country_code','shipper.phone','consignee.name','consignee.address','consignee.country_code','consignee.phone','notify.name','notify.address','notify.country_code','notify.phone'];

            // ---------- 工具函数 ----------
            function $(id) { return document.getElementById(id); }
            function showToast(msg, type='success') {
                const t = $('toast');
                t.textContent = msg;
                t.className = 'toast ' + type;
                t.style.display = 'block';
                setTimeout(() => t.style.display = 'none', 2500);
            }

            // 自定义下拉初始化
            function initCustomSelect(selectId, fieldKey, options, disabled=false) {
                const el = $(selectId);
                if (!el) return;
                const valueSpan = el.querySelector('.value');
                const arrow = el.querySelector('.arrow');
                let currentValue = '';

                // 设置默认值
                if (fieldKey === 'transport_terms') currentValue = 'CY-CY';
                if (fieldKey === 'place_of_issue') currentValue = 'SHANGHAI|CNSHA';
                if (fieldKey === 'bl_copies') currentValue = '3';
                if (fieldKey === 'pol') currentValue = 'SHANGHAI|CNSHA';
                if (currentValue) valueSpan.textContent = currentValue;

                el.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if (disabled) return;
                    // 关闭其他
                    document.querySelectorAll('.dropdown-panel').forEach(p => p.remove());
                    const panel = document.createElement('div');
                    panel.className = 'dropdown-panel';
                    options.forEach(opt => {
                        const item = document.createElement('div');
                        item.className = 'dropdown-item' + (opt.startsWith('(') ? ' disabled' : '');
                        item.textContent = opt;
                        if (!opt.startsWith('(')) {
                            item.addEventListener('click', function() {
                                valueSpan.textContent = opt;
                                currentValue = opt;
                                el.dataset.value = opt;
                                panel.remove();
                                // 触发校验
                                validateField(fieldKey, opt);
                            });
                        } else {
                            item.style.color = '#b0b7c3';
                        }
                        panel.appendChild(item);
                    });
                    // 特殊footer
                    if (fieldKey === 'country_code') {
                        const footer = document.createElement('div');
                        footer.className = 'dropdown-footer';
                        footer.textContent = 'ISO 3166-1 alpha-2 完整表待生成';
                        panel.appendChild(footer);
                    }
                    if (fieldKey === 'shipping_agent') {
                        const footer = document.createElement('div');
                        footer.className = 'dropdown-footer';
                        footer.textContent = '名单待补·参考来源那12家是上海口岸';
                        panel.appendChild(footer);
                    }
                    el.appendChild(panel);
                    document.addEventListener('click', function handler(e) {
                        if (!el.contains(e.target)) {
                            panel.remove();
                            document.removeEventListener('click', handler);
                        }
                    });
                });
            }

            // 港口联想
            function initPortInput(inputId) {
                const input = $(inputId);
                if (!input) return;
                input.addEventListener('input', function() {
                    const val = input.value;
                    // 移除旧联想
                    document.querySelectorAll('.port-suggest').forEach(p => p.remove());
                    if (!val) return;
                    const matches = PORTS.filter(p => p.toLowerCase().includes(val.toLowerCase()));
                    if (matches.length === 0) return;
                    const suggest = document.createElement('div');
                    suggest.className = 'port-suggest';
                    matches.forEach(m => {
                        const item = document.createElement('div');
                        item.className = 'item';
                        item.textContent = m;
                        item.addEventListener('click', function() {
                            input.value = m;
                            suggest.remove();
                        });
                        suggest.appendChild(item);
                    });
                    const footer = document.createElement('div');
                    footer.className = 'footer';
                    footer.textContent = '港口库共118个,本页内嵌8个常用,完整表待接 /api/db/ports';
                    suggest.appendChild(footer);
                    input.parentElement.style.position = 'relative';
                    input.parentElement.appendChild(suggest);
                    document.addEventListener('click', function handler(e) {
                        if (!input.parentElement.contains(e.target)) {
                            suggest.remove();
                            document.removeEventListener('click', handler);
                        }
                    });
                });
            }

            // 校验单个字段
            function validateField(key, value) {
                const input = document.querySelector(`[data-field="${key}"]`) || $(key);
                if (!input) return true;
                let errorMsg = '';
                // 必填
                if (requiredFields.includes(key) && !value) {
                    errorMsg = '必填';
                }
                // 主提单号
                if (key === 'master_bl_no' && value && !/^[A-Z0-9]+$/.test(value)) {
                    errorMsg = '只能大写字母和数字';
                }
                // 船名
                if (key === 'vessel' && value && !/^[A-Z0-9 ]+$/.test(value)) {
                    errorMsg = '只能大写字母和数字';
                }
                // 航次
                if (key === 'voyage' && value && value.includes('V.')) {
                    errorMsg = '航次不可以有 V.';
                }
                // 提单份数
                if (key === 'bl_copies' && value && !/^\d+$/.test(value)) {
                    errorMsg = '只能数字';
                }
                // 企业代码
                if (key.includes('enterprise_code') && value) {
                    if (!value.includes('+') || value.includes('+ ') || value.includes(' +')) {
                        errorMsg = '需含+，+前后无空格';
                    }
                }
                const errorEl = input.closest('.field')?.querySelector('.error-msg');
                if (errorEl) {
                    errorEl.textContent = errorMsg;
                    errorEl.style.color = '#f5222d';
                }
                return !errorMsg;
            }

            // 全量校验
            function validateAll() {
                let firstError = null;
                let errorCount = 0;
                // 表头必填
                requiredFields.forEach(key => {
                    let val = '';
                    const input = $(key);
                    if (input) val = input.value;
                    else {
                        const sel = document.querySelector(`[data-field="${key}"] .value`);
                        if (sel) val = sel.textContent;
                    }
                    if (!validateField(key, val)) {
                        errorCount++;
                        if (!firstError) firstError = $(key) || document.querySelector(`[data-field="${key}"]`);
                    }
                });
                // 行表必填
                const rows = document.querySelectorAll('#lineTableBody tr');
                rows.forEach((row, idx) => {
                    const inputs = row.querySelectorAll('input');
                    // 简化：检查前几个必填
                    const requiredLine = ['bl_no','container_no','seal_no','container_type','soc_flag','goods_name_en','packages','package_unit','gross_weight','volume','marks'];
                    requiredLine.forEach((k, i) => {
                        const inp = inputs[i];
                        if (inp && !inp.value) {
                            errorCount++;
                            if (!firstError) firstError = inp;
                            inp.style.borderColor = '#f5222d';
                        }
                    });
                });
                if (firstError) {
                    firstError.scrollIntoView({behavior:'smooth', block:'center'});
                    showToast(`还有 ${errorCount} 项必填未完成`, 'error');
                    return false;
                }
                return true;
            }

            // 行表渲染
            function renderLineRows() {
                const tbody = $('lineTableBody');
                tbody.innerHTML = '';
                for (let i = 0; i < lineRows; i++) {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${i+1}</td>
                        <td><input data-line="bl_no" maxlength="30"></td>
                        <td><input data-line="container_no" maxlength="30"></td>
                        <td><input data-line="seal_no" maxlength="30"></td>
                        <td><input data-line="container_type" maxlength="10"></td>
                        <td><input data-line="soc_flag" maxlength="5" value="F"></td>
                        <td><input data-line="goods_name_en" maxlength="140"></td>
                        <td><input data-line="hs_code" maxlength="20"></td>
                        <td><input data-line="packages" maxlength="10"></td>
                        <td><input data-line="package_unit" maxlength="20"></td>
                        <td><input data-line="gross_weight" maxlength="10"></td>
                        <td><input data-line="volume" maxlength="10"></td>
                        <td><input data-line="marks" maxlength="140"></td>
                        <td class="danger-col"><input data-line="un_code" maxlength="20"></td>
                        <td class="danger-col"><input data-line="danger_class" maxlength="20"></td>
                        <td class="danger-col"><input data-line="danger_contact" maxlength="50"></td>
                        <td class="danger-col"><input data-line="danger_phone" maxlength="50"></td>
                        <td><input data-line="empty_flag" value="F" maxlength="1"></td>
                        <td><button class="btn btn-sm del-row">删除</button></td>
                    `;
                    tbody.appendChild(tr);
                }
                // 绑定删除
                document.querySelectorAll('.del-row').forEach(btn => {
                    btn.addEventListener('click', function() {
                        if (lineRows > 1) {
                            this.closest('tr').remove();
                            lineRows--;
                            renderLineRows();
                        }
                    });
                });
            }

            // 复制收货人到通知人
            function copyConsigneeToNotify() {
                const fields = ['name','address','country_code','phone','enterprise_code','aeo_code'];
                fields.forEach(f => {
                    const src = $(`consignee.${f}`);
                    const dst = $(`notify.${f}`);
                    if (src && dst) dst.value = src.value;
                });
                // 国家代码下拉
                const consigneeCountry = document.querySelector('[data-field="consignee.country_code"] .value');
                const notifyCountry = document.querySelector('[data-field="notify.country_code"] .value');
                if (consigneeCountry && notifyCountry) notifyCountry.textContent = consigneeCountry.textContent;
                showToast('已复制收货人→通知人');
            }

            // 模板相关
            const TEMPLATE_KEY = 'manifest_templates';
            function getTemplates() {
                try {
                    return JSON.parse(localStorage.getItem(TEMPLATE_KEY)) || [];
                } catch(e) { return []; }
            }
            function saveTemplates(list) {
                localStorage.setItem(TEMPLATE_KEY, JSON.stringify(list));
            }
            function getHeaderValues() {
                const values = {};
                // 37个表头字段的id列表（不含明细行）
                const headerIds = ['master_bl_no','carrier','cargo_type','transport_terms','payment_method','bl_type','bl_copies','place_of_issue','payment_place','consignor_note','vessel','voyage','shipping_agent','shipper.name','shipper.address','shipper.country_code','shipper.phone','shipper.enterprise_code','shipper.aeo_code','consignee.name','consignee.address','consignee.country_code','consignee.phone','consignee.enterprise_code','consignee.aeo_code','consignee.actual_contact','consignee.actual_contact_phone','notify.name','notify.address','notify.country_code','notify.phone','notify.enterprise_code','notify.aeo_code','place_of_receipt','pol','pod','final_destination'];
                headerIds.forEach(id => {
                    const el = $(id);
                    if (el) values[id] = el.value;
                    else {
                        const sel = document.querySelector(`[data-field="${id}"] .value`);
                        if (sel) values[id] = sel.textContent;
                    }
                });
                return values;
            }
            function applyHeaderValues(values) {
                let count = 0;
                Object.keys(values).forEach(key => {
                    const el = $(key);
                    if (el) {
                        if (el.value !== values[key]) { el.value = values[key]; count++; }
                    } else {
                        const sel = document.querySelector(`[data-field="${key}"] .value`);
                        if (sel && sel.textContent !== values[key]) { sel.textContent = values[key]; count++; }
                    }
                });
                return count;
            }

            // 初始化
            function init() {
                // 自定义下拉
                initCustomSelect('carrier-select', 'carrier', ['MAERSK','MSC','CMA CGM','COSCO','HPL','ONE','YML','EMC','OOCL','HMM','ZIM','PIL']);
                initCustomSelect('cargo_type-select', 'cargo_type', ENUMS.cargo_type);
                initCustomSelect('transport_terms-select', 'transport_terms', ENUMS.transport_terms);
                initCustomSelect('payment_method-select', 'payment_method', ENUMS.payment_method);
                initCustomSelect('bl_type-select', 'bl_type', ENUMS.bl_type);
                initCustomSelect('shipping_agent-select', 'shipping_agent', ENUMS.shipping_agent);
                initCustomSelect('shipper.country_code-select', 'shipper.country_code', ENUMS.country_code);
                initCustomSelect('consignee.country_code-select', 'consignee.country_code', ENUMS.country_code);
                initCustomSelect('notify.country_code-select', 'notify.country_code', ENUMS.country_code);

                // 港口联想
                ['place_of_receipt','pol','pod','final_destination','place_of_issue'].forEach(id => initPortInput(id));

                // 行表
                renderLineRows();

                // 事件
                $('addLineRow').addEventListener('click', () => { lineRows++; renderLineRows(); });
                $('copyToNotify').addEventListener('click', copyConsigneeToNotify);
                $('saveToSend').addEventListener('click', () => {
                    if (validateAll()) {
                        console.log('保存到待发送', {});
                        showToast('已保存到待发送(模拟)', 'success');
                    }
                });
                $('saveDraft').addEventListener('click', () => {
                    console.log('保存到草稿箱', {});
                    showToast('已保存到草稿箱(模拟)', 'success');
                });
                $('copyBtn').addEventListener('click', () => {
                    // 复制功能：清空主提单号/船名/航次
                    ['master_bl_no','vessel','voyage'].forEach(id => { if($(id)) $(id).value=''; });
                    showToast('已复制,请填写主提单号/船名/航次');
                });
                $('closeBtn').addEventListener('click', () => { console.log('关闭'); showToast('关闭(模拟)'); });
                $('checkVoyage').addEventListener('click', () => {
                    const v = $('voyage').value;
                    if (v.includes('V.')) showToast('航次不可以有 V.', 'error');
                    else showToast('航次校验通过', 'success');
                });
                $('viewAgent').addEventListener('click', () => showToast('查看船司船代(待接入)'));

                // 智能识别/历史按钮
                document.querySelectorAll('[data-action]').forEach(btn => {
                    btn.addEventListener('click', () => showToast('待接入'));
                });

                // 输入实时校验
                document.querySelectorAll('input').forEach(input => {
                    input.addEventListener('input', function() {
                        const key = this.id;
                        if (key === 'master_bl_no') this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
                        if (key === 'vessel') this.value = this.value.toUpperCase().replace(/[^A-Z0-9 ]/g,'');
                        if (key === 'bl_copies') this.value = this.value.replace(/[^0-9]/g,'');
                        validateField(key, this.value);
                    });
                });

                // 折叠
                document.querySelectorAll('.section-header').forEach(header => {
                    header.addEventListener('click', function() {
                        this.parentElement.classList.toggle('collapsed');
                    });
                });

                // 功能一：三个入口卡片
                const cardExcel = $('cardExcel');
                const cardManual = $('cardManual');
                const cardAI = $('cardAI');
                // 新建舱单是当前激活态，不做点击弹窗
                cardManual.addEventListener('click', () => {
                    // 已经是激活态，不做任何事
                });
                // 表格导入面板
                cardExcel.addEventListener('click', () => {
                    showModal(`
                        <h3>表格导入/下载</h3>
                        <div style="margin-bottom:16px;">
                            <button class="btn btn-primary" id="downloadTemplateBtn" style="width:100%;">下载模板</button>
                        </div>
                        <div class="drop-zone" id="excelDropZone">拖入 .xlsx 或点击选择</div>
                        <div class="btn-row">
                            <button class="btn" id="closeExcelModal">关闭</button>
                        </div>
                        <div class="pending-warning">待接入,本轮不处理文件</div>
                    `);
                    $('downloadTemplateBtn').addEventListener('click', () => showToast('模板下载待接入'));
                    $('excelDropZone').addEventListener('click', () => showToast('文件选择待接入'));
                    $('closeExcelModal').addEventListener('click', closeModal);
                });
                // AI识别面板
                cardAI.addEventListener('click', () => {
                    showModal(`
                        <h3>AI单证识别</h3>
                        <div class="drop-zone" id="aiDropZone">拖入提单/托书 PDF 或图片</div>
                        <div class="btn-row">
                            <button class="btn" id="closeAIModal">关闭</button>
                        </div>
                        <div class="pending-warning">待接入,本轮不处理文件</div>
                    `);
                    $('aiDropZone').addEventListener('click', () => showToast('文件选择待接入'));
                    $('closeAIModal').addEventListener('click', closeModal);
                });

                // 功能二：模板机制
                $('saveTemplate').addEventListener('click', () => {
                    showModal(`
                        <h3>保存模板</h3>
                        <div class="template-input-row">
                            <input type="text" id="templateNameInput" placeholder="模板名称" maxlength="20">
                            <button class="btn btn-primary" id="confirmSaveTemplate">保存</button>
                        </div>
                        <div class="btn-row">
                            <button class="btn" id="closeSaveTemplateModal">取消</button>
                        </div>
                    `);
                    $('confirmSaveTemplate').addEventListener('click', () => {
                        const name = $('templateNameInput').value.trim();
                        if (!name) { showToast('请输入模板名称', 'error'); return; }
                        const templates = getTemplates();
                        const values = getHeaderValues();
                        templates.push({ name, savedAt: new Date().toISOString(), values });
                        saveTemplates(templates);
                        closeModal();
                        showToast(`模板「${name}」已保存`);
                    });
                    $('closeSaveTemplateModal').addEventListener('click', closeModal);
                });

                $('templateSelect').addEventListener('click', (e) => {
                    e.stopPropagation();
                    const templates = getTemplates();
                    let html = `<h3>选择模板</h3>`;
                    if (templates.length === 0) {
                        html += `<div style="padding:20px;text-align:center;color:#8a919f;">暂无模板</div>`;
                    } else {
                        html += `<div class="template-list">`;
                        templates.forEach((t, idx) => {
                            const date = new Date(t.savedAt).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
                            html += `<div class="template-item" data-idx="${idx}">
                                <span>${t.name} <span style="color:#8a919f;font-size:12px;">(${date})</span></span>
                                <span class="del-template" data-idx="${idx}">×</span>
                            </div>`;
                        });
                        html += `</div>`;
                    }
                    html += `<div class="btn-row"><button class="btn" id="closeTemplateModal">关闭</button></div>`;
                    showModal(html);
                    // 绑定选择
                    document.querySelectorAll('.template-item').forEach(item => {
                        item.addEventListener('click', function(e) {
                            if (e.target.classList.contains('del-template')) return;
                            const idx = parseInt(this.dataset.idx);
                            const t = getTemplates()[idx];
                            if (t) {
                                const count = applyHeaderValues(t.values);
                                closeModal();
                                showToast(`已套用模板「${t.name}」,共回填 ${count} 个字段`);
                            }
                        });
                    });
                    // 绑定删除
                    document.querySelectorAll('.del-template').forEach(del => {
                        del.addEventListener('click', function(e) {
                            e.stopPropagation();
                            const idx = parseInt(this.dataset.idx);
                            let templates = getTemplates();
                            templates.splice(idx, 1);
                            saveTemplates(templates);
                            // 重新渲染
                            $('templateSelect').click();
                        });
                    });
                    $('closeTemplateModal').addEventListener('click', closeModal);
                });
            }

            // 模态框管理
            function showModal(html) {
                closeModal();
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';
                overlay.id = 'modalOverlay';
                overlay.innerHTML = `<div class="modal-panel">${html}</div>`;
                document.body.appendChild(overlay);
                overlay.addEventListener('click', function(e) {
                    if (e.target === overlay) closeModal();
                });
            }
            function closeModal() {
                const overlay = $('modalOverlay');
                if (overlay) overlay.remove();
            }

            init();
        })();
