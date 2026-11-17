// ChainTrace: automatic transaction positions and verified Jito bundle groups.
(function () {
  'use strict';
  const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
  const ROW = '[data-testid="token-detail-activity-row"]';
  const TIME = '[data-testid="table-cell-timestamp"]';
  const HEAD = '[data-testid="table-sort-timestamp"]';
  const own = '[data-gsi-owned]';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  function epochSecond(value) {
    // Do not guess dates from relative ages, chart coordinates or browser timezones.
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const seconds = number > 1e12 ? number / 1000 : number;
    return Number.isFinite(seconds) && seconds >= 1262304000 && seconds < 7258118400 ? Math.floor(seconds) : null;
  }
  function extractTrades(payload) {
    const found = new Map(), seen = new WeakSet();
    let visited = 0;
    function visit(value, depth) {
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 7 || ++visited > 16000) return;
      seen.add(value);
      const sig = ['tx_hash', 'txHash', 'txhash', 'transaction_hash', 'signature', 'hash'].map(k => value[k]).find(v => typeof v === 'string' && SIGNATURE.test(v));
      const second = ['timestamp', 'time', 'block_timestamp', 'blockTime', 'block_time', 'created_at'].map(k => epochSecond(value[k])).find(v => v !== null);
      if (sig && second !== undefined) found.set(sig, {signature: sig, second});
      if (Array.isArray(value)) { for (const item of value.slice(0, 6000)) visit(item, depth + 1); }
      else for (const key of Object.keys(value).slice(0, 80)) {
        // Network data only, or a narrowly scoped component's props. Skip framework cycles.
        if (!['children', 'owner', '_owner', 'return', 'stateNode'].includes(key)) visit(value[key], depth + 1);
      }
    }
    visit(payload, 0);
    return [...found.values()];
  }
  function filterDate(second) {
    const d = new Date(second * 1000), pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // Installed before GMGN creates its widget. This is passive: normal chart events
  // and requests are passed through; only explicit candle clicks activate the UI.
  function createPageBridge(page, doc) {
    const bridge = {enabled: false, onCandle: null, onTrades: null, chartCount: 0, error: '', records: new Map(), responses: [], pending: 0};
    const widgets = new WeakSet(), charts = new WeakSet(), documents = new WeakMap(), wrapped = new WeakSet(), chartRecords = new Set();
    const now = () => Date.now();
    let lastCandle = '', lastCandleAt = 0;
    function token() { return page.location.pathname.match(/\/sol\/token\/([^/]+)/)?.[1] || ''; }
    function remember(url, payload, startedAt = now()) {
      try {
        const u = new URL(url, page.location.href);
        const match = u.pathname.match(/\/token_trades(?:_v\d+)?\/sol\/([^/]+)/);
        if (u.origin !== page.location.origin || !match || match[1] !== token()) return;
        const trades = extractTrades(payload);
        for (const trade of trades) bridge.records.set(`${match[1]}:${trade.signature}`, trade);
        while (bridge.records.size > 10000) bridge.records.delete(bridge.records.keys().next().value);
        const data = payload?.data || payload;
        if (payload?.code !== undefined && Number(payload.code) !== 0) return;
        const arrays = Array.isArray(data) ? [data] : ['history', 'trades', 'list', 'items', 'records'].map(k => data?.[k]).filter(Array.isArray);
        const emptyList = arrays.some(list => list.length === 0);
        if (!trades.length && !emptyList) return;
        const cursorKeys = ['next', 'next_cursor', 'nextCursor'];
        const cursorKey = cursorKeys.find(k => data && Object.prototype.hasOwnProperty.call(data, k));
        const response = {at: now(), startedAt, token: match[1], trades, count: trades.length,
          limit: Number(u.searchParams.get('limit')) || 50,
          ended: cursorKey !== undefined ? !data[cursorKey] : data?.has_more === false || data?.has_next === false || emptyList || (trades.length > 0 && trades.length < (Number(u.searchParams.get('limit')) || 50))};
        bridge.responses.push(response);
        if (bridge.responses.length > 40) bridge.responses.shift();
        bridge.onTrades?.(response);
      } catch { /* A failed observation must never break GMGN's request. */ }
    }
    if (typeof page.fetch === 'function') {
      const original = page.fetch;
      page.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
        const relevant = /\/token_trades(?:_v\d+)?\/sol\//.test(url);
        const startedAt = now();
        if (relevant) bridge.pending++;
        const request = original.apply(this, args);
        if (relevant) Promise.resolve(request).then(async response => {
          try { if (response.ok) remember(url, await response.clone().json(), startedAt); }
          catch { /* Original response is untouched. */ }
        }).catch(() => {}).finally(() => { bridge.pending--; });
        return request;
      };
    }
    try {
      const proto = page.XMLHttpRequest?.prototype;
      if (proto) {
        const original = proto.open, requests = new WeakMap();
        proto.open = function (method, url, ...args) {
          requests.set(this, String(url));
          return original.call(this, method, url, ...args);
        };
        const send = proto.send;
        proto.send = function (...args) {
          const url = requests.get(this) || '';
          if (/\/token_trades(?:_v\d+)?\/sol\//.test(url)) {
            const startedAt = now();
            bridge.pending++;
            this.addEventListener('loadend', () => {
              try { if (this.status === 200) remember(url, this.responseType === 'json' ? this.response : JSON.parse(this.responseText), startedAt); }
              catch { /* Original XHR is untouched. */ }
              finally { bridge.pending--; }
            }, {once: true});
          }
          return send.apply(this, args);
        };
      }
    } catch { /* fetch and component props remain available. */ }

    function emit(record) {
      if (!bridge.enabled || !record.last || now() - record.last.at > 1500) return;
      let resolution, symbol;
      try { resolution = String(record.chart.resolution()); symbol = String(record.chart.symbol()); }
      catch { return; }
      if (resolution.toUpperCase() !== '1S') { bridge.error = '请切换到 1s K 线后点选'; return; }
      bridge.error = '';
      if (!symbol.includes(token())) return;
      const second = epochSecond(record.last.time);
      if (second === null) return;
      const identity = `${token()}:${second}`;
      if (identity === lastCandle && now() - lastCandleAt < 450) return;
      lastCandle = identity; lastCandleAt = now();
      bridge.onCandle?.({second, token: token()});
    }
    function bindDocument(frameDoc, record) {
      if (!frameDoc) return;
      if (documents.has(frameDoc)) { documents.get(frameDoc).record = record; return; }
      const state = {record};
      documents.set(frameDoc, state);
      let down = null;
      frameDoc.addEventListener('pointerdown', event => {
        if (event.button === 0 && event.target.closest?.('canvas')) down = {x: event.clientX, y: event.clientY, moved: false, id: event.pointerId};
      }, true);
      frameDoc.addEventListener('pointermove', event => {
        if (down && event.pointerId === down.id && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down.moved = true;
      }, true);
      frameDoc.addEventListener('pointerup', event => {
        if (!down || event.pointerId !== down.id) return;
        const valid = !down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 5;
        down = null;
        if (valid) setTimeout(() => emit(state.record), 0);
      }, true);
      for (const event of ['pointercancel', 'wheel']) frameDoc.addEventListener(event, () => { down = null; state.record.last = null; }, true);
    }
    function attach(widget, options) {
      if (!widget || typeof widget.activeChart !== 'function' || widgets.has(widget)) return;
      widgets.add(widget);
      function ready() {
        try {
          const count = typeof widget.chartsCount === 'function' ? widget.chartsCount() : 1;
          for (let i = 0; i < count; i++) {
            const chart = typeof widget.chart === 'function' ? widget.chart(i) : widget.activeChart();
            if (!chart || charts.has(chart)) continue;
            const record = {chart, last: null, down: null, container: options?.container || options?.container_id};
            chart.crossHairMoved().subscribe(record, event => {
              record.last = epochSecond(event?.time) === null ? null : {time: event.time, at: now()};
            });
            charts.add(chart);
            bridge.chartCount++;
            chartRecords.add(record);
            if (chartRecords.size > 32) chartRecords.delete(chartRecords.values().next().value);
            // Widget events also work when the iframe document is not directly exposed.
            const coords = e => ({x: e?.clientX ?? e?.x ?? e?.point?.x, y: e?.clientY ?? e?.y ?? e?.point?.y});
            if (typeof widget.subscribe === 'function' && i === 0) {
              const subscribe = (name, callback) => { try { widget.subscribe(name, callback); } catch { /* Optional event in this library version. */ } };
              subscribe('mouse_down', e => { record.down = {...coords(e), at: now(), moved: false}; });
              subscribe('mouse_move', e => {
                const p = coords(e);
                if (record.down && Number.isFinite(p.x) && Math.hypot(p.x - record.down.x, p.y - record.down.y) > 5) record.down.moved = true;
              });
              subscribe('mouse_up', e => {
                const p = coords(e), start = record.down;
                record.down = null;
                if (start && !start.moved && now() - start.at < 700 && Number.isFinite(p.x) && Number.isFinite(start.x)
                    && Math.hypot(p.x - start.x, p.y - start.y) <= 5) setTimeout(() => emit(record), 0);
              });
            }
            bindFrames(record);
          }
        } catch (e) { widgets.delete(widget); bridge.error = `图表连接中：${e.message}`; }
      }
      try { if (typeof widget.onChartReady === 'function') widget.onChartReady(ready); else ready(); }
      catch { widgets.delete(widget); }
    }
    function bindFrames(record) {
      const container = typeof record.container === 'string' ? doc.getElementById(record.container) : record.container;
      const frames = (container || doc).querySelectorAll('iframe[id^="tradingview_"],iframe[title="Financial Chart"]');
      if (!container && frames.length !== 1) return;
      for (const frame of frames) {
        try { bindDocument(frame.contentDocument, record); } catch { /* Widget events cover inaccessible frames. */ }
      }
    }
    function wrapTradingView(tv) {
      if (!tv || typeof tv !== 'object') return tv;
      function wrap(ctor) {
        if (typeof ctor !== 'function' || wrapped.has(ctor)) return ctor;
        const proxy = new Proxy(ctor, {construct(target, args, newTarget) {
          const widget = Reflect.construct(target, args, newTarget);
          attach(widget, args[0]);
          return widget;
        }});
        wrapped.add(proxy);
        return proxy;
      }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(tv, 'widget');
        if (!descriptor || descriptor.configurable) {
          let value = wrap(tv.widget);
          Object.defineProperty(tv, 'widget', {configurable: true, enumerable: true, get: () => value, set: next => { value = wrap(next); }});
        } else if (descriptor.writable) tv.widget = wrap(tv.widget);
      } catch { /* Existing exposed widget refs are also discovered below. */ }
      return tv;
    }
    try {
      const descriptor = Object.getOwnPropertyDescriptor(page, 'TradingView');
      if (!descriptor || (descriptor.configurable && !descriptor.get && !descriptor.set)) {
        let value = wrapTradingView(page.TradingView);
        Object.defineProperty(page, 'TradingView', {configurable: true, enumerable: true, get: () => value, set: next => { value = wrapTradingView(next); }});
      } else wrapTradingView(page.TradingView);
    } catch { /* Poll exposed refs without replacing non-configurable globals. */ }
    bridge.discover = () => {
      const contexts = [page];
      for (const frame of doc.querySelectorAll('iframe[id^="tradingview_"],iframe[title="Financial Chart"]')) {
        try { if (frame.contentWindow) contexts.push(frame.contentWindow); } catch { /* Cross-origin. */ }
      }
      for (const context of contexts) {
        for (const key of ['tvWidget', 'tradingViewWidget', 'tradingviewWidget', 'chartWidget', 'widget', '_tvWidget', '__tvWidget']) {
          try { attach(context[key]); } catch { /* Cross-origin or stale refs. */ }
        }
      }
      // ESM imports may keep the widget in a React useRef instead of a global.
      // Inspect only refs in the chart container's ancestor components.
      const seen = new WeakSet();
      for (const frame of doc.querySelectorAll('iframe[id^="tradingview_"],iframe[title="Financial Chart"]')) {
        let element = frame.parentElement;
        for (let level = 0; element && level < 5; level++, element = element.parentElement) {
          const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
          let fiber = key ? element[key] : null;
          for (let parents = 0; fiber && parents < 10; parents++, fiber = fiber.return) {
            if (seen.has(fiber)) break;
            seen.add(fiber);
            let hook = fiber.memoizedState;
            for (let i = 0; hook && i < 35; i++, hook = hook.next) {
              try {
                const value = hook.memoizedState;
                attach(value);
                attach(value?.widget);
                attach(value?.tvWidget);
                attach(value?.current);
                attach(value?.current?.widget);
                attach(value?.current?.tvWidget);
              } catch { /* Unrelated hook state is ignored. */ }
            }
          }
        }
      }
      for (const record of chartRecords) bindFrames(record);
    };
    bridge.ingest = remember;
    bridge.attach = attach;
    bridge.connected = () => [...chartRecords].some(record => {
      try { return String(record.chart.symbol()).includes(token()); } catch { return false; }
    });
    return bridge;
  }

  function signatureFromHref(href) {
    try {
      const u = new URL(href, 'https://gmgn.ai');
      if (!['solscan.io', 'solana.fm', 'explorer.solana.com'].includes(u.hostname)) return null;
      const match = u.pathname.match(/^\/(?:tx|txs)\/([1-9A-HJ-NP-Za-km-z]+)\/?$/);
      return match && SIGNATURE.test(match[1]) ? match[1] : null;
    } catch { return null; }
  }

  function blockSummary(block) {
    if (!Array.isArray(block?.signatures)) {
      throw new Error('RPC 未返回区块交易签名列表，请使用支持历史 getBlock 的 RPC');
    }
    const indexes = new Map();
    block.signatures.forEach((signature, index) => {
      if (typeof signature !== 'string' || !SIGNATURE.test(signature) || indexes.has(signature)) {
        throw new Error('RPC 区块交易签名缺失、无效或重复');
      }
      indexes.set(signature, index);
    });
    return {indexes};
  }

  function verifiedBundleMembers(records, slot, indexes) {
    const candidates = new Map(), owners = new Map(), conflicts = new Set();
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !/^[a-f0-9]{64}$/.test(record.id) || record.slot !== slot
          || !Array.isArray(record.signatures) || record.signatures.length < 1 || record.signatures.length > 5
          || !record.signatures.every(sig => typeof sig === 'string' && SIGNATURE.test(sig))
          || new Set(record.signatures).size !== record.signatures.length) continue;
      const positions = record.signatures.map(sig => indexes.get(sig));
      if (!positions.every((index, i) => Number.isSafeInteger(index) && index >= 0 && (i === 0 || index > positions[i - 1]))) continue;
      const previous = candidates.get(record.id);
      if (previous && JSON.stringify(previous.signatures) !== JSON.stringify(record.signatures)) conflicts.add(record.id);
      candidates.set(record.id, record);
      for (const sig of record.signatures) {
        if (owners.has(sig) && owners.get(sig) !== record.id) { conflicts.add(record.id); conflicts.add(owners.get(sig)); }
        owners.set(sig, record.id);
      }
    }
    const members = new Map();
    for (const record of candidates.values()) {
      // Jito also indexes single-transaction submissions. Keep them in conflict
      // checks above, but never promote them to multi-transaction evidence.
      if (conflicts.has(record.id) || record.signatures.length < 2) continue;
      for (const sig of record.signatures) members.set(sig, record);
    }
    return members;
  }

  // Call separately for each activity list, in visual row order. Only confirmed
  // results may form a group; a shared Slot alone is not a shared transaction.
  function transactionGroups(entries) {
    const valid = entries.map(result => result?.state === 'done'
      && Number.isSafeInteger(result.slot) && result.slot >= 0
      && Number.isSafeInteger(result.index) && result.index >= 0);
    const candidates = entries.map((result, i) => valid[i] && result.bundle?.slot === result.slot
      && /^[a-f0-9]{64}$/.test(result.bundle.id) && Array.isArray(result.bundle.signatures)
      && result.bundle.signatures.length >= 2 && result.bundle.signatures.length <= 5
      && new Set(result.bundle.signatures).size === result.bundle.signatures.length
      && result.bundle.signatures.includes(result.signature) ? result.bundle : null);
    // A trade plus a separate tip is a two-signature submission, but it is not
    // two trades in this activity list. Require two distinct visible signatures;
    // duplicated activity rows never count as a second transaction.
    const visibleMembers = new Map();
    candidates.forEach((bundle, i) => {
      if (!bundle) return;
      if (!visibleMembers.has(bundle.id)) visibleMembers.set(bundle.id, new Set());
      visibleMembers.get(bundle.id).add(entries[i].signature);
    });
    const bundles = candidates.map(bundle => bundle && visibleMembers.get(bundle.id).size >= 2 ? bundle : null);
    const keys = entries.map((result, i) => !valid[i] ? null
      : bundles[i] ? `bundle:${bundles[i].id}` : `${result.slot}:${result.index}`);
    const counts = new Map(), transactions = new Map();
    for (const key of keys) if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
    keys.forEach((key, i) => {
      if (key === null) return;
      if (!transactions.has(key)) transactions.set(key, new Set());
      transactions.get(key).add(entries[i].index);
    });
    return keys.map((key, index) => {
      if (key === null || (!bundles[index] && counts.get(key) < 2)) return null;
      const previous = keys[index - 1] === key, next = keys[index + 1] === key;
      let hash = 0;
      for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      return {key, count: counts.get(key), tone: hash % 5, kind: bundles[index] ? 'bundle' : 'transaction',
        bundle: bundles[index], visibleTransactions: transactions.get(key).size,
        edge: previous ? (next ? 'middle' : 'end') : (next ? 'start' : 'single')};
    });
  }

  // All calls go through the endpoint explicitly chosen in extension settings.
  function createClient(endpoint, transport, wait = pause) {
    let id = 0;
    let nextAt = 0;
    return async function rpc(method, params = []) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await wait(Math.max(0, nextAt - Date.now()));
        nextAt = Date.now() + 400;
        try {
          const response = await transport(endpoint, {jsonrpc: '2.0', id: ++id, method, params});
          if (response.status !== 200) {
            const error = new Error(response.status === 429 ? 'RPC 限流，请稍后重试或更换 RPC' : `RPC HTTP ${response.status}，可在 RPC 设置中更换节点`);
            error.status = response.status;
            error.retry = response.status === 429 || response.status >= 500;
            throw error;
          }
          let body;
          try { body = JSON.parse(response.responseText); }
          catch { throw new Error('RPC 返回了非 JSON 内容'); }
          if (body.error) {
            const error = new Error(String(body.error.message || `RPC 错误 ${body.error.code}`));
            error.code = body.error.code;
            error.retry = body.error.code === 429 || /rate.limit|too many/i.test(error.message);
            throw error;
          }
          if (!Object.prototype.hasOwnProperty.call(body, 'result')) throw new Error('RPC 响应缺少 result');
          return body.result;
        } catch (error) {
          if (!error.retry || attempt === 2) throw error;
          await wait(1200 * (attempt + 1));
        }
      }
    };
  }

  async function versionedRead(rpc, method, value, options) {
    let version = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await rpc(method, [value, {...options, maxSupportedTransactionVersion: version}]);
      } catch (error) {
        const match = error.message.match(/maxSupportedTransactionVersion["'\s:]+(\d+)/);
        if (attempt === 0 && error.code === -32015 && match && Number(match[1]) <= 127) {
          version = Number(match[1]);
        } else throw error;
      }
    }
  }

  async function transactionSlot(rpc, signature) {
    const tx = await versionedRead(rpc, 'getTransaction', signature, {encoding: 'json', commitment: 'finalized'});
    if (!Number.isSafeInteger(tx?.slot)) throw new Error('交易尚未最终确认，或 RPC 未保留历史交易；请稍后重试 / 更换归档 RPC');
    return tx.slot;
  }
  async function readBlockSummary(rpc, slot) {
    return blockSummary(await versionedRead(rpc, 'getBlock', slot, {
      commitment: 'finalized', transactionDetails: 'signatures', rewards: false,
    }));
  }

  function createExtensionAdapter() {
    const CHANNEL = 'gmgn-slot-index-extension-v1';
    const pending = new Map();
    let values = {}, serial = 0, ready = false, readyResolve;
    const readiness = new Promise(resolve => { readyResolve = resolve; });
    const post = message => window.postMessage({channel: CHANNEL, direction: 'page', ...message}, location.origin);
    const adapter = {
      onSettings: null,
      get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
      request(type, data = {}) {
        return new Promise((resolve, reject) => {
          const id = `${Date.now()}-${++serial}`;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('扩展响应超时，请刷新页面重试')); }, 30000);
          pending.set(id, {resolve, reject, timer});
          post({...data, type, id});
        });
      },
      async initialize() {
        const interval = setInterval(() => post({type: 'hello'}), 250);
        let timeout;
        try {
          post({type: 'hello'});
          await Promise.race([readiness, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('扩展未连接，请刷新页面重试')), 10000);
          })]);
        } finally { clearInterval(interval); clearTimeout(timeout); }
        values = await adapter.request('settings');
      },
    };
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (message?.channel !== CHANNEL || message.direction !== 'extension') return;
      if (message.type === 'ready') { if (!ready) { ready = true; readyResolve(); } return; }
      if (message.type === 'settings-changed' && message.value && typeof message.value === 'object') {
        values = {...values, ...message.value}; adapter.onSettings?.(); return;
      }
      if (message.type !== 'response') return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.ok) item.resolve(message.value);
      else item.reject(new Error(message.error || '扩展操作失败'));
    });
    return adapter;
  }

  // Also exported for offline regression tests; browser execution has no module.
  if (typeof module === 'object' && module.exports) {
    module.exports = {signatureFromHref, blockSummary, transactionGroups, verifiedBundleMembers, createClient, transactionSlot, readBlockSummary,
      epochSecond, extractTrades, filterDate, createPageBridge};
  }
  if (typeof document === 'undefined') return;
  const extension = createExtensionAdapter();
  const bridge = createPageBridge(window, document);
  function startPage() {
  let endpoint = extension.get('gsi.rpc.revision', 'default');
  let route = '';
  let busy = false;
  let generation = 0;
  let message = '自动查询已开启，等待页面交易…';
  let autoTimer = null, autoWakeAt = 0, cooldownAt = 0;
  let rpcClient = createClient(endpoint, extensionTransport);
  let verifiedEndpoint = '';
  const queue = new Map();
  const results = new Map();
  const blocks = new Map();
  const bundleJobs = new Map();
  let bundleBusy = false, bundleTimer = null, bundleWakeAt = 0, bundleCooldownAt = 0;
  const link = {enabled: true, onlySecond: false, filterApplied: false, seeking: false, seekSerial: 0,
    second: null, serial: 0, loading: false, signatures: new Set(), complete: false, savedFilter: null, note: ''};
  bridge.enabled = true;

  const tokenAddress = () => location.pathname.match(/\/sol\/token\/([^/]+)/)?.[1] || '';
  function componentTrades(element, maxParents = 8) {
    if (!element) return [];
    try {
      const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
      let fiber = key ? element[key] : null;
      const found = new Map();
      for (let i = 0; fiber && i < maxParents; i++, fiber = fiber.return) {
        for (const trade of extractTrades(fiber.memoizedProps)) found.set(trade.signature, trade);
      }
      return [...found.values()];
    } catch { return []; }
  }
  function rowSecond(row, signature) {
    const cached = bridge.records.get(`${tokenAddress()}:${signature}`);
    if (cached) return cached.second;
    for (const key of ['data-timestamp', 'data-time', 'data-block-time']) {
      const value = epochSecond(row.getAttribute(key));
      if (value !== null) return value;
    }
    for (const trade of componentTrades(row, 6)) {
      bridge.records.set(`${tokenAddress()}:${trade.signature}`, trade);
      if (trade.signature === signature) return trade.second;
    }
    return null;
  }
  function collectSecond() {
    if (link.second === null) return {sourceCount: 0};
    const root = document.querySelector('[id$="panel-activity"]') || document;
    const table = root.querySelector('[data-sentry-component="TableNew"]') || root.querySelector('.g-table-wrapper');
    const source = componentTrades(table, 5);
    for (const trade of source) bridge.records.set(`${tokenAddress()}:${trade.signature}`, trade);
    for (const row of root.querySelectorAll(ROW)) {
      const sig = rowSignature(row);
      if (sig && rowSecond(row, sig) === link.second) link.signatures.add(sig);
    }
    for (const [key, trade] of bridge.records) {
      if (key.startsWith(`${tokenAddress()}:`) && trade.second === link.second) link.signatures.add(trade.signature);
    }
    return {sourceCount: source.length};
  }
  function inputValue(input, value) {
    // React tracks direct value assignments. Use the native setter and a bubbling event.
    const view = input.ownerDocument.defaultView;
    Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new view.Event('input', {bubbles: true}));
    input.dispatchEvent(new view.Event('change', {bubbles: true}));
    input.dispatchEvent(new view.Event('blur', {bubbles: true}));
  }
  async function filterDialog(valid) {
    const activity = document.querySelector('[role="tab"][id$="tab-activity"]');
    if (activity && activity.getAttribute('aria-selected') !== 'true') { activity.click(); await pause(150); }
    if (!valid()) return null;
    let dialog = [...document.querySelectorAll('[role="dialog"]')].find(e => e.textContent.includes('按日期过滤') || /filter by date/i.test(e.textContent));
    if (!dialog) {
      const opener = document.querySelector('[data-testid="activity-header-age-date-filter"]');
      if (!opener) throw new Error('活动日期筛选未找到，请切到活动后重试');
      opener.click();
      for (let i = 0; i < 20 && valid(); i++) {
        await pause(50);
        dialog = [...document.querySelectorAll('[role="dialog"]')].find(e => e.textContent.includes('按日期过滤') || /filter by date/i.test(e.textContent));
        if (dialog) break;
      }
    }
    if (!valid()) return null;
    if (!dialog) throw new Error('活动日期筛选没有打开，请重试');
    return dialog;
  }
  async function applySecondFilter(second, valid, restore = null) {
    const dialog = await filterDialog(valid);
    if (!dialog || !valid()) return false;
    const inputs = [...dialog.querySelectorAll('.react-datepicker__input-container input')];
    if (inputs.length !== 2) throw new Error('活动日期输入结构已变化，暂时无法定位 K 线对应的交易');
    if (!restore && !link.savedFilter) link.savedFilter = inputs.map(i => i.value);
    const values = restore || [filterDate(second), filterDate(second + 1)];
    if (restore && !values.some(Boolean)) {
      const reset = [...dialog.querySelectorAll('button')].find(b => /^(重置|Reset)$/i.test(b.textContent.trim()));
      if (!reset) throw new Error('日期筛选重置按钮未找到');
      reset.click();
      return true;
    }
    for (let i = 0; i < 2; i++) {
      inputValue(inputs[i], values[i]);
      await pause(80);
      if (!valid()) return false;
    }
    const apply = [...dialog.querySelectorAll('button')].find(b => /^(应用|Apply)$/i.test(b.textContent.trim()));
    if (!apply) throw new Error('日期筛选应用按钮未找到');
    const appliedAt = Date.now();
    apply.click();
    return appliedAt;
  }
  function selectionNote() {
    return `${filterDate(link.second)} · ${link.complete ? '已加载' : '已找到'} ${link.signatures.size} 笔${link.complete ? '' : '；等待更多交易数据'}`;
  }
  async function seekInContext() {
    if (link.second === null || link.filterApplied || link.loading) return;
    const seekSerial = ++link.seekSerial, serial = link.serial, token = tokenAddress();
    const valid = () => link.enabled && link.second !== null && !link.filterApplied && !link.loading
      && seekSerial === link.seekSerial && serial === link.serial && token === tokenAddress();
    link.seeking = true;
    link.note = `${selectionNote()} · 正在完整列表中定位；滚轮可中止自动定位`;
    refresh();
    let scroller, located = false;
    const cancel = () => {
      if (valid()) { link.seekSerial++; link.seeking = false; link.note = `${selectionNote()} · 已切到自由浏览，查询结果保留`; refresh(); }
    };
    try {
      // The date reset replaces the virtual table asynchronously; avoid anchoring
      // to a stale row from the temporary one-second result.
      await pause(350);
      let previous = '', stable = 0;
      for (let i = 0; i < 100 && valid(); i++) {
        const root = document.querySelector('[id$="panel-activity"]') || document;
        const current = root.querySelector('.g-table-recycler-scroll');
        if (!current) break;
        if (scroller !== current) {
          scroller?.removeEventListener('wheel', cancel);
          scroller?.removeEventListener('pointerdown', cancel);
          scroller = current;
          scroller.addEventListener('wheel', cancel, {passive: true});
          scroller.addEventListener('pointerdown', cancel, {passive: true});
        }
        const rows = [...root.querySelectorAll(ROW)];
        const first = rows.find(row => {
          const sig = rowSignature(row);
          return sig && (link.signatures.has(sig) || rowSecond(row, sig) === link.second);
        });
        if (first) {
          const rowRect = first.getBoundingClientRect(), viewRect = scroller.getBoundingClientRect();
          scroller.scrollTop = Math.max(0, scroller.scrollTop + rowRect.top - viewRect.top - scroller.clientHeight * .3);
          scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
          located = true;
          break;
        }
        const table = root.querySelector('[data-sentry-component="TableNew"]') || root.querySelector('.g-table-wrapper');
        const source = componentTrades(table, 5);
        const index = source.findIndex(trade => link.signatures.has(trade.signature) || trade.second === link.second);
        const rowHeight = rows[0]?.closest('[data-recycler-key]')?.getBoundingClientRect().height
          || rows[0]?.getBoundingClientRect().height || 40;
        if (index >= 0) {
          scroller.scrollTop = Math.max(0, index * rowHeight - scroller.clientHeight * .3);
        } else {
          // Full activity stays unfiltered. Load older pages with GMGN's own
          // pagination until the selected signature enters the virtual data.
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        }
        scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
        const state = `${scroller.scrollHeight}:${rows.map(rowSignature).join(',')}:${bridge.pending}:${bridge.responses.length}`;
        stable = state === previous ? stable + 1 : 0;
        previous = state;
        const visibleTimes = rows.map(row => rowSecond(row, rowSignature(row))).filter(time => time !== null);
        const passed = visibleTimes.length && Math.max(...visibleTimes) < link.second;
        if (!bridge.pending && stable > 12 && (passed || index < 0)) break;
        await pause(200);
      }
    } finally {
      scroller?.removeEventListener('wheel', cancel);
      scroller?.removeEventListener('pointerdown', cancel);
      if (valid()) {
        link.seeking = false;
        link.note = `${selectionNote()} · ${located ? '已定位，可上下滚动查看前后交易' : '已恢复完整列表；目标暂未出现在已加载记录，再次点击该 K 线可重新定位'}`;
        refresh();
      }
    }
  }
  async function restoreContext(valid) {
    if (!link.filterApplied) return true;
    link.note = `${selectionNote()} · 正在恢复完整活动列表…`;
    refresh();
    const restored = await applySecondFilter(0, valid, link.savedFilter || ['', '']);
    if (!restored || !valid()) return false;
    link.filterApplied = false;
    return true;
  }
  async function locateSecond(event, continuation = false) {
    if (!link.enabled || event.token !== tokenAddress()) return;
    const serial = ++link.serial, token = tokenAddress();
    const valid = () => link.enabled && serial === link.serial && token === tokenAddress();
    const originalSecond = link.second;
    if (!continuation && !link.filterApplied) link.savedFilter = null;
    link.seekSerial++; link.seeking = false;
    link.second = event.second;
    link.loading = true; link.complete = false;
    if (!continuation || originalSecond !== event.second) { link.signatures.clear(); }
    link.note = `${filterDate(link.second)} · 正在定位并加载交易…`;
    refresh();
    let appliedAt = Date.now();
    try {
      if (!continuation || !link.filterApplied) {
        const applied = await applySecondFilter(link.second, valid);
        if (!applied) return;
        appliedAt = applied;
        link.filterApplied = true;
      }
      if (!valid()) return;
      // Keep exact [T,T+1) selection even if GMGN includes the endpoint T+1.
      // Wait for its asynchronous table replacement before scanning/recycling rows.
      await pause(650);
      let stable = 0, previous = '', scroller;
      for (let i = 0; i < 45 && valid(); i++) {
        collectSecond();
        const responses = bridge.responses.filter(r => r.token === token && r.startedAt >= appliedAt);
        const latest = responses.at(-1);
        const root = document.querySelector('[id$="panel-activity"]') || document;
        scroller = root.querySelector('.g-table-recycler-scroll');
        const state = `${link.signatures.size}:${scroller?.scrollHeight}:${responses.length}:${bridge.pending}`;
        stable = state === previous ? stable + 1 : 0;
        previous = state;
        const finished = latest && (latest.ended || latest.trades.some(t => t.second < link.second));
        const empty = /暂无数据|No data|No transactions|没有更多|No more/i.test(root.textContent);
        if (!bridge.pending && stable >= 3 && (finished || (empty && Date.now() - appliedAt > 1500))) {
          link.complete = true; break;
        }
        link.note = `${filterDate(link.second)} · 已找到 ${link.signatures.size} 笔，正在补齐…`;
        refresh();
        if (scroller) {
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          scroller.dispatchEvent(new Event('scroll', {bubbles: true}));
        }
        await pause(250);
        if (stable >= 10 && !bridge.pending) break;
      }
      if (!valid()) return;
      collectSecond();
      if (scroller) scroller.scrollTop = 0;
      const first = [...document.querySelectorAll(ROW)].find(r => link.signatures.has(rowSignature(r)));
      first?.scrollIntoView?.({block: 'nearest', behavior: 'smooth'});
      link.note = selectionNote();
      if (!link.signatures.size && !link.complete) link.note += '；等待精确交易时间数据';
      if (!link.onlySecond) await restoreContext(valid);
    } catch (error) { if (valid()) link.note = error.message; }
    finally {
      if (valid()) {
        link.loading = false; refresh();
        if (!link.onlySecond && !link.filterApplied) seekInContext();
      }
    }
  }
  bridge.onCandle = event => { locateSecond(event); };
  bridge.onTrades = response => {
    if (!activeRoute() || link.second === null || response.token !== tokenAddress()) return;
    for (const trade of response.trades) if (trade.second === link.second) link.signatures.add(trade.signature);
    if (!link.loading) refresh();
  };

  function extensionTransport(revision, data) {
    return extension.request('rpc', {revision, data});
  }

  function rowSignature(row) {
    for (const a of row.querySelectorAll(`${TIME} a[href],a[href*="/tx/"]`)) {
      const signature = signatureFromHref(a.getAttribute('href'));
      if (signature) return signature;
    }
    return null;
  }
  function visibleRows() {
    return Array.from(document.querySelectorAll(ROW)).filter(row => {
      const r = row.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) return false;
      const scroller = row.closest('.g-table-recycler-scroll');
      if (!scroller) return true;
      const s = scroller.getBoundingClientRect();
      return r.bottom > s.top && r.top < s.bottom;
    });
  }
  function makeColumn() {
    const cell = document.createElement('div');
    cell.dataset.gsiOwned = 'column';
    cell.className = 'gsi-column';
    const value = document.createElement('span');
    value.className = 'gsi-value';
    cell.append(value);
    return cell;
  }
  function paint(cell, signature) {
    const result = results.get(signature);
    const state = result?.state || 'idle';
    cell.dataset.state = state;
    const text = state === 'done' ? `${result.slot} / ${result.index}`
      : state === 'loading' ? (result.slot != null ? `${result.slot} / …` : '查询中…')
      : state === 'error' ? (result.slot != null ? `${result.slot} / 待重试` : '稍后重试')
      : state === 'queued' ? '排队中…' : '— / —';
    const value = cell.querySelector('.gsi-value');
    if (value.textContent !== text) value.textContent = text;
    value.title = result?.error || (state === 'done' ? `Slot ${result.slot}，Index ${result.index}（从 0 开始）\n${signature}` : signature);
    if (state === 'done' && !result.bundle) {
      const job = bundleJobs.get(result.slot);
      value.title += `\nJito Bundle：${job?.state === 'checked' ? '未查到可确认的归属（不代表没有 bundle）'
        : job?.state === 'error' ? job.error : '正在自动核对归属…'}`;
    }
  }

  function clearGrouping(row) {
    for (const key of ['gsiTxGroup', 'gsiGroupEdge', 'gsiGroupTone', 'gsiGroupKind']) delete row.dataset[key];
    row.querySelector('.gsi-group-label')?.remove();
  }
  function paintGroups() {
    const rows = [...document.querySelectorAll(ROW)];
    const visible = new Set(visibleRows());
    const lists = new Map(), groups = new Map();
    for (const row of rows) {
      if (!visible.has(row)) continue;
      const rect = row.getBoundingClientRect();
      const list = row.closest('.g-table-recycler-scroll') || row.closest('[data-sentry-component="TableNew"]')
        || row.closest('.g-table-wrapper') || row.parentElement;
      if (!lists.has(list)) lists.set(list, []);
      const signature = rowSignature(row), result = results.get(signature);
      lists.get(list).push({row, top: rect.top, result: result ? {...result, signature} : null});
    }
    for (const entries of lists.values()) {
      // Virtualized lists can recycle DOM nodes without keeping DOM order.
      entries.sort((a, b) => a.top - b.top);
      const marks = transactionGroups(entries.map(entry => entry.result));
      entries.forEach((entry, index) => { if (marks[index]) groups.set(entry.row, marks[index]); });
    }
    for (const row of rows) {
      const group = groups.get(row), column = row.querySelector('.gsi-column');
      if (!group || !column) { clearGrouping(row); continue; }
      row.dataset.gsiTxGroup = group.key;
      row.dataset.gsiGroupEdge = group.edge;
      row.dataset.gsiGroupTone = String(group.tone);
      row.dataset.gsiGroupKind = group.kind;
      const title = group.bundle
        ? `当前列表至少两笔不同交易属于同一个 Jito 包，全部成员已与 Slot ${group.bundle.slot} 的区块签名列表核对。\nBundle ID: ${group.bundle.id}\n本包共 ${group.bundle.signatures.length} 笔（可能含独立 tip），当前列表显示 ${group.visibleTransactions} 笔（${group.count} 条活动）。此标记不判断钱包关联或交易意图。点击查看来源。`
        : `当前列表 ${group.count} 条活动属于同一笔链上交易（Slot / Index 相同）。此分组不代表已确认的 bundle。`;
      const value = column.querySelector('.gsi-value');
      value.title += `\n${title}`;
      let label = column.querySelector('.gsi-group-label');
      if (group.edge === 'start' || group.edge === 'single') {
        const tag = group.bundle ? 'A' : 'SPAN';
        if (label && label.tagName !== tag) { label.remove(); label = null; }
        if (!label) {
          label = document.createElement(tag); label.className = 'gsi-group-label'; column.append(label);
          if (group.bundle) for (const name of ['click', 'pointerdown', 'mousedown']) label.addEventListener(name, event => event.stopPropagation());
        }
        if (group.bundle) {
          label.href = `https://explorer.jito.wtf/bundle/${group.bundle.id}`;
          label.target = '_blank'; label.rel = 'noopener noreferrer';
        }
        const text = group.bundle ? `Jito Bundle · ${group.visibleTransactions}/${group.bundle.signatures.length} 笔` : `同笔 · ${group.count} 条`;
        if (label.textContent !== text) label.textContent = text;
        label.title = title;
      } else label?.remove();
    }
  }

  function activeRoute() {
    return /^\/(?:[^/]+\/)?sol\/token\/[^/]+\/?$/.test(location.pathname);
  }
  function refresh() {
    const nextRoute = location.pathname;
    if (nextRoute !== route) {
      route = nextRoute;
      generation++;
      queue.clear(); results.clear(); cooldownAt = 0;
      bundleJobs.clear(); clearTimeout(bundleTimer); bundleTimer = null;
      clearTimeout(autoTimer); autoTimer = null;
      link.serial++; link.loading = false; link.second = null; link.complete = false;
      link.seekSerial++; link.seeking = false; link.filterApplied = false;
      link.savedFilter = null; link.signatures.clear(); link.note = '';
      message = '自动查询已开启，等待页面交易…';
    }
    if (!activeRoute()) {
      for (const row of document.querySelectorAll('[data-gsi-tx-group]')) clearGrouping(row);
      for (const column of document.querySelectorAll('.gsi-column')) column.remove();
      for (const row of document.querySelectorAll('[data-gsi-second-match]')) delete row.dataset.gsiSecondMatch;
      return;
    }
    if (!link.loading && !link.seeking) {
      for (const row of visibleRows()) {
        const sig = rowSignature(row);
        enqueue(sig);
        const result = results.get(sig);
        if (result?.state === 'done' && !bundleJobs.has(result.slot) && blocks.has(result.slot)) queueBundle(result.slot, blocks.get(result.slot));
      }
    }
    if (!link.loading) for (const signature of link.signatures) enqueue(signature);
    const tables = new Set();
    for (const row of document.querySelectorAll(ROW)) {
      const time = row.querySelector(TIME);
      if (!time) continue;
      const table = row.closest('[data-sentry-component="TableNew"]') || row.closest('.g-table-wrapper');
      if (table) tables.add(table);
      const line = time.parentElement;
      line.classList.add('gsi-row');
      let column = Array.from(line.children).find(c => c.dataset.gsiOwned === 'column');
      const sig = rowSignature(row);
      if (!sig) { column?.remove(); continue; }
      if (!column) column = makeColumn();
      if (time.nextElementSibling !== column) time.after(column);
      row.dataset.gsiSecondMatch = String(link.second !== null && (link.signatures.has(sig) || rowSecond(row, sig) === link.second));
      paint(column, sig);
    }
    paintGroups();
    for (const table of tables) {
      const time = table.querySelector(HEAD);
      if (!time) continue;
      time.parentElement.classList.add('gsi-head');
      let column = Array.from(time.parentElement.children).find(c => c.dataset.gsiOwned === 'column');
      if (!column) column = makeColumn();
      if (time.nextElementSibling !== column) time.after(column);
      const value = column.querySelector('.gsi-value');
      value.textContent = 'Slot / Index';
      value.title = `Index 从 0 开始 · 自动依次查询 · 待查 ${queue.size} 笔\n${message}\n${bridge.error || link.note || '点击 1s K 线自动定位并查询该秒交易'}\nRPC 设置请点击 Chrome 工具栏中的插件图标`;
    }
    scheduleQuery();
    scheduleBundleQuery();
  }

  function queueBundle(slot, block) {
    if (!bundleJobs.has(slot)) bundleJobs.set(slot, {slot, block, state: 'queued', attempts: 0, nextAt: 0, members: new Map()});
    return bundleJobs.get(slot);
  }
  function pendingBundleJobs() {
    const needed = new Set();
    for (const sig of [...visibleRows().map(rowSignature), ...link.signatures]) {
      const result = results.get(sig);
      if (result?.state === 'done') needed.add(result.slot);
    }
    return [...bundleJobs.values()].filter(job => job.attempts === 0 || needed.has(job.slot));
  }
  function scheduleBundleQuery() {
    if (bundleBusy || !activeRoute()) return;
    const jobs = pendingBundleJobs();
    if (!jobs.length) return;
    const next = Math.max(Date.now() + 100, bundleCooldownAt, Math.min(...jobs.map(job => job.nextAt)));
    if (bundleTimer !== null && bundleWakeAt <= next) return;
    clearTimeout(bundleTimer); bundleWakeAt = next;
    bundleTimer = setTimeout(() => { bundleTimer = null; queryBundle(); }, Math.max(0, next - Date.now()));
  }
  async function queryBundle() {
    if (bundleBusy || !activeRoute() || location.pathname !== route) return;
    if (Date.now() < bundleCooldownAt) { scheduleBundleQuery(); return; }
    const job = pendingBundleJobs().find(job => job.nextAt <= Date.now());
    if (!job) { scheduleBundleQuery(); return; }
    const batchGeneration = generation;
    const current = () => generation === batchGeneration && location.pathname === route && bundleJobs.get(job.slot) === job;
    bundleBusy = true; job.state = 'loading';
    try {
      const response = await extension.request('bundles', {slot: job.slot});
      if (!current()) return;
      if (response?.slot !== job.slot || !Array.isArray(response.bundles)) throw new Error('Jito 索引响应无效，归属暂未确认');
      job.members = verifiedBundleMembers(response.bundles, job.slot, job.block.indexes);
      job.state = 'checked'; job.error = '';
      job.attempts++;
      // The public index can lag finalized blocks. Recheck visible slots without
      // treating an empty response as proof that a transaction was unbundled.
      job.nextAt = Date.now() + (job.attempts === 1 ? 45000 : job.attempts === 2 ? 120000 : 300000);
      for (const [sig, result] of results) {
        if (result.state !== 'done' || result.slot !== job.slot) continue;
        const bundle = job.members.get(sig);
        if (bundle) result.bundle = bundle;
        else delete result.bundle;
      }
    } catch (error) {
      if (current()) {
        job.state = 'error'; job.error = error.message; job.attempts++;
        job.nextAt = Date.now() + 60000; bundleCooldownAt = job.nextAt;
      }
    } finally {
      bundleBusy = false;
      for (const [slot, old] of bundleJobs) {
        if (bundleJobs.size <= 128) break;
        if (old !== job && ['checked', 'error'].includes(old.state)) bundleJobs.delete(slot);
      }
      refresh();
    }
  }

  function enqueue(signature) {
    if (!signature || results.get(signature)?.state === 'done' || queue.has(signature)) return;
    queue.set(signature, {attempts: 0, retryAt: 0});
    results.set(signature, {state: 'queued'});
  }
  function scheduleQuery() {
    if (busy || link.loading || !activeRoute() || !queue.size) return;
    const next = Math.max(Date.now() + 100, cooldownAt, Math.min(...[...queue.values()].map(item => item.retryAt)));
    if (autoTimer !== null && autoWakeAt <= next) return;
    clearTimeout(autoTimer);
    autoWakeAt = next;
    autoTimer = setTimeout(() => { autoTimer = null; queryNext(); }, Math.max(0, next - Date.now()));
  }
  async function queryNext() {
    if (busy || link.loading || !activeRoute() || location.pathname !== route) return;
    const now = Date.now();
    if (now < cooldownAt) { scheduleQuery(); return; }
    const batch = [...queue].filter(([, item]) => item.retryAt <= now).slice(0, 64);
    if (!batch.length) { scheduleQuery(); return; }
    const batchGeneration = generation, batchEndpoint = endpoint;
    const current = () => batchGeneration === generation && location.pathname === route;
    const rpc = rpcClient;
    const requested = batch.map(([signature]) => signature);
    const failures = [], failedBlocks = new Map();
    function fail(signature, error, slot) {
      const item = queue.get(signature);
      if (!item || !current()) return;
      item.attempts++;
      item.retryAt = Date.now() + Math.min(120000, 15000 * 2 ** Math.min(item.attempts - 1, 3));
      results.set(signature, {state: 'error', slot, error: error.message});
      failures.push(signature);
    }
    busy = true;
    message = `自动查询中：本批 ${requested.length} 笔`;
    for (const sig of requested) results.set(sig, {state: 'loading', generation: batchGeneration});
    refresh();
    try {
      if (verifiedEndpoint !== batchEndpoint) {
        if (await rpc('getGenesisHash') !== MAINNET) throw new Error('该 RPC 不是 Solana 主网，请在 RPC 设置中更换');
        if (!current()) return;
        verifiedEndpoint = batchEndpoint;
      }
      let statuses;
      try { statuses = (await rpc('getSignatureStatuses', [requested, {searchTransactionHistory: true}]))?.value; }
      catch (error) {
        if (!current()) return;
        // Provider-wide failures must not trigger one fallback per transaction.
        if (error.status || /连接|超时|限流|rate.limit|too many/i.test(error.message)) throw error;
      }
      if (!current()) return;
      for (let i = 0; i < requested.length && current(); i++) {
        const sig = requested[i];
        let slot;
        try {
          const status = statuses?.[i];
          slot = status?.confirmationStatus === 'finalized' && Number.isSafeInteger(status.slot)
            ? status.slot : await transactionSlot(rpc, sig);
          if (!current()) break;
          results.set(sig, {state: 'loading', slot, generation: batchGeneration});
          let block = blocks.get(slot);
          if (!block) {
            if (failedBlocks.has(slot)) throw failedBlocks.get(slot);
            try { block = await readBlockSummary(rpc, slot); }
            catch (error) { failedBlocks.set(slot, error); throw error; }
            if (!current()) break;
            blocks.set(slot, block);
            if (blocks.size > 32) blocks.delete(blocks.keys().next().value);
          }
          const index = block.indexes.get(sig);
          if (index === undefined) throw new Error('区块签名列表未找到交易，请更换 RPC');
          const bundle = queueBundle(slot, block).members.get(sig);
          results.set(sig, {state: 'done', slot, index, ...(bundle ? {bundle} : {})});
          queue.delete(sig);
        } catch (error) {
          if (!current()) break;
          fail(sig, error, slot);
          // Stop this batch on a shared connection/rate-limit failure.
          if (error.status || /连接|超时|限流|rate.limit|too many/i.test(error.message)) throw error;
        }
        refresh();
      }
      if (current()) {
        if (failures.length === requested.length) cooldownAt = Math.min(...batch.map(([, item]) => item.retryAt));
        message = failures.length ? `本批 ${failures.length} 笔暂未查到，将自动重试` : '已自动查询完成；新出现的交易会继续查询';
      }
    } catch (error) {
      if (current()) {
        for (const sig of requested) if (results.get(sig)?.state === 'loading') fail(sig, error);
        cooldownAt = Date.now() + 15000;
        message = `${error.message}；稍后自动重试`;
      }
    } finally {
      // Navigation/settings changes replace the queue;
      // a response from the old batch must not overwrite the new queue or cache.
      for (const [sig, item] of batch) {
        if (queue.get(sig) === item && results.get(sig)?.state === 'loading'
            && results.get(sig).generation === batchGeneration) results.set(sig, {state: 'queued'});
      }
      busy = false;
      const visible = new Set(visibleRows().map(rowSignature));
      for (const [sig, result] of results) {
        if (results.size <= 5000) break;
        if (result.state === 'done' && !visible.has(sig) && !link.signatures.has(sig)) results.delete(sig);
      }
      refresh();
    }
  }

  extension.onSettings = () => {
    const next = extension.get('gsi.rpc.revision', 'default');
    if (endpoint === next) return;
    endpoint = next;
    generation++;
    queue.clear(); results.clear(); blocks.clear(); cooldownAt = 0;
    bundleJobs.clear(); clearTimeout(bundleTimer); bundleTimer = null;
    rpcClient = createClient(endpoint, extensionTransport); verifiedEndpoint = '';
    clearTimeout(autoTimer); autoTimer = null;
    message = 'RPC 已更新，正在自动查询…';
    refresh();
  };
  // Ignore our own text/style changes. Observe href changes because GMGN recycles rows.
  let scheduled = false;
  const observer = new MutationObserver(records => {
    if (records.every(r => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest(own))) return;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; refresh(); }, 100);
  });
  let scrollScheduled = false;
  document.addEventListener('scroll', () => {
    if (scrollScheduled) return;
    scrollScheduled = true;
    setTimeout(() => { scrollScheduled = false; refresh(); }, 100);
  }, {capture: true, passive: true});
  observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['href']});
  setInterval(() => { if (link.enabled) bridge.discover(); refresh(); }, 1500);
  refresh();
  bridge.discover();
  }
  const domReady = document.body ? Promise.resolve() : new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
  Promise.all([extension.initialize(), domReady]).then(() => startPage()).catch(error => {
    console.warn('链序 ChainTrace 初始化失败，请刷新页面：', error.message);
  });
})();
