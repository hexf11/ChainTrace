'use strict';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BUNDLE_ID = /^[a-f0-9]{64}$/i;
const JITO_BASE = 'https://bundles.jito.wtf/api/v1/bundles/slot/';

function endpointURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('请填写有效的 http(s) RPC URL，不支持用户名、密码或 # 片段');
  }
  return url;
}

function isSettings(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('options.html');
}

function isPage(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab) return false;
  try { return ['https://gmgn.ai', 'https://www.gmgn.ai'].includes(new URL(sender.url).origin); }
  catch { return false; }
}

async function publicSettings() {
  const stored = await chrome.storage.local.get(['gsi.rpc', 'gsi.rpc.revision']);
  const result = {};
  // API keys in the path/query stay in extension storage and never enter the page.
  result['gsi.rpc.label'] = endpointURL(stored['gsi.rpc'] || DEFAULT_RPC).host;
  result['gsi.rpc.revision'] = stored['gsi.rpc.revision'] || 'default';
  return result;
}

function validatedRPC(data) {
  if (!data || !Number.isSafeInteger(data.id) || !Array.isArray(data.params)) throw new Error('RPC 请求格式无效');
  const params = data.params;
  const version = params[1]?.maxSupportedTransactionVersion ?? 0;
  if (!Number.isSafeInteger(version) || version < 0 || version > 127) throw new Error('交易版本无效');
  let clean;
  switch (data.method) {
    case 'getGenesisHash':
      if (params.length) throw new Error('RPC 参数无效');
      clean = [];
      break;
    case 'getSignatureStatuses':
      if (!Array.isArray(params[0]) || !params[0].length || params[0].length > 200 || !params[0].every(s => typeof s === 'string' && SIGNATURE.test(s))) throw new Error('交易签名无效');
      clean = [params[0], {searchTransactionHistory: true}];
      break;
    case 'getTransaction':
      if (typeof params[0] !== 'string' || !SIGNATURE.test(params[0])) throw new Error('交易签名无效');
      clean = [params[0], {commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: version}];
      break;
    case 'getBlock':
      if (!Number.isSafeInteger(params[0]) || params[0] < 0) throw new Error('Slot 无效');
      clean = [params[0], {commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: version}];
      break;
    default: throw new Error('仅支持 Slot / Index 所需的只读 RPC 方法');
  }
  return {jsonrpc: '2.0', id: data.id, method: data.method, params: clean};
}

let inFlight = 0;
async function rpcRequest(data, revision) {
  const body = validatedRPC(data);
  const stored = await chrome.storage.local.get(['gsi.rpc', 'gsi.rpc.revision']);
  if (revision !== (stored['gsi.rpc.revision'] || 'default')) throw new Error('RPC 设置已更新，请重新查询');
  const url = endpointURL(stored['gsi.rpc'] || DEFAULT_RPC);
  if (!await chrome.permissions.contains({origins: [`${url.protocol}//${url.hostname}/*`]})) {
    throw new Error('尚未授权该 RPC，请点击插件图标，在设置中重新保存并授权');
  }
  if (inFlight >= 4) throw new Error('RPC 请求繁忙，请稍后重试');
  inFlight++;
  const controller = new AbortController();
  // Finish before Chrome's 30-second service worker fetch deadline.
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url.href, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    const responseText = await response.text();
    if (responseText.length > 16 * 1024 * 1024) throw new Error('RPC 响应过大，请更换节点');
    return {status: response.status, responseText};
  } catch (error) {
    if (controller.signal.aborted) throw new Error('RPC 请求超时（25 秒），请重试或更换 RPC');
    if (error.message === 'RPC 响应过大，请更换节点') throw error;
    throw new Error('RPC 连接失败，请检查节点、网络和扩展的网站访问权限');
  } finally { clearTimeout(timer); inFlight--; }
}

// These are landed bundle records from Jito Explorer's own public index.
// Do not infer bundle membership from tips, neighboring indexes, or shared slots.
function normalizeBundles(payload, slot) {
  if (!Array.isArray(payload) || payload.length > 5000) throw new Error('Jito 索引响应格式已变化，暂不标记 bundle');
  const bundles = new Map();
  for (const row of payload) {
    const signatures = row?.txSignatures;
    if (!row || !BUNDLE_ID.test(row.bundleId) || row.slot !== slot
        || !Array.isArray(signatures) || signatures.length < 1 || signatures.length > 5
        || !signatures.every(sig => typeof sig === 'string' && SIGNATURE.test(sig))
        || new Set(signatures).size !== signatures.length
        || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) {
      throw new Error('Jito 索引记录不完整，暂不标记 bundle');
    }
    const record = {id: row.bundleId.toLowerCase(), slot, signatures: [...signatures]};
    const previous = bundles.get(record.id);
    if (previous && JSON.stringify(previous.signatures) !== JSON.stringify(record.signatures)) {
      throw new Error('Jito 索引记录冲突，暂不标记 bundle');
    }
    bundles.set(record.id, record);
  }
  return [...bundles.values()];
}

const bundleCache = new Map(), bundlePending = new Map();
let nextBundleAt = 0, bundleCooldownAt = 0;
async function bundleRequest(slot) {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Slot 无效');
  const cached = bundleCache.get(slot);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (bundlePending.has(slot)) return bundlePending.get(slot);
  if (!await chrome.permissions.contains({origins: ['https://bundles.jito.wtf/*']})) {
    throw new Error('尚未授权 Jito 索引访问，请刷新扩展并允许网站访问');
  }
  // Permissions checks are asynchronous: another tab may have queued this slot.
  if (bundlePending.has(slot)) return bundlePending.get(slot);
  if (Date.now() < bundleCooldownAt) throw new Error('Jito 索引暂不可用，稍后自动重试');
  if (bundlePending.size >= 3) throw new Error('Jito 索引查询繁忙，稍后自动重试');
  const startAt = Math.max(Date.now(), nextBundleAt);
  nextBundleAt = startAt + 1200;
  const task = (async () => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, startAt - Date.now())));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${JITO_BASE}${slot}`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) {
        bundleCooldownAt = Date.now() + (response.status === 429 ? 60000 : 15000);
        throw new Error(`Jito 索引 HTTP ${response.status}，归属暂未确认`);
      }
      const body = await response.text();
      if (body.length > 4 * 1024 * 1024) throw new Error('Jito 索引响应过大，归属暂未确认');
      let payload;
      try { payload = JSON.parse(body); } catch { throw new Error('Jito 索引未返回 JSON，归属暂未确认'); }
      const value = {slot, bundles: normalizeBundles(payload, slot), checkedAt: Date.now()};
      bundleCache.delete(slot);
      bundleCache.set(slot, {value, expires: Date.now() + 30000});
      while (bundleCache.size > 128) bundleCache.delete(bundleCache.keys().next().value);
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Jito 索引查询超时，归属暂未确认');
      if (error.message.startsWith('Jito ')) throw error;
      throw new Error('Jito 索引连接失败，归属暂未确认');
    } finally { clearTimeout(timer); }
  })();
  bundlePending.set(slot, task);
  try { return await task; }
  finally { bundlePending.delete(slot); }
}

async function handle(message, sender) {
  if (!message || (!isPage(sender) && !isSettings(sender))) throw new Error('消息来源无效');
  switch (message.type) {
    case 'settings': return publicSettings();
    case 'rpc': return rpcRequest(message.data, message.revision);
    case 'bundles': return bundleRequest(message.slot);
    default: throw new Error('不支持的操作');
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = {endpointURL, validatedRPC, handle, rpcRequest, publicSettings, normalizeBundles, bundleRequest};
}
if (typeof chrome !== 'undefined') {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    handle(message, sender).then(value => respond({ok: true, value}), error => respond({ok: false, error: error.message}));
    return true;
  });
}
