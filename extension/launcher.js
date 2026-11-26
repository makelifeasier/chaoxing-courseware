(() => {
  if (window.top !== window || document.getElementById('cx-courseware-extension-launcher')) return;
  const host = document.createElement('div');
  host.id = 'cx-courseware-extension-launcher';
  host.style.cssText = 'position:fixed;right:24px;bottom:94px;z-index:2147483646';
  const root = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.textContent = '课件批量下载';
  button.style.cssText = 'border:0;border-radius:24px;background:#165dff;color:white;padding:13px 20px;font:600 14px system-ui;cursor:pointer;box-shadow:0 4px 18px #165dff44';
  button.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_COURSEWARE' }).catch(() => {
      button.textContent = '扩展已更新，请刷新课程页';
    });
  });
  root.append(button);
  document.documentElement.append(host);
})();
