/* 5 个方案共用的交互：视图切换、工具卡展开、项目浮层开合、输入框自增高 */
(function () {
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }

  var panels = $$('.pop, .pop-panel');
  function closeAll(keep) {
    panels.forEach(function (p) { if (p.id !== keep) p.classList.add('hidden'); });
  }

  /* 视图切换：欢迎页 / 对话 / 授权弹窗 */
  var btns = $$('.demo-switch button');
  var perm = $('#perm-modal');
  function setView(v) {
    document.body.dataset.view = v;
    btns.forEach(function (b) { b.classList.toggle('active', b.dataset.view === v); });
    if (perm) perm.classList.toggle('hidden', v !== 'perm');
    closeAll();
  }
  btns.forEach(function (b) { b.onclick = function () { setView(b.dataset.view); }; });

  /* 工具卡展开 */
  $$('.tool-head').forEach(function (h) {
    h.onclick = function () { h.parentNode.classList.toggle('open'); };
  });

  /* 项目浮层：任意 [data-pop="面板id"] 可开合 */
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
  /* 浮层内部点击不关闭；模态遮罩点击关闭 */
  panels.forEach(function (p) {
    var inner = p.querySelector('.modal-card') || p;
    inner.onclick = function (e) { e.stopPropagation(); };
  });
  document.addEventListener('click', function () { closeAll(); });

  /* 浮层里选一个目录 → 刷新按钮/状态栏上的路径文本（输入框则填 value） */
  $$('.pop-item[data-set], .chip[data-set]').forEach(function (b) {
    b.onclick = function () {
      var path = b.dataset.label || (b.querySelector('.p-path') || {}).textContent || '';
      $$(b.dataset.set).forEach(function (t) {
        if (t.tagName === 'INPUT') t.value = path;
        else t.textContent = path;
      });
      closeAll();
    };
  });

  /* 输入框自增高 */
  var ta = $('#input');
  if (ta) {
    ta.oninput = function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(180, ta.scrollHeight) + 'px';
    };
  }
})();
