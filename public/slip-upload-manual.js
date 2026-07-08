// 手动多行分摊（2026-07-09 Damon授权补UI）：一笔汇款拆多票（含CN负数冲减）时逐行录入。
// 候选为空或不够时，在确认区"＋加一行"逐行填 合同号/订单号/BL/CY号/CN号 + 金额。
window.SlipManual = (function () {
  let box = null;
  let hint = null;
  let notify = null;

  function rowEls() {
    return box ? [...box.querySelectorAll('.manual-row')] : [];
  }

  function rows() {
    return rowEls().map(div => {
      const refInput = div.querySelector('.manual-ref');
      const amountInput = div.querySelector('.manual-amount');
      const raw = amountInput.value.trim();
      const n = Number(raw.replace(/,/g, ''));
      return {
        ref: refInput.value.trim(),
        amount: raw !== '' && Number.isFinite(n) ? n.toFixed(2) : null,
        amountInput
      };
    });
  }

  function updateHint() {
    if (!hint) return;
    const total = Number(String(currentSlip?.amount ?? '').replace(/,/g, '')) || 0;
    const filled = rows().filter(r => r.ref && r.amount !== null);
    if (!filled.length) { hint.textContent = ''; return; }
    const sum = filled.reduce((s, r) => s + Number(r.amount), 0);
    const diff = Math.round((total - sum) * 100) / 100;
    hint.textContent = `手动分摊合计 ${sum.toFixed(2)} ｜ 水单总额 ${total.toFixed(2)} ｜ 差额 ${diff.toFixed(2)}`;
    hint.style.color = Math.abs(diff) < 0.01 ? '#065f46' : '#b91c1c';
  }

  function addRow(focus) {
    const div = document.createElement('div');
    div.className = 'manual-row';
    div.style.cssText = 'display:grid;grid-template-columns:1fr 150px 22px;gap:8px;margin-top:8px;align-items:center';
    div.innerHTML = '<input type="text" class="manual-ref" placeholder="合同号 / 订单号 / BL / CY号 / CN号">' +
      '<input type="number" class="manual-amount" step="0.01" placeholder="金额，可为负">' +
      '<a href="#" class="manual-rm" style="color:#dc2626;text-decoration:none">✕</a>';
    div.querySelector('.manual-ref').addEventListener('input', () => { if (notify) notify(); updateHint(); });
    div.querySelector('.manual-amount').addEventListener('input', e => { e.target.dataset.touched = '1'; updateHint(); });
    div.querySelector('.manual-rm').addEventListener('click', e => {
      e.preventDefault();
      div.remove();
      if (!rowEls().length) addRow(false);
      if (notify) notify();
      updateHint();
    });
    box.appendChild(div);
    if (focus) div.querySelector('.manual-ref').focus();
  }

  function init(container, addLink, hintEl, onChange) {
    box = container;
    hint = hintEl;
    notify = onChange;
    box.innerHTML = '';
    addRow(false);
    updateHint();
    if (addLink) addLink.onclick = e => { e.preventDefault(); addRow(true); };
  }

  return { init, rows, updateHint };
})();
