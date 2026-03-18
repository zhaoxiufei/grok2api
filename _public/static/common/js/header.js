async function loadAdminHeader() {
  const container = document.getElementById('app-header');
  if (!container) return;
  try {
    const res = await fetch('/static/common/html/header.html?v=1.6.2');
    if (!res.ok) return;
    container.innerHTML = await res.text();
    const path = window.location.pathname;
    const links = container.querySelectorAll('a[data-nav]');
    links.forEach((link) => {
      const target = link.getAttribute('data-nav') || '';
      if (target && path.startsWith(target)) {
        link.classList.add('active');
        const group = link.closest('.nav-group');
        if (group) {
          const trigger = group.querySelector('.nav-group-trigger');
          if (trigger) {
            trigger.classList.add('active');
          }
        }
      }
    });
    if (window.I18n) {
      I18n.applyToDOM(container);
      var toggle = container.querySelector('#lang-toggle');
      if (toggle) toggle.textContent = I18n.getLang() === 'zh' ? 'EN' : '中';
    }
    if (typeof updateStorageModeButton === 'function') {
      updateStorageModeButton();
    }
    // 根据 function_enabled 配置决定是否显示工作空间按钮
    if (typeof ensureAdminKey === 'function') {
      ensureAdminKey().then(function (apiKey) {
        if (!apiKey) return;
        fetch('/v1/admin/config?key=app.function_enabled', {
          headers: buildAuthHeaders(apiKey)
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.value) {
              var link = document.getElementById('workspace-link');
              if (link) link.style.display = '';
            }
          })
          .catch(function () {});
      });
    }
  } catch (e) {
    // Fail silently to avoid breaking page load
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAdminHeader);
} else {
  loadAdminHeader();
}
