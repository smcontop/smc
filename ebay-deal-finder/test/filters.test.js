import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRisk, createFilter, screenSeller } from '../src/filters.js';

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

test('blocks bare chips, dies and stripped boards', () => {
  for (const title of [
    'NVIDIA RTX 3080 GPU chip BGA',
    'RTX 3080 GPU core only bare die',
    'RTX 4090 PCB only no GPU',
    'Ryzen 9 5950X desoldered chip pulled',
    'RTX 3070 donor board salvage scrap',
    'GA102 GPU die reballed',
  ]) {
    assert.equal(screen(listing(title)).ok, false, `should block: ${title}`);
  }
});

test('blocks water blocks that carry the card name', () => {
  for (const title of [
    'EK Waterblock for RTX 3080 full cover block',
    'Bykski GPU block RTX 3090 water cooling',
    'Alphacool GPU Block RTX 4090',
  ]) {
    assert.equal(screen(listing(title)).ok, false, `should block: ${title}`);
  }
});

test('keeps real cards whose titles merely mention water cooling', () => {
  assert.equal(screen(listing('EVGA RTX 3080 FTW3 Hydro Copper graphics card')).ok, true);
});

test('excludes laptop memory but keeps desktop memory', () => {
  assert.equal(screen(listing('Samsung 32GB DDR5 5600 SODIMM Laptop Memory')).ok, false);
  assert.equal(screen(listing('Crucial 16GB DDR4 3200 SO-DIMM Notebook RAM')).ok, false);
  assert.equal(screen(listing('16GB DDR4 3200 MacBook Pro memory upgrade')).ok, false);
  assert.equal(screen(listing('Corsair Vengeance 32GB DDR5 6000 Desktop Memory DIMM')).ok, true);
});

test('the laptop word only disqualifies memory, not other parts', () => {
  // A desktop CPU pulled from a laptop-adjacent listing is still a desktop CPU.
  assert.equal(screen(listing('Intel Core i7-12700K CPU for laptop or desktop build')).ok, true);
});

test('desktop-only screening can be turned off', () => {
  const lenient = createFilter({ desktopRamOnly: false });
  assert.equal(lenient(listing('32GB DDR5 5600 SODIMM Laptop Memory')).ok, true);
});

test('seller screening enforces the 90% floor and rejects no-feedback accounts', () => {
  assert.equal(screenSeller({ seller: { feedbackScore: 500, feedbackPercentage: 99 } }), null);
  assert.equal(screenSeller({ seller: { feedbackScore: 3, feedbackPercentage: 100 } }), null, 'few but perfect is fine');

  assert.match(screenSeller({ seller: { feedbackScore: 900, feedbackPercentage: 89.9 } }), /below 90%/);
  assert.match(screenSeller({ seller: { feedbackScore: 0, feedbackPercentage: 0 } }), /no feedback/);
  assert.match(screenSeller({ seller: { feedbackScore: null, feedbackPercentage: null } }), /no feedback/);
  assert.match(screenSeller({ seller: {} }), /no feedback/);
  assert.match(screenSeller({ seller: { feedbackScore: 40, feedbackPercentage: null } }), /unknown/);
  // Exactly at the line passes.
  assert.equal(screenSeller({ seller: { feedbackScore: 120, feedbackPercentage: 90 } }), null);
});

test('risk assessment still warns about thin feedback, absurd discounts and auctions', () => {
  assert.deepEqual(assessRisk({ seller: { feedbackScore: 500 } }, {}, 0.3), []);
  assert.match(assessRisk({ seller: { feedbackScore: 2 } }, {}, 0.3)[0], /only 2 feedback/);
  assert.match(assessRisk({ seller: { feedbackScore: 900 } }, {}, 0.9)[0], /too good to be true/);
  assert.match(assessRisk({ isAuction: true, seller: { feedbackScore: 900 } }, {}, 0.3)[0], /auction/);
});
