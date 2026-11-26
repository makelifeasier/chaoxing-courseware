async function openManager(tab) {
  if (!tab?.id) return;
  const target = chrome.runtime.getURL(`manager.html?source=${tab.id}`);
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('manager.html*') });
  const match = existing.find(t => t.url === target);
  if (match) await chrome.tabs.update(match.id, { active: true });
  else await chrome.tabs.create({ url: target });
}
chrome.action.onClicked.addListener(openManager);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'OPEN_COURSEWARE' && sender.tab) void openManager(sender.tab);
});
chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[tabId+1]}).catch(()=>{});
});
