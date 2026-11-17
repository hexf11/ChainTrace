(() => {
  'use strict';
  const CHANNEL = 'gmgn-slot-index-extension-v1';
  const allowed = new Set(['settings', 'rpc', 'bundles']);
  const post = data => window.postMessage({channel: CHANNEL, direction: 'extension', ...data}, location.origin);
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.direction !== 'page') return;
    if (message.type === 'hello') { post({type: 'ready'}); return; }
    if (!allowed.has(message.type) || typeof message.id !== 'string' || message.id.length > 80) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: message.type, data: message.data, revision: message.revision, slot: message.slot,
      });
      post({type: 'response', id: message.id, ...response});
    } catch {
      post({type: 'response', id: message.id, ok: false, error: '扩展连接已断开，请刷新 GMGN 页面后重试'});
    }
  });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes['gsi.rpc.revision']) return;
    try {
      const result = await chrome.runtime.sendMessage({type: 'settings'});
      if (result.ok) post({type: 'settings-changed', value: result.value});
    } catch { /* An extension reload is recovered by refreshing the page. */ }
  });
  post({type: 'ready'});
})();
