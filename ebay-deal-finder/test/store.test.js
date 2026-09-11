import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/store.js';

const dirs = [];
async function tempStore(options) {
  const dir = await mkdtemp(join(tmpdir(), 'deal-store-'));
  dirs.push(dir);
  return new Store(join(dir, 'nested', 'state.json'), options);
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('persists price history across reloads', async () => {
  const store = await (await tempStore()).load();
  store.recordPrice('gpu:rtx 3080|10gb#used', 420, { itemId: 'a' });
  store.recordPrice('gpu:rtx 3080|10gb#used', 430, { itemId: 'b' });
  await store.save();

  const reopened = await new Store(store.path, {}).load();
  assert.deepEqual(reopened.history('gpu:rtx 3080|10gb#used').sort(), [420, 430]);
});

test('ignores junk prices', async () => {
  const store = await (await tempStore()).load();
  store.recordPrice('k', 0, { itemId: 'a' });
  store.recordPrice('k', -5, { itemId: 'b' });
  store.recordPrice('k', NaN, { itemId: 'c' });
  assert.deepEqual(store.history('k'), []);
});

test('history excludes samples outside the retention window', async () => {
  const store = await (await tempStore({ retentionDays: 30 })).load();
  store.recordPrice('k', 100, { itemId: 'old', at: Date.now() - 45 * 86_400_000 });
  store.recordPrice('k', 200, { itemId: 'new' });
  assert.deepEqual(store.history('k'), [200]);
});

test('one sample per listing: re-seeing a listing updates it, never duplicates it', async () => {
  const store = await (await tempStore()).load();
  for (let i = 0; i < 10; i += 1) store.recordPrice('k', 300, { itemId: 'same-listing' });
  assert.deepEqual(store.history('k'), [300], 'a listing seen in 10 scans is still one comp');

  store.recordPrice('k', 275, { itemId: 'same-listing' });
  assert.deepEqual(store.history('k'), [275], 'a price drop replaces the old figure');

  store.recordPrice('k', 310, { itemId: 'other-listing' });
  assert.deepEqual(store.history('k').sort(), [275, 310]);
});

test('history can exclude the listing being judged', async () => {
  const store = await (await tempStore()).load();
  store.recordPrice('k', 100, { itemId: 'a' });
  store.recordPrice('k', 200, { itemId: 'b' });
  assert.deepEqual(store.history('k', { excludeItemId: 'a' }), [200]);
});

test('samples without an item id are kept as distinct comps', async () => {
  const store = await (await tempStore()).load();
  store.recordPrice('k', 100);
  store.recordPrice('k', 110);
  assert.deepEqual(store.history('k').sort(), [100, 110]);
});

test('prune drops expired prices, caps samples and expires seen items', async () => {
  const store = await (await tempStore({ retentionDays: 30, maxSamplesPerKey: 5, seenRetentionDays: 14 })).load();
  for (let i = 0; i < 20; i += 1) store.recordPrice('k', 100 + i, { itemId: `item${i}` });
  store.recordPrice('old', 50, { itemId: 'x', at: Date.now() - 60 * 86_400_000 });
  store.markNotified('recent');
  store.markNotified('stale', Date.now() - 30 * 86_400_000);

  store.prune();
  assert.equal(store.data.prices.k.length, 5);
  assert.equal(store.data.prices.old, undefined);
  assert.equal(store.hasNotified('recent'), true);
  assert.equal(store.hasNotified('stale'), false);
});

test('starts empty when the state file does not exist', async () => {
  const store = await (await tempStore()).load();
  assert.deepEqual(store.stats(), { keys: 0, samples: 0, seen: 0 });
});
