const version = chrome.runtime.getManifest().version;
const status = document.getElementById('update-status');
const button = document.getElementById('check-update');
const link = document.getElementById('update-link');
const cacheKey = 'courseware:update-check';
const manifestURL = 'https://raw.githubusercontent.com/makelifeasier/chaoxing-courseware/main/extension/manifest.json';
document.getElementById('extension-version').textContent = 'v'+version;

function isNewer(remote) {
  const installed = version.split('.').map(Number);
  const candidate = remote.split('.').map(Number);
  for (let i = 0; i < Math.max(installed.length,candidate.length); i++) {
    const difference = (candidate[i] ?? 0) - (installed[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

async function checkUpdate(manual = false) {
  button.disabled = true;
  try {
    let cached;
    try { cached = JSON.parse(localStorage.getItem(cacheKey)); } catch { /* cache is optional */ }
    let latest = cached?.version;
    if (manual || !latest || Date.now()-cached.checkedAt > 86400000) {
      if (manual) status.textContent = '正在检查…';
      const response = await fetch(manifestURL,{
        credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store',
        redirect:'error', signal:AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error('无法读取版本');
      latest = (await response.json()).version;
      if (typeof latest !== 'string' || !/^\d+(\.\d+){1,3}$/.test(latest)) throw new Error('版本格式无效');
      try { localStorage.setItem(cacheKey,JSON.stringify({version:latest,checkedAt:Date.now()})); } catch { /* continue without cache */ }
    }
    const newer = isNewer(latest);
    link.hidden = !newer;
    status.textContent = newer ? '有新版本 v'+latest : manual ? '已是最新版' : '';
  } catch {
    if (manual) status.textContent = '暂时无法检查更新';
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click',()=>void checkUpdate(true));
void checkUpdate();
