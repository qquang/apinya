// Per-tab network request log
const tabData = {};

const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|ico|css|woff2?|ttf|eot|svg|mp4|webm|mp3|wav|pdf|map|txt)(\?.*)?$/i;
const SKIP_HOSTS = /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|mixpanel|segment\.com|clarity\.ms|bat\.bing/i;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, method, type } = details;
    if (tabId < 0) return;
    if (SKIP_EXTENSIONS.test(url)) return;
    if (SKIP_HOSTS.test(url)) return;

    if (!tabData[tabId]) tabData[tabId] = [];

    // Avoid duplicates in same session
    const exists = tabData[tabId].some(r => r.url === url && r.method === (method || 'GET'));
    if (!exists) {
      tabData[tabId].push({
        url,
        method: method || 'GET',
        type,
        ts: Date.now()
      });
    }
  },
  { urls: ['<all_urls>'] }
);

// Reset on new page load
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabData[tabId] = [];
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabData[tabId];
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_NETWORK') {
    sendResponse({ data: tabData[msg.tabId] || [] });
    return true;
  }
  if (msg.type === 'CLEAR') {
    tabData[msg.tabId] = [];
    sendResponse({ ok: true });
    return true;
  }
  return true;
});
