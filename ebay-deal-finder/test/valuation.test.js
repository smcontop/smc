import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conditionBucket, effectivePrice, evaluate, median, percentile, resaleCosts, trimOutliers,
} from '../src/valuation.js';

const config = {
  minSamples: 8,
  resalePercentile: 45,
  feePercent: 13.25,
  fixedFee: 0.4,
  supplies: 1.5,
  defaultShippingCost: 12,
  shippingCostByType: { gpu: 18, cpu: 6, ram: 6 },
  minDiscount: 0.25,
  minProfit: 40,
  minRoi: 0.25,
};

const gpuIdentity = { type: 'gpu', model: 'rtx 3080|10gb', key: 'gpu:rtx 3080|10gb', lotSize: 1 };
const comps = [400, 410, 415, 420, 425, 430, 435, 440, 450, 460];

function listing(overrides = {}) {
  return {
    id: 'v1|1|0', title: 'RTX 3080 10GB', price: 250, shipping: 0, currency: 'USD',
    condition: 'Used', conditionId: '3000', isAuction: false, seller: {}, ...overrides,
  };
}

test('median and percentile interpolate correctly', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30);
  assert.equal(percentile([], 50), null);
});

test('outlier trimming drops scam lowballs and fantasy prices', () => {
  const trimmed = trimOutliers([...comps, 5, 9000]);
  assert.ok(!trimmed.includes(5), 'should drop the $5 lowball');
  assert.ok(!trimmed.includes(9000), 'should drop the $9000 listing');
  assert.equal(trimmed.length, comps.length);
});

test('effective price includes shipping and divides lots per unit', () => {
  assert.equal(effectivePrice({ price: 100, shipping: 12 }), 112);
  assert.equal(effectivePrice({ price: 200, shipping: 0 }, { lotSize: 4 }), 50);
  // Unknown shipping falls back to the configured assumption.
  assert.equal(effectivePrice({ price: 100, shipping: null }, { assumedShipping: 10 }), 110);
});

test('resale costs apply the eBay fee, fixed fee, shipping and supplies', () => {
  const costs = resaleCosts(400, { feePercent: 13.25, fixedFee: 0.4, shippingCost: 18, supplies: 1.5 });
  assert.equal(costs.fees.toFixed(2), '53.40');
  assert.equal(costs.total.toFixed(2), '72.90');
});

test('condition buckets follow eBay condition ids', () => {
  assert.equal(conditionBucket({ conditionId: '1000' }), 'new');
  assert.equal(conditionBucket({ conditionId: '1500' }), 'new');
  assert.equal(conditionBucket({ conditionId: '2500' }), 'refurb');
  assert.equal(conditionBucket({ conditionId: '3000' }), 'used');
  assert.equal(conditionBucket({ conditionId: '7000' }), 'parts');
  assert.equal(conditionBucket({ condition: 'Seller refurbished' }), 'refurb');
});

test('flags a genuinely underpriced listing as a deal', () => {
  const score = evaluate({ listing: listing({ price: 250 }), identity: gpuIdentity, comps, config });
  assert.equal(score.isDeal, true);
  assert.equal(score.market, 427.5);
  assert.equal(score.buyPrice, 250);
  // resale p45 = 425.5, costs = 56.38 + 18 + 1.5, profit = 425.5 - 76.26 - 250
  assert.ok(score.profit > 90 && score.profit < 110, `unexpected profit ${score.profit}`);
  assert.ok(score.roi > 0.35);
});

test('does not flag a listing priced at market', () => {
  const score = evaluate({ listing: listing({ price: 425 }), identity: gpuIdentity, comps, config });
  assert.equal(score.isDeal, false);
  assert.ok(score.profit < 0, 'buying at market and reselling loses money on fees');
});

test('a discount that does not cover fees is not a deal', () => {
  // 20% under market looks cheap but fees and shipping eat the margin.
  const score = evaluate({ listing: listing({ price: 342 }), identity: gpuIdentity, comps, config });
  assert.equal(score.isDeal, false);
});

test('shipping cost is counted in the buy price', () => {
  const cheap = evaluate({ listing: listing({ price: 250, shipping: 0 }), identity: gpuIdentity, comps, config });
  const shipped = evaluate({ listing: listing({ price: 250, shipping: 40 }), identity: gpuIdentity, comps, config });
  assert.equal(shipped.buyPrice - cheap.buyPrice, 40);
  assert.ok(shipped.profit < cheap.profit);
});

test('refuses to judge a listing without enough comps', () => {
  const score = evaluate({ listing: listing(), identity: gpuIdentity, comps: [400, 410, 420], config });
  assert.equal(score.skipped, true);
  assert.equal(score.reason, 'insufficient-comps');
});

test('lot listings are scored per unit but profit is for the whole lot', () => {
  const lot = { ...gpuIdentity, lotSize: 4 };
  const score = evaluate({ listing: listing({ price: 1000 }), identity: lot, comps, config });
  assert.equal(score.buyPrice, 250);
  assert.ok(Math.abs(score.profit - score.unitProfit * 4) < 0.05, `${score.profit} vs ${score.unitProfit} x4`);
  assert.ok(score.profit > 380 && score.profit < 410, `unexpected lot profit ${score.profit}`);
});
