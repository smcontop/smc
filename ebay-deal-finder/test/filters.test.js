import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRisk, createFilter } from '../src/filters.js';

const screen = createFilter();

function listing(title, extra = {}) {
  return { title, price: 100, seller: {}, ...extra };
}

test('blocks broken and not-the-item listings', () => {
  for (const title of [
    'RTX 3080 for parts or not working',
    'Ryzen 9 5900X BROKEN bent pins',
    'RTX 4090 empty box only',
    'GTX 1080 untested as-is',
    'RTX 3070 photo only read description',
  ]) {
    assert.equal(screen(listing(title)).ok, false, `should block: ${title}`);
  }
});

test('blocks accessory listings that merely mention a part', () => {
  assert.equal(screen(listing('GPU support bracket for RTX 3080 anti-sag')).ok, false);
  assert.equal(screen(listing('Thermal paste for Ryzen 7 5800X')).ok, false);
});

test('keeps real parts that happen to mention a cooler', () => {
  assert.equal(screen(listing('RTX 3080 graphics card with aftermarket cooler')).ok, true);
  assert.equal(screen(listing('Intel Core i9-12900K processor with stock cooler')).ok, true);
});

test('keeps ordinary working listings', () => {
  assert.equal(screen(listing('NVIDIA RTX 3080 10GB Founders Edition')).ok, true);
  assert.equal(screen(listing('Corsair 32GB DDR5 6000MHz Memory Kit')).ok, true);
});

test('rejects listings with no usable price', () => {
  assert.equal(screen(listing('RTX 3080', { price: 0 })).ok, false);
  assert.equal(screen(listing('RTX 3080', { price: NaN })).ok, false);
});

test('allowUntested opt-in lets through untested gear', () => {
  const lenient = createFilter({ allowUntested: true });
  assert.equal(lenient(listing('RTX 3080 untested')).ok, true);
});

test('risk assessment flags weak sellers, absurd discounts and auctions', () => {
  assert.deepEqual(assessRisk({ seller: { feedbackScore: 500, feedbackPercentage: 99 } }, {}, 0.3), []);
  assert.match(assessRisk({ seller: { feedbackScore: 2, feedbackPercentage: 100 } }, {}, 0.3)[0], /only 2 feedback/);
  assert.match(assessRisk({ seller: { feedbackScore: 900, feedbackPercentage: 80 } }, {}, 0.3)[0], /80%/);
  assert.match(assessRisk({ seller: { feedbackScore: 900, feedbackPercentage: 99 } }, {}, 0.9)[0], /too good to be true/);
  assert.match(assessRisk({ isAuction: true, seller: { feedbackScore: 900, feedbackPercentage: 99 } }, {}, 0.3)[0], /auction/);
});
