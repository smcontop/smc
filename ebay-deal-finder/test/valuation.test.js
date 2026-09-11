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
  minDiscount: 0.3,
  minInvestment: 300,
  minProfit: 40,
  minUnitProfit: 15,
  minRoi: 0.25,
};

const gpuIdentity = { type: 'gpu', model: 'rtx 4080|16gb', key: 'gpu:rtx 4080|16gb', lotSize: 1 };
const comps = [700, 710, 715, 720, 725, 730, 735, 740, 750, 760];

function listing(overrides = {}) {
  return {
    id: 'v1|1|0', title: 'RTX 4080 16GB', price: 450, shipping: 0, currency: 'USD',
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
  const score = evaluate({ listing: listing({ price: 450 }), identity: gpuIdentity, comps, config });
  assert.equal(score.isDeal, true);
  assert.equal(score.market, 727.5);
  assert.equal(score.buyPrice, 450);
  assert.equal(score.investment, 450);
  assert.ok(score.discount > 0.35, `discount ${score.discount}`);
  assert.ok(score.profit > 140 && score.profit < 180, `unexpected profit ${score.profit}`);
  assert.ok(score.roi > 0.3);
});

test('does not flag a listing priced at market', () => {
  const score = evaluate({ listing: listing({ price: 725 }), identity: gpuIdentity, comps, config });
  assert.equal(score.isDeal, false);
  assert.ok(score.profit < 0, 'buying at market and reselling loses money on fees');
});

test('a discount below the 30% rule is not a deal however profitable', () => {
  // 20% under market: real money, but under the threshold.
  const score = evaluate({ listing: listing({ price: 582 }), identity: gpuIdentity, comps, config });
  assert.ok(score.discount < 0.3 && score.discount > 0.15, `discount ${score.discount}`);
  assert.ok(score.profit > 0, 'still profitable on paper');
  assert.equal(score.isDeal, false, 'but the 30% rule rejects it');
});

test('a single item under the $300 floor is rejected', () => {
  const cheapComps = [140, 145, 148, 150, 152, 155, 158, 160, 162, 165];
  const ramIdentity = { type: 'ram', model: 'ddr5|32gb|6000', key: 'ram:ddr5|32gb|6000', lotSize: 1 };
  const score = evaluate({
    listing: listing({ price: 60, title: 'DDR5 32GB' }), identity: ramIdentity, comps: cheapComps, config,
  });

  assert.ok(score.discount > 0.5, 'genuinely cheap');
  assert.equal(score.investment, 60);
  assert.equal(score.isDeal, false, '$60 alone is under the $300 minimum');
});

test('a cheap item qualifies once the seller has enough stock to reach $300', () => {
  const cheapComps = [140, 145, 148, 150, 152, 155, 158, 160, 162, 165];
  const ramIdentity = { type: 'ram', model: 'ddr5|32gb|6000', key: 'ram:ddr5|32gb|6000', lotSize: 1 };
  const args = { listing: listing({ price: 60, title: 'DDR5 32GB' }), identity: ramIdentity, comps: cheapComps, config };

  assert.equal(evaluate({ ...args, quantityAvailable: 4 }).isDeal, false, '4 x $60 = $240, still short');

  const five = evaluate({ ...args, quantityAvailable: 5 });
  assert.equal(five.investment, 300);
  assert.equal(five.totalUnits, 5);
  assert.equal(five.isDeal, true, '5 x $60 = $300 clears the floor');
  assert.ok(five.profit > 4 * five.unitProfit, 'profit counts every unit');
});

test('a lot listing reaches the floor through its lot size', () => {
  const cheapComps = [140, 145, 148, 150, 152, 155, 158, 160, 162, 165];
  const lotIdentity = { type: 'ram', model: 'ddr5|32gb|6000', key: 'ram:ddr5|32gb|6000', lotSize: 6 };
  const score = evaluate({
    listing: listing({ price: 360, title: 'Lot of 6 DDR5 32GB' }), identity: lotIdentity, comps: cheapComps, config,
  });
  assert.equal(score.buyPrice, 60, 'per unit');
  assert.equal(score.investment, 360);
  assert.equal(score.isDeal, true);
});

test('per-unit profit still has to be worth the handling', () => {
  const thinComps = [70, 71, 72, 73, 74, 75, 76, 77, 78, 79];
  const identity = { type: 'ram', model: 'ddr4|16gb|3200', key: 'ram:ddr4|16gb|3200', lotSize: 1 };
  // 30% under a $75 part is only ~$22, and fees leave under $15 a unit.
  const score = evaluate({
    listing: listing({ price: 50, title: 'DDR4 16GB' }), identity, comps: thinComps, config, quantityAvailable: 10,
  });
  assert.ok(score.investment >= 300, 'clears the spend floor on volume');
  assert.ok(score.unitProfit < 15, `unit profit ${score.unitProfit}`);
  assert.equal(score.isDeal, false);
});

test('shipping cost is counted in the buy price', () => {
  const cheap = evaluate({ listing: listing({ price: 450, shipping: 0 }), identity: gpuIdentity, comps, config });
  const shipped = evaluate({ listing: listing({ price: 450, shipping: 40 }), identity: gpuIdentity, comps, config });
  assert.equal(shipped.buyPrice - cheap.buyPrice, 40);
  assert.ok(shipped.profit < cheap.profit);
});

test('refuses to judge a listing without enough comps', () => {
  const score = evaluate({ listing: listing(), identity: gpuIdentity, comps: [700, 710, 720], config });
  assert.equal(score.skipped, true);
  assert.equal(score.reason, 'insufficient-comps');
});

test('lot listings are scored per unit but profit is for the whole lot', () => {
  const lot = { ...gpuIdentity, lotSize: 4 };
  const score = evaluate({ listing: listing({ price: 1800 }), identity: lot, comps, config });
  assert.equal(score.buyPrice, 450, 'per unit');
  assert.equal(score.totalUnits, 4);
  assert.equal(score.investment, 1800);
  assert.ok(Math.abs(score.profit - score.unitProfit * 4) < 0.05, `${score.profit} vs ${score.unitProfit} x4`);
});
