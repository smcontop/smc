import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { mergeConfig, DEFAULTS } from '../src/config.js';
import { scan } from '../src/scanner.js';
import { Store } from '../src/store.js';

const dirs = [];
async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'deal-scan-'));
  dirs.push(dir);
  return new Store(join(dir, 'state.json'), DEFAULTS.store).load();
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const quietLogger = { log() {}, error() {} };

function item(id, title, price, extra = {}) {
  return {
    itemId: id,
    title,
    price: { value: String(price), currency: 'USD' },
    itemWebUrl: `https://ebay.com/itm/${id}`,
    condition: 'Used',
    conditionId: '3000',
    buyingOptions: ['FIXED_PRICE'],
    shippingOptions: [{ shippingCost: { value: '0.00', currency: 'USD' } }],
    seller: { username: 'seller1', feedbackScore: 500, feedbackPercentage: '99.5' },
    ...extra,
  };
}

// A realistic RTX 3080 market: a dozen listings around $430, one at $250.
function marketListings() {
  const prices = [400, 410, 415, 420, 425, 430, 435, 440, 445, 450, 455, 460];
  const comps = prices.map((p, i) => item(`v1|comp${i}|0`, `NVIDIA GeForce RTX 3080 10GB Graphics Card`, p));
  return [...comps, item('v1|deal|0', 'NVIDIA GeForce RTX 3080 10GB Graphics Card', 250)];
}

function stubClient(itemsByQuery) {
  const calls = [];
  return {
    calls,
    async search({ query, sort }) {
      calls.push({ query, sort });
      return itemsByQuery[query] ?? [];
    },
  };
}

const testConfig = mergeConfig(DEFAULTS, {
  search: { types: ['gpu'], targets: { gpu: ['rtx 3080'] } },
});

test('surfaces the underpriced listing and ignores the ones at market', async () => {
  const store = await tempStore();
  const client = stubClient({ 'rtx 3080': marketListings() });

  const { deals, stats } = await scan({ client, config: testConfig, store, logger: quietLogger });

  assert.equal(deals.length, 1);
  const [deal] = deals;
  assert.equal(deal.listing.id, 'v1|deal|0');
  assert.equal(deal.identity.key, 'gpu:rtx 3080|10gb');
  assert.equal(deal.score.buyPrice, 250);
  assert.ok(deal.score.market > 420 && deal.score.market < 440, `market ${deal.score.market}`);
  assert.ok(deal.score.profit > 80, `profit ${deal.score.profit}`);
  assert.equal(stats.identified, 13);
});

test('deduplicates items returned by both the relevance and newest pulls', async () => {
  const store = await tempStore();
  const client = stubClient({ 'rtx 3080': marketListings() });
  await scan({ client, config: testConfig, store, logger: quietLogger });

  // Two API pulls per query, but each item counted once.
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map((c) => c.sort), [undefined, 'newlyListed']);
  assert.equal(store.history('gpu:rtx 3080|10gb#used').length, 13);
});

test('a listing is never compared against itself', async () => {
  const store = await tempStore();
  // Every listing identical: with self-comparison the median would match the
  // price exactly; the point is that removing itself does not invent a gap.
  const flat = Array.from({ length: 12 }, (_, i) => item(`v1|f${i}|0`, 'RTX 3070 8GB Graphics Card', 300));
  const client = stubClient({ 'rtx 3080': flat });
  const { deals, evaluated } = await scan({ client, config: testConfig, store, logger: quietLogger });

  assert.equal(deals.length, 0);
  assert.ok(evaluated.every((e) => e.score.skipped || e.score.discount === 0));
});

test('does not alert twice on listings from an earlier scan', async () => {
  const store = await tempStore();
  const client = stubClient({ 'rtx 3080': marketListings() });

  const first = await scan({ client, config: testConfig, store, logger: quietLogger });
  assert.equal(first.deals.length, 1);
  store.markNotified(first.deals[0].listing.id);

  const second = await scan({ client, config: testConfig, store, logger: quietLogger });
  const fresh = second.deals.filter((d) => !store.hasNotified(d.listing.id));
  assert.equal(fresh.length, 0);
});

test('skips risky sellers on a deal but keeps a solid one', async () => {
  const store = await tempStore();
  const risky = marketListings().map((raw) =>
    raw.itemId === 'v1|deal|0'
      ? { ...raw, seller: { username: 'brandnew', feedbackScore: 0, feedbackPercentage: '0.0' } }
      : raw);
  const client = stubClient({ 'rtx 3080': risky });

  const { deals } = await scan({ client, config: testConfig, store, logger: quietLogger });
  assert.equal(deals.length, 0, 'zero-feedback seller on a big discount should be skipped');

  const permissive = mergeConfig(testConfig, { risk: { skipRisky: false } });
  const store2 = await tempStore();
  const { deals: kept } = await scan({
    client: stubClient({ 'rtx 3080': risky }), config: permissive, store: store2, logger: quietLogger,
  });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].risks.length > 0, 'the risk should still be reported');
});

test('a scam-grade discount is not treated as a bargain', async () => {
  const store = await tempStore();
  const listings = marketListings().map((raw) =>
    raw.itemId === 'v1|deal|0' ? { ...raw, price: { value: '25.00', currency: 'USD' } } : raw);
  const { deals } = await scan({
    client: stubClient({ 'rtx 3080': listings }), config: testConfig, store, logger: quietLogger,
  });
  assert.equal(deals.length, 0, '94% under market is a scam, not a deal');
});

test('auctions are excluded unless explicitly enabled', async () => {
  const auctionDeal = marketListings().map((raw) =>
    raw.itemId === 'v1|deal|0'
      ? { ...raw, buyingOptions: ['AUCTION'], bidCount: 3, currentBidPrice: { value: '250.00', currency: 'USD' } }
      : raw);

  const store = await tempStore();
  const { deals } = await scan({
    client: stubClient({ 'rtx 3080': auctionDeal }), config: testConfig, store, logger: quietLogger,
  });
  assert.equal(deals.length, 0);

  const store2 = await tempStore();
  const withAuctions = mergeConfig(testConfig, { search: { includeAuctions: true } });
  const { deals: kept } = await scan({
    client: stubClient({ 'rtx 3080': auctionDeal }), config: withAuctions, store: store2, logger: quietLogger,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].listing.isAuction, true);
  assert.match(kept[0].risks.join(' '), /auction/);
});

test('shipping cost is part of what you pay', async () => {
  const shipped = marketListings().map((raw) =>
    raw.itemId === 'v1|deal|0'
      ? { ...raw, shippingOptions: [{ shippingCost: { value: '35.00', currency: 'USD' } }] }
      : raw);
  const { evaluated } = await scan({
    client: stubClient({ 'rtx 3080': shipped }), config: testConfig, store: await tempStore(), logger: quietLogger,
  });
  const withShipping = evaluated.find((e) => e.listing.id === 'v1|deal|0');
  assert.equal(withShipping.score.buyPrice, 285, '250 item + 35 shipping');

  const { evaluated: free } = await scan({
    client: stubClient({ 'rtx 3080': marketListings() }), config: testConfig, store: await tempStore(), logger: quietLogger,
  });
  const noShipping = free.find((e) => e.listing.id === 'v1|deal|0');
  assert.equal(noShipping.score.buyPrice, 250);
  assert.ok(withShipping.score.profit < noShipping.score.profit - 30, 'shipping eats the margin');
  // $35 shipping drops this one under the 25% ROI floor, so it is not alerted.
  assert.equal(withShipping.score.isDeal, false);
  assert.equal(noShipping.score.isDeal, true);
});

test('broken and accessory listings never reach the comp pool', async () => {
  const store = await tempStore();
  const polluted = [
    ...marketListings(),
    item('v1|junk1|0', 'RTX 3080 10GB FOR PARTS NOT WORKING', 90),
    item('v1|junk2|0', 'Support bracket for RTX 3080 10GB', 15),
  ];
  const { stats } = await scan({
    client: stubClient({ 'rtx 3080': polluted }), config: testConfig, store, logger: quietLogger,
  });

  assert.equal(stats.fetched, 15);
  assert.equal(stats.screened, 13);
  assert.equal(store.history('gpu:rtx 3080|10gb#used').length, 13);
});

test('new and used listings are comped separately', async () => {
  const store = await tempStore();
  const mixed = [
    ...marketListings(),
    ...Array.from({ length: 9 }, (_, i) =>
      item(`v1|new${i}|0`, 'RTX 3080 10GB Graphics Card', 700 + i * 5, { condition: 'New', conditionId: '1000' })),
  ];
  await scan({ client: stubClient({ 'rtx 3080': mixed }), config: testConfig, store, logger: quietLogger });

  assert.equal(store.history('gpu:rtx 3080|10gb#used').length, 13);
  assert.equal(store.history('gpu:rtx 3080|10gb#new').length, 9);
});

test('a survivable API error on one query does not abort the scan', async () => {
  const store = await tempStore();
  const config = mergeConfig(DEFAULTS, {
    search: { types: ['gpu'], targets: { gpu: ['boom', 'rtx 3080'] } },
  });
  const client = {
    async search({ query }) {
      if (query === 'boom') throw new Error('429 rate limited');
      return marketListings();
    },
  };

  const { deals, stats } = await scan({ client, config, store, logger: quietLogger });
  assert.equal(stats.errors, 1);
  assert.equal(deals.length, 1);
});

test('aborts the whole scan on an auth failure instead of repeating it', async () => {
  const store = await tempStore();
  const config = mergeConfig(DEFAULTS, {
    search: { types: ['gpu'], targets: { gpu: ['a', 'b', 'c'] } },
  });
  let calls = 0;
  const client = {
    async search() {
      calls += 1;
      const err = new Error('eBay OAuth failed (401)');
      err.status = 401;
      throw err;
    },
  };

  await assert.rejects(
    () => scan({ client, config, store, logger: quietLogger }),
    /rejected the credentials/,
  );
  assert.ok(calls <= 2, `should stop after the first query, made ${calls} calls`);
});

test('aborts on rate limiting', async () => {
  const store = await tempStore();
  const client = {
    async search() {
      const err = new Error('too many requests');
      err.status = 429;
      throw err;
    },
  };
  await assert.rejects(() => scan({ client, config: testConfig, store, logger: quietLogger }), /rate limit/);
});
