const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const letters = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const signatures = Array.from({length: 20}, (_, i) => 'Z'.repeat(80) + letters[i] + letters[i]);
const [A, B, C, D, E, F, G, H, I, J, K, L, M, N] = signatures;
const blocks = new Map([[900, [A, B, C, D]], [901, [E, F]], [902, [G, H]], [903, [I, J]], [904, [K, L]], [905, [M, N]]]);
const slots = new Map([...blocks].flatMap(([slot, txs]) => txs.map(sig => [sig, slot])));
const record = (slot, id, txs) => ({bundleId: id.repeat(64), slot, timestamp: '2026-11-17T13:55:01Z', txSignatures: txs});
const data = new Map([[900, [record(900, 'a', [A, B, C]), record(900, 'f', [D])]], [901, [record(901, 'b', [E, signatures[19]])]],
  [902, []], [903, [record(904, 'c', [I, J])]], [904, [record(904, 'd', [K, L])]], [905, [record(905, 'e', [M, N])]]]);
const rowHTML = (sig, index) => `<div class="row" data-testid="token-detail-activity-row"><div data-testid="table-cell-timestamp"><a href="https://solscan.io/tx/${sig}">活动 ${index + 1}</a></div><div>买入</div></div>`;
const fixture = txs => `<!doctype html><meta charset="utf-8"><style>body{background:#0c1016;color:#eee;padding:30px;font:14px system-ui}h1{font-size:20px}.g-table-wrapper{width:800px}.row,.head{display:flex;align-items:center;height:48px;border-bottom:1px solid #334}.row>:first-child,.head>:first-child{width:150px}a{color:#8ac}.g-table-recycler-scroll{height:350px;overflow:auto}</style><h1>Jito Bundle 自动识别（测试数据）</h1><div class="g-table-wrapper" data-sentry-component="TableNew"><div class="head"><div data-testid="table-sort-timestamp">时间</div><div>交易</div></div><div class="g-table-recycler-scroll">${txs.map(rowHTML).join('')}</div></div>`;

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-bundle-test-'));
  const context = await chromium.launchPersistentContext(profile, {channel: 'chromium', headless: true,
    viewport: {width: 1100, height: 650}, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]});
  const lookups = [], errors = [];
  let delay = null, outage = false;
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://api.mainnet-beta.solana.com/**', async route => {
      const request = route.request().postDataJSON();
      const result = request.method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        : request.method === 'getSignatureStatuses' ? {value: request.params[0].map(sig => ({slot: slots.get(sig), confirmationStatus: 'finalized'}))}
        : {signatures: blocks.get(request.params[0])};
      await route.fulfill({json: {jsonrpc: '2.0', id: request.id, result}});
    });
    await context.route('https://bundles.jito.wtf/**', async route => {
      const url = new URL(route.request().url());
      assert.match(url.pathname, /^\/api\/v1\/bundles\/slot\/\d+$/);
      assert.equal(url.search, '');
      const slot = Number(url.pathname.split('/').at(-1));
      lookups.push(slot);
      if (slot === 904 && delay) await delay;
      if (outage) await route.fulfill({status: 503, body: 'Unavailable'});
      else await route.fulfill({json: data.get(slot) || []});
    });
    let rows = [A, A, B, D];
    await context.route('https://gmgn.ai/**', route => route.fulfill({contentType: 'text/html', body: fixture(rows)}));
    const page = await context.newPage();
    const done = count => page.waitForFunction(count => document.querySelectorAll('.row .gsi-column[data-state="done"]').length === count, count);
    const open = async txs => {
      rows = txs; await page.goto(`https://gmgn.ai/sol/token/${txs[0]}`);
      await page.locator('.gsi-start-query').click(); await done(txs.length);
    };
    const setRows = async (txs, start = false) => {
      await page.locator('.g-table-recycler-scroll').evaluate((el, html) => { el.innerHTML = html; }, txs.map(rowHTML).join(''));
      if (start) await page.locator('.gsi-start-query').click();
      await done(txs.length);
    };

    await open(rows);
    await page.waitForFunction(() => document.querySelectorAll('[data-gsi-group-kind="bundle"]').length === 3);
    assert.equal(await page.locator('.gsi-group-label').innerText(), 'Jito Bundle · 2/3 笔');
    assert.equal(await page.locator('.gsi-group-label').getAttribute('href'), `https://explorer.jito.wtf/bundle/${'a'.repeat(64)}`);
    assert.equal(await page.locator('.row').last().getAttribute('data-gsi-group-kind'), null);
    assert.deepEqual(await page.locator('.row').evaluateAll(rows => rows.map(row => row.dataset.gsiGroupEdge || null)), ['start', 'middle', 'end', null]);
    assert.equal(lookups.filter(slot => slot === 900).length, 1);
    await fs.mkdir(path.join(root, 'test-results'), {recursive: true});
    await page.screenshot({path: path.join(root, 'test-results/jito-bundles.png')});
    console.log('PASS confirmed bundle across distinct indexes, partial member count, official source link, one lookup per slot');

    await setRows([B, D, A]);
    assert.deepEqual(await page.locator('.row').evaluateAll(rows => rows.map(row => row.dataset.gsiGroupEdge || null)), ['single', null, 'single']);
    await setRows([C]);
    await page.locator('.gsi-group-label').waitFor({state: 'detached'});
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    await setRows([C, A]);
    await page.waitForFunction(() => document.querySelector('.gsi-group-label')?.textContent === 'Jito Bundle · 2/3 笔');
    assert.equal(lookups.filter(slot => slot === 900).length, 1);
    await open([A, B]);
    await page.waitForFunction(() => document.querySelectorAll('[data-gsi-group-kind="bundle"]').length === 2);
    assert.equal(lookups.filter(slot => slot === 900).length, 1);
    await page.locator('.g-table-recycler-scroll').evaluate(scroller => {
      scroller.style.height = '48px'; scroller.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-gsi-group-kind="bundle"]').length === 0);
    await page.locator('.g-table-recycler-scroll').evaluate(scroller => {
      scroller.style.height = '350px'; scroller.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-gsi-group-kind="bundle"]').length === 2);
    console.log('PASS frames clear with only one visible member and return with two distinct members');

    // Two independent single-transaction Jito records are never a multi-trade bundle.
    const [O, P, Q, R] = signatures.slice(14, 18);
    blocks.set(907, [O, P]); slots.set(O, 907); slots.set(P, 907);
    data.set(907, [record(907, '1', [O]), record(907, '2', [P])]);
    await open([O, O, P]);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.title.includes('未查到可确认'));
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    assert.equal(await page.locator('.gsi-group-label').innerText(), '同笔 · 2 条');

    // A swap plus a separate tip has two signatures, but only one activity trade.
    blocks.set(908, [Q, R]); slots.set(Q, 908); slots.set(R, 908);
    data.set(908, [record(908, '3', [Q, R])]);
    await open([Q, Q]);
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    const evidence = await settings.evaluate(() => chrome.runtime.sendMessage({type: 'bundles', slot: 908}));
    assert.equal(evidence.ok, true);
    await page.waitForFunction(() => {
      const title = document.querySelector('.row .gsi-value')?.title || '';
      return title.includes('Slot 908') && !title.includes('Jito Bundle：');
    });
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    assert.equal(await page.locator('.gsi-group-label').innerText(), '同笔 · 2 条');
    await setRows([Q]);
    await page.locator('.gsi-group-label').waitFor({state: 'detached'});
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    console.log('PASS single Jito records, duplicate activity rows and trade-plus-tip do not produce bundle frames');

    await open([E, F]);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.title.includes('未查到可确认'));
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    await open([G, H]);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.title.includes('未查到可确认'));
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    await open([I, J]);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.title.includes('索引记录不完整'));
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    console.log('PASS incomplete on-chain membership, empty index and wrong-slot response never produce bundle frames');

    let release;
    delay = new Promise(resolve => { release = resolve; });
    await open([K, L]);
    const deadline = Date.now() + 10000;
    while (!lookups.includes(904)) { if (Date.now() > deadline) throw new Error('Missing delayed lookup'); await page.waitForTimeout(100); }
    await page.evaluate(() => history.pushState({}, '', '/sol/token/next-token'));
    await setRows([M, N], true);
    release(); delay = null;
    await page.waitForFunction(() => document.querySelectorAll('[data-gsi-group-kind="bundle"]').length === 2);
    assert.equal(await page.locator('.gsi-group-label').getAttribute('href'), `https://explorer.jito.wtf/bundle/${'e'.repeat(64)}`);
    assert.equal((await page.content()).includes(`bundle/${'d'.repeat(64)}`), false);
    console.log('PASS delayed evidence cannot label a different token after navigation');

    // A source outage is independent of ordinary Slot / Index RPC reads.
    outage = true;
    const newSig = signatures[18]; slots.set(newSig, 906); blocks.set(906, [newSig]);
    await open([newSig]);
    await page.waitForFunction(() => document.querySelector('.row .gsi-value')?.title.includes('HTTP 503'));
    assert.equal(await page.locator('.row .gsi-value').innerText(), '906 / 0');
    assert.equal(await page.locator('[data-gsi-group-kind="bundle"]').count(), 0);
    assert.equal(await page.locator('#gsi-panel, #gsi-launcher, .gsi-column input').count(), 0);
    const invalid = await settings.evaluate(() => chrome.runtime.sendMessage({type: 'bundles', slot: 'https://evil.example/'}));
    assert.equal(invalid.ok, false); assert.match(invalid.error, /Slot/);
    assert.deepEqual(errors, []);
    console.log('PASS index outages preserve RPC results, no floating UI, strict fixed-origin lookup validation');
  } finally { await context.close(); await fs.rm(profile, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
