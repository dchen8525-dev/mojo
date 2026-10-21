/* v3 共用交互：工具卡展开、上浮菜单开合、目录/权限回填、输入框自增高 */
(function () {
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }

  var panels = $$('.pop');
  function closeAll(keep) {
    panels.forEach(function (p) { if (p.id !== keep) p.classList.add('hidden'); });
  }

  /* 工具卡展开 */
  $$('.tool-head').forEach(function (h) {
    h.onclick = function () { h.parentNode.classList.toggle('open'); };
  });

  /* 上浮菜单：任意 [data-pop="面板id"] 可开合 */
  $$('[data-pop]').forEach(function (el) {
    el.onclick = function (e) {
      e.stopPropagation();
      var p = document.getElementById(el.dataset.pop);
      if (!p) return;
      var willOpen = p.classList.contains('hidden');
      closeAll(willOpen ? p.id : null);
      p.classList.toggle('hidden', !willOpen);
    };
  });
  panels.forEach(function (p) {
    p.onclick = function (e) { e.stopPropagation(); };
  });
  document.addEventListener('click', function () { closeAll(); });

  /* 选中菜单项 → 回填按钮文字，并标记当前项 */
  $$('.pop-item[data-set]').forEach(function (b) {
    b.onclick = function () {
      var label = b.dataset.label || (b.querySelector('.p-name') || {}).textContent || '';
      $$(b.dataset.set).forEach(function (t) { t.textContent = label; });
      var menu = b.closest('.pop');
      if (menu && menu.dataset.pick === 'one') {
        $$('.pop-item', menu).forEach(function (o) { o.classList.toggle('on', o === b); });
      }
      closeAll();
    };
  });

  /* 输入框自增高 + 空输入时置灰发送 */
  var ta = $('#input'), send = $('#send');
  if (ta) {
    ta.oninput = function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(180, ta.scrollHeight) + 'px';
      if (send) send.disabled = !ta.value.trim();
    };
    ta.dispatchEvent(new Event('input'));
  }
})();
