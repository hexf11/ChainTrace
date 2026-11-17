'use strict';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const input = document.getElementById('rpc');
const status = document.getElementById('status');
const buttons = [...document.querySelectorAll('button')];
function show(message, error = false) { status.textContent = message; status.dataset.error = String(error); }
function busy(value) { for (const button of buttons) button.disabled = value; input.disabled = value; }
function readURL(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写有效的 http(s) RPC URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('请填写有效的 http(s) RPC URL，不支持用户名、密码或 # 片段');
  return url;
}
async function save(value) {
  try {
    const url = readURL(value);
    // Request immediately inside the click/submit gesture, before any await.
    const permission = chrome.permissions.request({origins: [`${url.protocol}//${url.hostname}/*`]});
    busy(true);
    if (!await permission) throw new Error('未获得该 RPC 的访问权限，设置未更改');
    await chrome.storage.local.set({'gsi.rpc': url.href, 'gsi.rpc.revision': crypto.randomUUID()});
    input.value = url.href;
    show('RPC 已保存，已自动应用。');
  } catch (error) { show(error.message, true); }
  finally { busy(false); }
}
document.getElementById('settings').addEventListener('submit', event => { event.preventDefault(); save(input.value); });
document.getElementById('reset').addEventListener('click', () => save(DEFAULT_RPC));
document.getElementById('test').addEventListener('click', async () => {
  busy(true); show('正在测试已保存的 RPC…');
  try {
    const stored = await chrome.storage.local.get(['gsi.rpc.revision']);
    const response = await chrome.runtime.sendMessage({type: 'rpc', revision: stored['gsi.rpc.revision'] || 'default', data: {id: 1, method: 'getGenesisHash', params: []}});
    if (!response?.ok) throw new Error(response?.error || '扩展连接失败');
    if (response.value.status !== 200) throw new Error(`RPC HTTP ${response.value.status}，请更换节点或稍后重试`);
    let body;
    try { body = JSON.parse(response.value.responseText); } catch { throw new Error('RPC 返回了非 JSON 内容'); }
    if (body.error) throw new Error(String(body.error.message || 'RPC 返回错误'));
    if (body.result !== MAINNET) throw new Error('该节点不是 Solana 主网');
    show('主网连接正常，历史查询支持情况以实际查询为准。');
  } catch (error) { show(error.message, true); }
  finally { busy(false); }
});
busy(true);
chrome.storage.local.get('gsi.rpc').then(stored => { input.value = stored['gsi.rpc'] || DEFAULT_RPC; })
  .catch(() => show('读取设置失败，请重新打开弹窗', true)).finally(() => busy(false));
