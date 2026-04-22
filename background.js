const tabData   = {};
const _pending  = {}; // requestId -> { tabId, url }
const scanCache = {}; // tabId -> last full scan result

const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|ico|css|woff2?|ttf|eot|svg|mp4|webm|mp3|wav|pdf|map|txt)(\?.*)?$/i;
const SKIP_HOSTS = /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|mixpanel|segment\.com|clarity\.ms|bat\.bing/i;

// Response headers worth capturing for recon
const RES_HDR_KEEP = new Set([
  'server', 'x-powered-by', 'x-aspnet-version', 'x-runtime', 'x-generator',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-credentials',
  'x-frame-options', 'content-security-policy', 'strict-transport-security',
  'x-content-type-options', 'x-xss-protection',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-rate-limit',
  'set-cookie', 'content-type',
  'x-version', 'api-version', 'x-api-version',
  'cf-ray', 'x-amzn-requestid', 'x-request-id',
]);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, method, type, requestId } = details;
    if (tabId < 0) return;
    if (SKIP_EXTENSIONS.test(url)) return;
    if (SKIP_HOSTS.test(url)) return;

    _pending[requestId] = { tabId, url };

    if (!tabData[tabId]) tabData[tabId] = [];
    const exists = tabData[tabId].some(r => r.url === url && r.method === (method || 'GET'));
    if (!exists) {
      tabData[tabId].push({
        url, method: method || 'GET', type, ts: Date.now(),
        status: null, resHeaders: null,
      });
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { requestId, statusCode, responseHeaders } = details;
    const meta = _pending[requestId];
    if (!meta) return;
    delete _pending[requestId];

    const { tabId, url } = meta;
    if (!tabData[tabId]) return;
    const entry = tabData[tabId].find(r => r.url === url);
    if (!entry) return;

    entry.status = statusCode;
    const rh = {};
    for (const h of (responseHeaders || [])) {
      const name = h.name.toLowerCase();
      if (!RES_HDR_KEEP.has(name)) continue;
      if (name === 'set-cookie') {
        if (!rh['set-cookie']) rh['set-cookie'] = [];
        rh['set-cookie'].push(h.value);
      } else {
        rh[name] = h.value;
      }
    }
    if (Object.keys(rh).length) entry.resHeaders = rh;
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabData[tabId] = [];
    // Clear cache only when navigating to a different domain;
    // preserve it for same-domain navigations so APIs accumulate across pages
    if (changeInfo.url) {
      try {
        const newHost = new URL(changeInfo.url).hostname;
        const cached = scanCache[tabId];
        if (!cached?.rootDomain || !newHost.endsWith(cached.rootDomain)) {
          delete scanCache[tabId];
        }
      } catch {
        delete scanCache[tabId];
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabData[tabId];
  delete scanCache[tabId];
});

// Lean API config used only by background to make calls
const PROVIDER_API = {
  gemini:      { apiType: 'gemini' },
  claude:      { apiType: 'anthropic',  defaultModel: 'claude-haiku-4-5-20251001' },
  openai:      { apiType: 'openai',     defaultModel: 'gpt-4o-mini',                              baseUrl: 'https://api.openai.com/v1' },
  grok:        { apiType: 'openai',     defaultModel: 'grok-3-mini',                              baseUrl: 'https://api.x.ai/v1' },
  groq:        { apiType: 'openai',     defaultModel: 'llama-3.1-8b-instant',                     baseUrl: 'https://api.groq.com/openai/v1' },
  cerebras:    { apiType: 'openai',     defaultModel: 'llama3.1-8b',                              baseUrl: 'https://api.cerebras.ai/v1' },
  sambanova:   { apiType: 'openai',     defaultModel: 'Meta-Llama-3.2-3B-Instruct',               baseUrl: 'https://api.sambanova.ai/v1' },
  siliconflow: { apiType: 'openai',     defaultModel: 'Qwen/Qwen2.5-7B-Instruct',                 baseUrl: 'https://api.siliconflow.cn/v1' },
  together:    { apiType: 'openai',     defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', baseUrl: 'https://api.together.xyz/v1' },
  fireworks:   { apiType: 'openai',     defaultModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  deepinfra:   { apiType: 'openai',     defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',    baseUrl: 'https://api.deepinfra.com/v1/openai' },
  novita:      { apiType: 'openai',     defaultModel: 'meta-llama/llama-3.1-8b-instruct',         baseUrl: 'https://api.novita.ai/v3/openai' },
  hyperbolic:  { apiType: 'openai',     defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',         baseUrl: 'https://api.hyperbolic.xyz/v1' },
  lepton:      { apiType: 'openai',     defaultModel: 'llama3-1-8b',                              baseUrl: 'https://api.lepton.ai/api/v1' },
  nvidia:      { apiType: 'openai',     defaultModel: 'meta/llama-3.1-8b-instruct',               baseUrl: 'https://integrate.api.nvidia.com/v1' },
  mistral:     { apiType: 'openai',     defaultModel: 'mistral-small-latest',                     baseUrl: 'https://api.mistral.ai/v1' },
  deepseek:    { apiType: 'openai',     defaultModel: 'deepseek-chat',                            baseUrl: 'https://api.deepseek.com/v1' },
  perplexity:  { apiType: 'openai',     defaultModel: 'sonar',                                    baseUrl: 'https://api.perplexity.ai' },
  cohere:      { apiType: 'openai',     defaultModel: 'command-r',                                baseUrl: 'https://api.cohere.com/compatibility/v1' },
  ai21:        { apiType: 'openai',     defaultModel: 'jamba-mini-1.6',                           baseUrl: 'https://api.ai21.com/studio/v1' },
  reka:        { apiType: 'openai',     defaultModel: 'reka-flash-3',                             baseUrl: 'https://api.reka.ai/v1' },
  inflection:  { apiType: 'openai',     defaultModel: 'inflection_3_pi',                          baseUrl: 'https://api.inflection.ai/v1' },
  qwen:        { apiType: 'openai',     defaultModel: 'qwen-turbo',                               baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  moonshot:    { apiType: 'openai',     defaultModel: 'moonshot-v1-8k',                           baseUrl: 'https://api.moonshot.cn/v1' },
  zhipu:       { apiType: 'openai',     defaultModel: 'glm-4-flash',                              baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  minimax:     { apiType: 'openai',     defaultModel: 'MiniMax-Text-01',                          baseUrl: 'https://api.minimax.chat/v1' },
  stepfun:     { apiType: 'openai',     defaultModel: 'step-1-mini',                              baseUrl: 'https://api.stepfun.com/v1' },
  hunyuan:     { apiType: 'openai',     defaultModel: 'hunyuan-lite',                             baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  yi:          { apiType: 'openai',     defaultModel: 'yi-lightning',                             baseUrl: 'https://api.lingyiwanwu.com/v1' },
  openrouter:  { apiType: 'openai',     defaultModel: 'meta-llama/llama-3.2-3b-instruct:free',    baseUrl: 'https://openrouter.ai/api/v1' },
  aimlapi:     { apiType: 'openai',     defaultModel: 'meta-llama/Llama-3.2-3B-Instruct-Turbo',   baseUrl: 'https://api.aimlapi.com/v1' },
  azure:       { apiType: 'openai',     defaultModel: 'gpt-4o-mini',                              baseUrl: '' },
  custom:      { apiType: 'openai',     defaultModel: '',                                         baseUrl: '' },
};

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
  if (msg.type === 'SAVE_KEY') {
    chrome.storage.local.set({ [`key_${msg.provider}`]: msg.key }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'DELETE_KEY') {
    chrome.storage.local.remove(`key_${msg.provider}`, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'SET_PROVIDER') {
    chrome.storage.local.set({ aiProvider: msg.provider }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'SAVE_MODEL') {
    chrome.storage.local.set({ [`model_${msg.provider}`]: msg.model }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'SAVE_URL') {
    chrome.storage.local.set({ [`url_${msg.provider}`]: msg.url }, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(null, (d) => {
      const keysSet = Object.keys(d).filter(k => k.startsWith('key_') && d[k]).map(k => k.slice(4));
      const models = {}, urls = {};
      Object.keys(d).forEach(k => {
        if (k.startsWith('model_') && d[k]) models[k.slice(6)] = d[k];
        if (k.startsWith('url_')   && d[k]) urls[k.slice(4)]   = d[k];
      });
      sendResponse({ provider: d.aiProvider || 'gemini', keysSet, models, urls });
    });
    return true;
  }
  if (msg.type === 'CACHE_SCAN') {
    scanCache[msg.tabId] = msg.data;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GET_SCAN_CACHE') {
    sendResponse({ data: scanCache[msg.tabId] || null });
    return true;
  }
  if (msg.type === 'AI_ANALYZE') {
    chrome.storage.local.get(null, async (d) => {
      const provider = d.aiProvider || 'gemini';
      const key = d[`key_${provider}`];
      if (!key) { sendResponse({ error: 'no API key set' }); return; }
      const cfg = PROVIDER_API[provider] || PROVIDER_API.custom;
      const model = d[`model_${provider}`] || cfg.defaultModel || '';
      const baseUrl = d[`url_${provider}`] || cfg.baseUrl || '';
      const prompt = msg.prompt;
      if (!prompt) { sendResponse({ error: 'empty prompt' }); return; }
      try {
        let result;
        if (cfg.apiType === 'gemini')         result = await callGemini(key, model, prompt);
        else if (cfg.apiType === 'anthropic') result = await callClaude(key, model, prompt);
        else                                  result = await callOpenAI(baseUrl, key, model, prompt);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;
  }
  return true;
});

async function callGemini(key, model, prompt) {
  const m = model || 'gemini-2.0-flash';
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }
  const data = await resp.json();
  return data.candidates[0].content.parts[0].text;
}

async function callClaude(key, model, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }
  const data = await resp.json();
  return data.content[0].text;
}

async function callOpenAI(baseUrl, key, model, prompt) {
  if (!baseUrl) throw new Error('no endpoint URL configured');
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'api-key': key,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}
