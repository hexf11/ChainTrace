const test = require('node:test');
const assert = require('node:assert/strict');
const page = require('../page.js');
const background = require('../background.js');
const A = '2'.repeat(88), B = '3'.repeat(88), C = '4'.repeat(88);
const bundleID = 'a'.repeat(64);

test('normalizes a live Jito Explorer slot response and rejects incomplete evidence', () => {
  const fixture = require('./fixtures/jito-slot.json');
  const records = background.normalizeBundles(fixture, 470558016);
  assert.equal(records.length, 4);
  assert.equal(records.find(record => record.id === '389c57c985e97eac2881a62cafd10245fb4ee81d420004b454442b057788ba86').signatures.length, 2);
  assert.deepEqual(Object.keys(records[0]).sort(), ['id', 'signatures', 'slot']);
  assert.deepEqual(background.normalizeBundles([], 1), []);
  const valid = {bundleId: bundleID, slot: 1, txSignatures: [A, B], timestamp: '2026-11-17T13:55:01Z'};
  for (const payload of [{data: []}, [{...valid, slot: 2}], [{...valid, txSignatures: [A, A]}],
    [{...valid, timestamp: null}], [{...valid, txSignatures: []}], [{...valid, txSignatures: ['bad']}],
    [valid, {...valid, txSignatures: [A, C]}]]) assert.throws(() => background.normalizeBundles(payload, 1));
});

test('bundle evidence requires every member in the same finalized block in source order', () => {
  const indexes = new Map([[A, 10], [B, 11], [C, 12]]);
  const record = {id: bundleID, slot: 1, signatures: [A, B]};
  assert.deepEqual([...page.verifiedBundleMembers([record], 1, indexes).keys()], [A, B]);
  for (const records of [[], [{...record, slot: 2}], [{...record, signatures: [B, A]}],
    [{...record, signatures: [A, '5'.repeat(88)]}], [{...record, signatures: [A, A]}],
    [record, {id: 'b'.repeat(64), slot: 1, signatures: [B, C]}]]) {
    assert.equal(page.verifiedBundleMembers(records, 1, indexes).size, 0);
  }
  assert.equal(page.verifiedBundleMembers([{...record, signatures: [A]}], 1, indexes).size, 1);
});

test('confirmed bundle frames span distinct transaction indexes and label partial visibility', () => {
  const bundle = {id: bundleID, slot: 1, signatures: [A, B, C]};
  const entries = [
    {state: 'done', slot: 1, index: 10, signature: A, bundle},
    {state: 'done', slot: 1, index: 11, signature: B, bundle},
    {state: 'done', slot: 1, index: 12, signature: C},
    {state: 'done', slot: 1, index: 10, signature: A, bundle},
  ];
  const groups = page.transactionGroups(entries);
  assert.deepEqual(groups.map(group => group?.edge || null), ['start', 'end', null, 'single']);
  assert.equal(groups[0].kind, 'bundle');
  assert.equal(groups[0].visibleTransactions, 2);
  assert.equal(groups[0].bundle.signatures.length, 3);
  assert.equal(page.transactionGroups(entries.slice(0, 1))[0].kind, 'bundle');
  assert.equal(page.transactionGroups([{...entries[0], signature: '5'.repeat(88)}])[0], null);
});

test('groups require a completed exact Slot/Index match, including index zero', () => {
  const tx = (slot, index, state = 'done') => ({slot, index, state});
  const groups = page.transactionGroups([tx(100, 0), tx(100, 0), tx(100, 1), tx(101, 0), tx(100, 0, 'loading'), null]);
  assert.deepEqual(groups.map(group => group?.edge || null), ['start', 'end', null, null, null, null]);
  assert.equal(groups[0].key, '100:0');
  assert.equal(groups[0].count, 2);
  assert.deepEqual(page.transactionGroups([tx(-1, 0), tx(-1, 0), tx(100, NaN), tx(100, NaN)]), [null, null, null, null]);
});

test('separated groups never enclose unrelated rows and keep a stable color', () => {
  const a = {state: 'done', slot: 100, index: 1}, b = {state: 'done', slot: 100, index: 2};
  const groups = page.transactionGroups([a, a, a, b, a]);
  assert.deepEqual(groups.map(group => group?.edge || null), ['start', 'middle', 'end', null, 'single']);
  assert.equal(groups[0].count, 4);
  assert.equal(groups[0].tone, groups[4].tone);
  assert.equal(page.transactionGroups([a, a])[0].tone, groups[0].tone);
  assert.deepEqual(page.transactionGroups([a, b]), [null, null]);
});

test('Index preserves the complete block signature order, starting at zero', () => {
  assert.deepEqual([...page.blockSummary({signatures: [C, A, B]}).indexes], [[C, 0], [A, 1], [B, 2]]);
  assert.deepEqual(Object.keys(page.blockSummary({signatures: [A]})), ['indexes']);
  for (const block of [null, {transactions: []}, {signatures: [A, A]}, {signatures: ['bad']}]) {
    assert.throws(() => page.blockSummary(block));
  }
});

test('getBlock asks only for signatures and retries the version reported by RPC', async () => {
  const calls = [];
  const result = await page.readBlockSummary(async (method, params) => {
    calls.push({method, params});
    if (calls.length === 1) throw Object.assign(new Error('Please set maxSupportedTransactionVersion: 1'), {code: -32015});
    return {signatures: [A, B]};
  }, 456);
  assert.equal(result.indexes.get(B), 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, 'getBlock');
    assert.equal(call.params[0], 456);
    assert.equal(call.params[1].transactionDetails, 'signatures');
  }
  assert.equal(calls[1].params[1].maxSupportedTransactionVersion, 1);
});

test('RPC transport retries rate limits but does not hide invalid responses', async () => {
  let attempts = 0;
  const client = page.createClient('revision', async () => ++attempts < 3
    ? {status: 429, responseText: ''} : {status: 200, responseText: '{"result":42}'}, async () => {});
  assert.equal(await client('getGenesisHash'), 42);
  assert.equal(attempts, 3);
  await assert.rejects(page.createClient('revision', async () => ({status: 200, responseText: '<html>'}), async () => {})('getGenesisHash'), /JSON/);
});

test('transaction fallback handles unavailable history and explorer validation', async () => {
  await assert.rejects(page.transactionSlot(async () => null, A), /历史交易/);
  assert.equal(await page.transactionSlot(async () => ({slot: 123}), A), 123);
  assert.equal(page.signatureFromHref(`https://solscan.io/tx/${A}`), A);
  assert.equal(page.signatureFromHref(`https://evil.example/tx/${A}`), null);
  assert.equal(page.epochSecond(1700000000123), 1700000000);
  assert.deepEqual(page.extractTrades({data: [{tx_hash: A, timestamp: 1700000000}, {signature: B, time: '3s'}]}), [{signature: A, second: 1700000000}]);
});

test('background rejects writes and reconstructs allowed read-only parameters', () => {
  assert.throws(() => background.validatedRPC({id: 1, method: 'sendTransaction', params: [A]}), /只读/);
  assert.throws(() => background.validatedRPC({id: 1, method: 'getBlock', params: [-1]}), /Slot/);
  assert.throws(() => background.validatedRPC({id: 1, method: 'getSignatureStatuses', params: [['invalid']]}), /签名/);
  const clean = background.validatedRPC({id: 1, method: 'getBlock', params: [123, {transactionDetails: 'full', rewards: true}]});
  assert.equal(clean.params[1].transactionDetails, 'signatures');
  assert.equal(clean.params[1].rewards, false);
});

test('background hides RPC secrets, rejects untrusted senders and stale endpoint revisions', async () => {
  const stored = {'gsi.rpc': 'https://rpc.example/private-secret?api-key=secret', 'gsi.rpc.revision': 'new'};
  global.chrome = {runtime: {id: 'test', getURL: file => `chrome-extension://test/${file}`}, storage: {local: {get: async () => stored}}};
  try {
    const settings = await background.publicSettings();
    assert.equal(settings['gsi.rpc.label'], 'rpc.example');
    assert.equal(JSON.stringify(settings).includes('secret'), false);
    await assert.rejects(background.handle({type: 'settings'}, {id: 'test', frameId: 0, tab: {}, url: 'https://evil.example/'}), /来源/);
    await assert.rejects(background.handle({type: 'preference', key: 'gsi.rpc', value: 'https://evil.example'}, {id: 'test', frameId: 0, tab: {}, url: 'https://gmgn.ai/'}), /不支持/);
    await assert.rejects(background.rpcRequest({id: 1, method: 'getGenesisHash', params: []}, 'old'), /已更新/);
    assert.throws(() => background.endpointURL('https://user:password@rpc.example/'));
    assert.throws(() => background.endpointURL('javascript:alert(1)'));
  } finally { delete global.chrome; }
});
