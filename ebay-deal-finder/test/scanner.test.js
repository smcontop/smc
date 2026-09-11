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

// A realistic RTX 4080 market: a dozen listings around $730, one at $450.
function marketListings() {
  const prices = [700, 710, 715, 720, 725, 730, 735, 740, 745, 750, 755, 760];
  const comps = prices.map((p, i) => item(`v1|comp${i}|0`, `NVIDIA GeForce RTX 4080 16GB Graphics Card`, p));
  return [...comps, item('v1|deal|0', 'NVIDIA GeForce RTX 4080 16GB Graphics Card', 450)];
}

function stubClient(itemsByQuery, { quantities = {} } = {}) {
  const calls = [];
  const stockCalls = [];
  return {
    calls,
    stockCalls,
    async search({ query, sort }) {
      calls.push({ query, sort });
      return itemsByQuery[query] ?? [];
    },
    async getAvailableQuantity(itemId) {
      stockCalls.push(itemId);
      return quantities[itemId] ?? 1;
    },
  };
}

const testConfig = mergeConfig(DEFAULTS, {
  search: { types: ['gpu'], targets: { gpu: ['rtx 4080'] } },
});

test('surfaces the underpriced listing and ignores the ones at market', async () => {
  const store = await tempStore();
  const client = stubClient({ 'rtx 4080': marketListings() });

  const { deals, stats } = await scan({ client, config: testConfig, store, logger: quietLogger });

  assert.equal(deals.length, 1);
  const [deal] = deals;
  assert.equal(deal.listing.id, 'v1|deal|0');
  assert.equal(deal.identity.key, 'gpu:rtx 4080|16gb');
  assert.equal(deal.score.buyPrice, 450);
  assert.ok(deal.score.market > 720 && deal.score.market < 740, `market ${deal.score.market}`);
  assert.ok(deal.score.profit > 140, `profit ${deal.score.profit}`);
  assert.ok(deal.score.investment >= 300);
  assert.equal(stats.identified, 13);
});

test('deduplicates items returned by both the relevance and newest pulls', async () => {
  const store = await tempStore();
  const client = stubClient({ 'rtx 4080': marketListings() });
  await scan({ client, config: testConfig, store, logger: quietLogger });

  // Two API pulls per query, but each item counted once.
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map((c) => c.sort), [undefined, 'newlyListed']);
  assert.equal(store.history('gpu:rtx 4080|16gb#used').length, 13);
});

test('a listing is never compared against itself', async () => {
  const store = await tempStore();
  // Every listing identical: with self-comparison the median would match the
  // price exactly; the point is that removing itself does not invent a gap.
  const flat = Array.from({ length: 12 }, (_, i) => item(`v1|f${i}|0`, 'RTX 4070 12GB Graphics Card', 500));
  const client = stubClient({ 'rtx 4080': flat });
  const { deals, evaluated } = await scan({ client, config: testConfig, store, logger: quietLogger });

  assert.equal(deals.length, 0);
  assert.ok(evaluated.every((e) => e.score.skipped || e.score.discount === 0));
});

test('does not alert twice on listings from an earlier scan', async () => {
  const store = await tempStore();
  const client = stubClient({ 'rtx 4080': marketListings() });

  const first = await scan({ client, config: testConfig, store, logger: quietLogger });
  assert.equal(first.deals.length, 1);
  store.markNotified(first.deals[0].listing.id);

  const second = await scan({ client, config: testConfig, store, logger: quietLogger });
  const fresh = second.deals.filter((d) => !store.hasNotified(d.listing.id));
  assert.equal(fresh.length, 0);
});

async function scanWithSeller(seller) {
  const listings = marketListings().map((raw) => (raw.itemId === 'v1|deal|0' ? { ...raw, seller } : raw));
  return scan({
    client: stubClient({ 'rtx 4080': listings }), config: testConfig, store: await tempStore(), logger: quietLogger,
  });
}

test('rejects sellers with no feedback, however good the price', async () => {
  const { deals, stats } = await scanWithSeller({ username: 'brandnew', feedbackScore: 0, feedbackPercentage: '0.0' });
  assert.equal(deals.length, 0);
  assert.equal(stats.rejectedSeller, 1);
});

test('rejects sellers below 90% positive', async () => {
  const { deals } = await scanWithSeller({ username: 'shaky', feedbackScore: 800, feedbackPercentage: '88.4' });
  assert.equal(deals.length, 0);
});

test('accepts a seller at or above 90% positive', async () => {
  const { deals } = await scanWithSeller({ username: 'ok', feedbackScore: 800, feedbackPercentage: '90.0' });
  assert.equal(deals.length, 1);
});

test('a low-feedback seller still counts as a comp', async () => {
  const store = await tempStore();
  const listings = marketListings().map((raw) =>
    raw.itemId === 'v1|comp0|0' ? { ...raw, seller: { feedbackScore: 0, feedbackPercentage: '0.0' } } : raw);
  await scan({ client: stubClient({ 'rtx 4080': listings }), config: testConfig, store, logger: quietLogger });
  assert.equal(store.history('gpu:rtx 4080|16gb#used').length, 13, 'their asking price is still market data');
});

test('a scam-grade discount is not treated as a bargain', async () => {
  const store = await tempStore();
  const listings = marketListings().map((raw) =>
    raw.itemId === 'v1|deal|0' ? { ...raw, price: { value: '25.00', currency: 'USD' } } : raw);
  const { deals } = await scan({
    client: stubClient({ 'rtx 4080': listings }), config: testConfig, store, logger: quietLogger,
  });
  assert.equal(deals.length, 0, '94% under market is a scam, not a deal');
});

test('auctions are excluded unless explicitly enabled', async () => {
  const auctionDeal = marketListings().map((raw) =>
    raw.itemId === 'v1|deal|0'
      ? { ...raw, buyingOptions: ['AUCTION'], bidCount: 3, currentBidPrice: { value: '450.00', currency: 'USD' } }
      : raw);

  const store = await tempStore();
  const { deals } = await scan({
    client: stubClient({ 'rtx 4080': auctionDeal }), config: testConfig, store, logger: quietLogger,
  });
  assert.equal(deals.length, 0);

  const store2 = await tempStore();
  const withAuctions = mergeConfig(testConfig, { search: { includeAuctions: true } });
  const { deals: kept } = await scan({
    client: stubClient({ 'rtx 4080': auctionDeal }), config: withAuctions, store: store2, logger: quietLogger,
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
    client: stubClient({ 'rtx 4080': shipped }), config: testConfig, store: await tempStore(), logger: quietLogger,
  });
  const withShipping = evaluated.find((e) => e.listing.id === 'v1|deal|0');
  assert.equal(withShipping.score.buyPrice, 485, '450 item + 35 shipping');

  const { evaluated: free } = await scan({
    client: stubClient({ 'rtx 4080': marketListings() }), config: testConfig, store: await tempStore(), logger: quietLogger,
  });
  const noShipping = free.find((e) => e.listing.id === 'v1|deal|0');
  assert.equal(noShipping.score.buyPrice, 450);
  assert.ok(withShipping.score.profit < noShipping.score.profit - 30, 'shipping eats the margin');
  assert.equal(noShipping.score.isDeal, true);
});

test('broken and accessory listings never reach the comp pool', async () => {
  const store = await tempStore();
  const polluted = [
    ...marketListings(),
    item('v1|junk1|0', 'RTX 4080 16GB FOR PARTS NOT WORKING', 90),
    item('v1|junk2|0', 'Support bracket for RTX 4080 16GB', 15),
    item('v1|junk3|0', 'RTX 4080 16GB GPU chip bare die', 40),
    item('v1|junk4|0', 'Bykski GPU block for RTX 4080 16GB', 60),
  ];
  const { stats } = await scan({
    client: stubClient({ 'rtx 4080': polluted }), config: testConfig, store, logger: quietLogger,
  });

  assert.equal(stats.fetched, 17);
  assert.equal(stats.screened, 13);
  assert.equal(store.history('gpu:rtx 4080|16gb#used').length, 13);
});

test('new and used listings are comped separately', async () => {
  const store = await tempStore();
  const mixed = [
    ...marketListings(),
    ...Array.from({ length: 9 }, (_, i) =>
      item(`v1|new${i}|0`, 'RTX 4080 16GB Graphics Card', 1100 + i * 5, { condition: 'New', conditionId: '1000' })),
  ];
  await scan({ client: stubClient({ 'rtx 4080': mixed }), config: testConfig, store, logger: quietLogger });

  assert.equal(store.history('gpu:rtx 4080|16gb#used').length, 13);
  assert.equal(store.history('gpu:rtx 4080|16gb#new').length, 9);
});

test('a survivable API error on one query does not abort the scan', async () => {
  const store = await tempStore();
  const config = mergeConfig(DEFAULTS, {
    search: { types: ['gpu'], targets: { gpu: ['boom', 'rtx 4080'] } },
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

// --- the $300 minimum spend rule ---

// A $60 DDR5 kit market: comps around $150, one listing at $60.
function cheapRamListings() {
  const prices = [140, 145, 148, 150, 152, 155, 158, 160, 162, 165, 168, 170];
  const comps = prices.map((p, i) => item(`v1|ram${i}|0`, 'Corsair 32GB (2x16GB) DDR5 6000MHz Desktop Memory', p));
  return [...comps, item('v1|ramdeal|0', 'Corsair 32GB (2x16GB) DDR5 6000MHz Desktop Memory', 60)];
}

const ramConfig = mergeConfig(DEFAULTS, {
  search: { types: ['ram'], targets: { ram: ['ddr5 32gb'] } },
});

test('a cheap single-stock item is not alerted, however underpriced', async () => {
  const client = stubClient({ 'ddr5 32gb': cheapRamListings() }, { quantities: { 'v1|ramdeal|0': 1 } });
  const { deals, evaluated } = await scan({
    client, config: ramConfig, store: await tempStore(), logger: quietLogger,
  });

  const scored = evaluated.find((e) => e.listing.id === 'v1|ramdeal|0');
  assert.ok(scored.score.discount > 0.5, 'it really is cheap');
  assert.equal(scored.score.investment, 60);
  assert.equal(deals.length, 0, '$60 is under the $300 floor');
});

test('the same item qualifies when the seller has five in stock', async () => {
  const client = stubClient({ 'ddr5 32gb': cheapRamListings() }, { quantities: { 'v1|ramdeal|0': 5 } });
  const { deals } = await scan({ client, config: ramConfig, store: await tempStore(), logger: quietLogger });

  assert.equal(deals.length, 1);
  assert.equal(deals[0].score.investment, 300);
  assert.equal(deals[0].score.totalUnits, 5);
  assert.ok(deals[0].score.profit > 4 * deals[0].score.unitProfit);
});

test('stock is only looked up for listings the floor is the last thing blocking', async () => {
  // Every listing is at market: none is close enough to be worth an extra call.
  const atMarket = cheapRamListings().filter((raw) => raw.itemId !== 'v1|ramdeal|0');
  const client = stubClient({ 'ddr5 32gb': atMarket });
  await scan({ client, config: ramConfig, store: await tempStore(), logger: quietLogger });
  assert.deepEqual(client.stockCalls, [], 'no wasted API calls on listings that fail on price anyway');

  // The one genuinely cheap listing gets exactly one lookup.
  const client2 = stubClient({ 'ddr5 32gb': cheapRamListings() });
  await scan({ client: client2, config: ramConfig, store: await tempStore(), logger: quietLogger });
  assert.deepEqual(client2.stockCalls, ['v1|ramdeal|0']);
});

test('an item already over $300 needs no stock lookup', async () => {
  const client = stubClient({ 'rtx 4080': marketListings() });
  const { deals } = await scan({ client, config: testConfig, store: await tempStore(), logger: quietLogger });
  assert.equal(deals.length, 1);
  assert.deepEqual(client.stockCalls, [], 'the $450 listing clears the floor on its own');
});

test('a failed stock lookup does not lose the scan', async () => {
  const client = {
    async search({ query }) {
      return query === 'ddr5 32gb' ? cheapRamListings() : [];
    },
    async getAvailableQuantity() {
      throw new Error('item lookup 500');
    },
  };
  const { deals, stats } = await scan({ client, config: ramConfig, store: await tempStore(), logger: quietLogger });
  assert.equal(stats.errors, 1);
  assert.equal(deals.length, 0, 'without a stock count it stays under the floor');
});

test('laptop memory never reaches the deal list', async () => {
  const laptop = cheapRamListings().map((raw) => ({
    ...raw,
    title: raw.title.replace('Desktop Memory', 'SODIMM Laptop Memory'),
  }));
  const client = stubClient({ 'ddr5 32gb': laptop }, { quantities: { 'v1|ramdeal|0': 10 } });
  const { deals, stats } = await scan({ client, config: ramConfig, store: await tempStore(), logger: quietLogger });

  assert.equal(deals.length, 0);
  assert.equal(stats.screened, 0, 'laptop RAM is screened out before it becomes a comp');
});
