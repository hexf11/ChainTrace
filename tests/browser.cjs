const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const A = '2'.repeat(88), B = '3'.repeat(88), C = '4'.repeat(88), D = '5'.repeat(88), E = '6'.repeat(88), F = '7'.repeat(88);
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const many = Array.from({length: 210}, (_, i) => '8'.repeat(80) + alphabet[Math.floor(i / 58)] + alphabet[i % 58]);
const allSignatures = [C, A, B, D, ...many];
const token = 'So11111111111111111111111111111111111111112';
const second = 1700000000;
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#0c1016;color:#eee;font:14px system-ui;padding:30px}a{color:#8ac}h1{font-size:20px}.row,.head{display:flex;align-items:center;height:44px;border-bottom:1px solid #334}.row>*:first-child,.head>*:first-child{width:150px}.g-table-wrapper{width:800px}.g-table-recycler-scroll{height:180px;overflow:auto}[role=dialog]{position:fixed;right:30px;top:30px;padding:20px;background:#263344}#chart{height:130px}iframe{height:120px;width:800px;border:0}
</style><script>
window.TradingView = {widget: class {
  constructor() { this.handlers = {}; window.testWidget = this; }
  activeChart(){return this.chart();}
  chart(){ return this.testChart ||= {resolution:()=> '1S', symbol:()=> '${token}', crossHairMoved:()=>({subscribe:(_,fn)=>{window.testCrossHair=fn;}})}; }
  onChartReady(fn){fn();}
  subscribe(name,fn){this.handlers[name]=fn;}
}};
new TradingView.widget({container:'chart'});
</script></head><body><h1>GMGN · Solana 活动列表（测试数据）</h1>
<div id="chart"><iframe id="tradingview_fixture" srcdoc="<canvas width='800' height='120'></canvas>"></iframe></div>
<button data-testid="activity-header-age-date-filter" onclick="document.querySelector('[role=dialog]').hidden=false">按日期过滤</button>
<div id="fixture-panel-activity"><div class="g-table-wrapper" data-sentry-component="TableNew">
<div class="head"><div data-testid="table-sort-timestamp">时间</div><div>交易</div></div>
<div class="g-table-recycler-scroll">${[A,B,C].map((sig,i)=>`<div class="row" data-testid="token-detail-activity-row" data-timestamp="${second+(i===2?1:0)}"><div data-testid="table-cell-timestamp"><a href="https://solscan.io/tx/${sig}">交易 ${i+1}</a></div><div>买入</div></div>`).join('')}</div>
</div></div>
<div role="dialog" hidden><p>按日期过滤</p><div class="react-datepicker__input-container"><input></div><div class="react-datepicker__input-container"><input></div><button onclick="applyFilter()">应用</button><button onclick="applyFilter()">重置</button></div>
<script>function applyFilter(){document.querySelector('[role=dialog]').hidden=true;fetch('/api/v1/token_trades/sol/${token}?limit=50').then(r=>r.json());}</script>
</body></html>`;

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-extension-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: {width: 1280, height: 900},
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const errors = [], calls = [], bundleCalls = [];
  let rpcActive = 0, maxRpcActive = 0, failBlock = false, delayedBlock = null, staleRateLimit = false;
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15000});
    const id = new URL(worker.url()).host;
    await context.route('https://bundles.jito.wtf/**', route => {
      bundleCalls.push(route.request().url());
      return route.fulfill({json: []});
    });
    await context.route('https://api.mainnet-beta.solana.com/**', async route => {
      const data = route.request().postDataJSON();
      calls.push({url: route.request().url(), ...data});
      rpcActive++; maxRpcActive = Math.max(maxRpcActive, rpcActive);
      let result;
      if (data.method === 'getGenesisHash') result = MAINNET;
      else if (data.method === 'getSignatureStatuses') result = {value: data.params[0].map(sig => ({slot: sig === E ? 789 : sig === F ? 999 : 456, confirmationStatus: 'finalized'}))};
      else if (data.method === 'getBlock') {
        if (data.params[0] === 789 && delayedBlock) await delayedBlock;
        if (data.params[0] === 789 && staleRateLimit) {
          await route.fulfill({status: 429, body: 'Too many requests'});
          rpcActive--;
          return;
        }
        if (data.params[0] === 999 && failBlock) {
          failBlock = false;
          await route.fulfill({json: {jsonrpc: '2.0', id: data.id, error: {code: -32004, message: 'Block not available'}}});
          rpcActive--;
          return;
        }
        result = {signatures: data.params[0] === 789 ? [E] : data.params[0] === 999 ? [F] : allSignatures};
      }
      else throw new Error(`Unexpected RPC ${data.method}`);
      await route.fulfill({contentType: 'application/json', body: JSON.stringify({jsonrpc: '2.0', id: data.id, result})});
      rpcActive--;
    });
    await context.route('https://gmgn.ai/**', async route => {
      if (route.request().url().includes('/token_trades/')) {
        await route.fulfill({json: {code: 0, data: {history: [A,B,D].map(signature => ({signature, timestamp: second})), next: null}}});
      } else await route.fulfill({contentType: 'text/html', body: fixture});
    });
    const page = await context.newPage();
    const until = async predicate => {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for RPC request');
        await page.waitForTimeout(100);
      }
    };
    const completed = count => page.waitForFunction(count => document.querySelectorAll('.row .gsi-column[data-state="done"]').length === count, count);
    const setRows = (signatures, compact = false) => page.evaluate(({signatures, compact}) => {
      const scroller = document.querySelector('.g-table-recycler-scroll');
      scroller.innerHTML = signatures.map((sig, i) => `<div class="row" data-testid="token-detail-activity-row" data-timestamp="1700000000" style="${compact ? 'height:2px;min-height:2px;border:0' : ''}"><div data-testid="table-cell-timestamp"><a href="https://solscan.io/tx/${sig}">交易 ${i+1}</a></div><div>买入</div></div>`).join('');
      scroller.style.height = compact ? '500px' : '180px';
      scroller.scrollTop = 0;
    }, {signatures, compact});
    await page.goto(`https://gmgn.ai/sol/token/${token}`);
    const start = page.locator('.head .gsi-start-query');
    await start.waitFor();
    await page.evaluate(() => {
      const scroller = document.querySelector('.g-table-recycler-scroll');
      [...scroller.children].reverse().forEach(row => scroller.append(row));
      scroller.dispatchEvent(new Event('scroll'));
      window.headerClicks = 0;
      document.querySelector('.head').addEventListener('click', () => window.headerClicks++);
    });
    await page.evaluate(second => testCrossHair({time: second}), second);
    await page.frameLocator('#tradingview_fixture').locator('canvas').click({position: {x: 40, y: 40}});
    // Cross a periodic refresh while sorting/scrolling and clicking a candle.
    await page.waitForTimeout(1700);
    assert.equal(calls.length, 0);
    assert.equal(bundleCalls.length, 0);
    assert.equal(await page.locator('[data-gsi-second-match="true"]').count(), 0);
    await fs.mkdir(path.join(root, 'test-results'), {recursive: true});
    await page.locator('.g-table-wrapper').screenshot({path: path.join(root, 'test-results/start-query.png')});
    await start.click();
    await completed(3);
    assert.equal(await start.innerText(), '已开启');
    assert.equal(await start.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.headerClicks), 0);
    assert.deepEqual(calls.find(call => call.method === 'getSignatureStatuses').params[0], [C, B, A]);
    assert.deepEqual(await page.locator('.row .gsi-value').allTextContents(), ['456 / 0', '456 / 2', '456 / 1']);
    await page.evaluate(() => {
      const scroller = document.querySelector('.g-table-recycler-scroll');
      [...scroller.children].reverse().forEach(row => scroller.append(row));
    });
    assert.equal(await page.locator('#gsi-panel, #gsi-launcher, .gsi-column input').count(), 0);
    assert.equal(calls.filter(call => call.method === 'getBlock').length, 1);
    assert.equal(calls.find(call => call.method === 'getBlock').params[1].transactionDetails, 'signatures');
    assert.equal(await page.locator('.gsi-nonvote').count(), 0);
    console.log('PASS idle startup, sorting/scrolling/candle clicks send no requests; header click starts the current order without sorting');

    await page.evaluate(second => testCrossHair({time: second}), second);
    await page.frameLocator('#tradingview_fixture').locator('canvas').click({position: {x: 40, y: 40}});
    await page.waitForFunction(() => document.querySelectorAll('[data-gsi-second-match="true"]').length === 2);
    await page.waitForFunction(() => document.querySelector('.head .gsi-value')?.title.includes('已定位，可上下滚动'));
    await page.waitForFunction(() => document.querySelector('.head .gsi-value')?.title.includes('待查 0 笔'));
    assert(calls.some(call => call.method === 'getSignatureStatuses' && call.params[0].includes(D)));
    assert.equal(calls.filter(call => call.method === 'getBlock').length, 1);
    console.log('PASS candle linking queries automatically after starting');

    // Recycled rows must query the new signature and reuse old successful results.
    await page.locator('.row a').first().evaluate((a, signature) => { a.href = `https://solscan.io/tx/${signature}`; }, D);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.textContent === '456 / 3');
    const beforeRevisit = calls.length;
    await page.locator('.row a').first().evaluate((a, signature) => { a.href = `https://solscan.io/tx/${signature}`; }, A);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.textContent === '456 / 1');
    assert.equal(calls.length, beforeRevisit);
    console.log('PASS virtual row reuse and revisiting cached transactions');

    // Initially hidden rows are not requested until scrolling makes them visible.
    await setRows([A, B, C, D, many[0], many[1]]);
    await page.waitForTimeout(500);
    assert(!calls.some(call => call.method === 'getSignatureStatuses' && call.params[0].includes(many[0])));
    await page.locator('.g-table-recycler-scroll').evaluate(scroller => { scroller.scrollTop = scroller.scrollHeight; });
    await page.waitForFunction(() => [...document.querySelectorAll('.row .gsi-value')].at(-1)?.textContent === '456 / 5');
    console.log('PASS scrolling automatically discovers and queries newly visible rows');

    await setRows(many, true);
    await completed(210);
    assert.equal(calls.filter(call => call.method === 'getBlock').length, 1);
    assert.equal(maxRpcActive, 1);
    assert(calls.filter(call => call.method === 'getSignatureStatuses').every(call => call.params[0].length <= 64));
    const queried = calls.filter(call => call.method === 'getSignatureStatuses').flatMap(call => call.params[0]);
    assert.deepEqual(queried.filter(sig => many.includes(sig)), many);
    console.log('PASS over 200 transactions queried in order, deduplicated, with one request at a time');

    const beforeGrouping = calls.length;
    await setRows([A, A, A, B, B, C, A]);
    await page.locator('.g-table-recycler-scroll').evaluate(scroller => { scroller.style.height = '500px'; });
    await completed(7);
    assert.deepEqual(await page.locator('.row').evaluateAll(rows => rows.map(row => row.dataset.gsiGroupEdge || null)),
      ['start', 'middle', 'end', 'start', 'end', null, 'single']);
    assert.deepEqual(await page.locator('.gsi-group-label').allTextContents(), ['同笔 · 4 条', '同笔 · 2 条', '同笔 · 4 条']);
    assert.equal(calls.length, beforeGrouping);
    const heights = await page.locator('.row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert(heights.every(height => height === heights[0]));
    await fs.mkdir(path.join(root, 'test-results'), {recursive: true});
    await page.screenshot({path: path.join(root, 'test-results/transaction-groups.png')});

    await page.locator('.row a').last().evaluate((a, signature) => { a.href = `https://solscan.io/tx/${signature}`; }, C);
    await page.waitForFunction(() => [...document.querySelectorAll('.row')].at(-1)?.dataset.gsiTxGroup === '456:0');
    assert.deepEqual(await page.locator('.row').evaluateAll(rows => rows.map(row => row.dataset.gsiGroupEdge || null)),
      ['start', 'middle', 'end', 'start', 'end', 'start', 'end']);
    console.log('PASS exact transaction group frames, separated segments, stable row heights, no extra RPC and recycled-row cleanup');

    // The recycler can retain DOM order while moving nodes visually.
    await setRows([A, B, A]);
    await page.locator('.row').evaluateAll(rows => {
      const height = rows[0].getBoundingClientRect().height;
      rows[1].style.transform = `translateY(${height}px)`;
      rows[2].style.transform = `translateY(${-height}px)`;
      document.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(() => document.querySelector('.row')?.dataset.gsiGroupEdge === 'start');
    assert.deepEqual(await page.locator('.row').evaluateAll(rows => rows.map(row => row.dataset.gsiGroupEdge || null)), ['start', null, 'end']);
    await setRows([A, B]);
    await page.locator('.g-table-wrapper').evaluate((table, signature) => {
      const other = document.createElement('div');
      other.className = 'g-table-recycler-scroll'; other.id = 'other-list';
      other.innerHTML = `<div class="row" data-testid="token-detail-activity-row"><div data-testid="table-cell-timestamp"><a href="https://solscan.io/tx/${signature}">另一列表</a></div></div>`;
      table.append(other);
    }, A);
    await completed(3);
    assert.equal(await page.locator('[data-gsi-tx-group]').count(), 0);
    await page.locator('#other-list').evaluate(list => list.remove());
    console.log('PASS grouping follows visual order and stays within each activity list');

    // An old response must not overwrite the next token's results or cache.
    let releaseBlock;
    delayedBlock = new Promise(resolve => { releaseBlock = resolve; });
    await setRows([E]);
    await until(() => calls.some(call => call.method === 'getBlock' && call.params[0] === 789));
    await page.evaluate(() => history.pushState({}, '', '/sol/token/NewToken'));
    await setRows([F]);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.textContent === '— / —');
    assert.equal(await start.isEnabled(), true);
    failBlock = true;
    staleRateLimit = true;
    releaseBlock(); delayedBlock = null;
    await page.waitForTimeout(1700);
    assert.equal(calls.filter(call => call.method === 'getBlock' && call.params[0] === 789).length, 1);
    assert(!calls.some(call => call.method === 'getSignatureStatuses' && call.params[0].includes(F)));
    await start.click();
    await page.waitForFunction(() => document.querySelector('.row .gsi-column')?.dataset.state === 'error');
    const failures = calls.filter(call => call.method === 'getBlock' && call.params[0] === 999).length;
    await page.waitForTimeout(1000);
    assert.equal(calls.filter(call => call.method === 'getBlock' && call.params[0] === 999).length, failures);
    await completed(1); // Automatic retry after the 15-second backoff.
    assert.equal(await page.locator('.row .gsi-value').innerText(), '999 / 0');
    assert.equal(calls.filter(call => call.method === 'getBlock' && call.params[0] === 999).length, 2);
    console.log('PASS new token waits for start, stale 429 retries stop, and active-page failures retry automatically');

    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#test').click();
    await options.waitForFunction(() => document.getElementById('status').textContent.includes('主网连接正常'));
    await options.locator('#rpc').fill('https://api.mainnet-beta.solana.com/test-path?api-key=fixture-secret');
    await options.locator('#save').click();
    await options.waitForFunction(() => document.getElementById('status').textContent.includes('RPC 已保存'));
    await page.waitForFunction(() => document.querySelector('.row .gsi-column')?.dataset.state === 'done');
    await until(() => calls.some(call => call.method === 'getBlock' && call.url.includes('fixture-secret')));
    assert.equal((await page.content()).includes('fixture-secret'), false);
    assert(calls.at(-1).url.endsWith('/test-path?api-key=fixture-secret'));
    console.log('PASS options save, live RPC updates, connection test, RPC key absent from page DOM');

    const rejected = await options.evaluate(() => chrome.runtime.sendMessage({type: 'rpc', revision: 'default', data: {id: 9, method: 'sendTransaction', params: []}}));
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /只读/);
    await page.evaluate(() => history.pushState({}, '', '/'));
    await page.locator('.gsi-column').first().waitFor({state: 'detached'});
    await page.evaluate(token => history.pushState({}, '', `/sol/token/${token}`), token);
    await start.click();
    await completed(1);
    assert.equal(await page.locator('#gsi-panel, #gsi-launcher').count(), 0);
    console.log('PASS rejected transaction writes and SPA route changes');

    await page.reload();
    await start.waitFor();
    const idleCalls = calls.length, idleBundleCalls = bundleCalls.length;
    await options.locator('#reset').click();
    await options.waitForFunction(() => document.getElementById('rpc').value === 'https://api.mainnet-beta.solana.com/'
      && !document.getElementById('reset').disabled);
    await page.waitForTimeout(1700);
    assert.equal(calls.length, idleCalls);
    assert.equal(bundleCalls.length, idleBundleCalls);
    assert.equal(await start.isEnabled(), true);
    console.log('PASS reload resets activation and RPC settings do not start an idle page');

    await fs.mkdir(path.join(root, 'test-results'), {recursive: true});
    await page.screenshot({path: path.join(root, 'test-results/automatic-columns.png')});
    await options.screenshot({path: path.join(root, 'test-results/settings.png'), fullPage: true});
    assert.deepEqual(errors, []);
    console.log('PASS no uncaught page errors');
  } finally {
    await context.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
