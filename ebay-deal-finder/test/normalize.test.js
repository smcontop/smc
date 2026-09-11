import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLotSize, identify } from '../src/normalize.js';

test('identifies NVIDIA GPUs including suffix and VRAM', () => {
  assert.equal(identify('NVIDIA GeForce RTX 3080 Ti 12GB GDDR6X Graphics Card').key, 'gpu:rtx 3080 ti|12gb');
  assert.equal(identify('EVGA RTX3070 8GB XC3 Ultra Gaming').key, 'gpu:rtx 3070|8gb');
  assert.equal(identify('MSI GeForce GTX 1660 Super 6GB').key, 'gpu:gtx 1660 super|6gb');
});

test('separates VRAM variants of the same die', () => {
  const a = identify('RTX 4060 Ti 8GB graphics card');
  const b = identify('RTX 4060 Ti 16GB graphics card');
  assert.notEqual(a.key, b.key);
});

test('identifies AMD and Intel GPUs', () => {
  assert.equal(identify('AMD Radeon RX 6800 XT 16GB').key, 'gpu:rx 6800 xt|16gb');
  assert.equal(identify('Sapphire RX 7900 XTX Nitro+ 24GB').key, 'gpu:rx 7900 xtx|24gb');
  assert.equal(identify('Intel Arc A770 16GB Limited Edition').key, 'gpu:arc a770|16gb');
});

test('identifies Intel and AMD CPUs', () => {
  assert.equal(identify('Intel Core i9-14900K Processor').key, 'cpu:i9-14900k');
  assert.equal(identify('Intel Core i7 12700KF CPU').key, 'cpu:i7-12700kf');
  assert.equal(identify('AMD Ryzen 7 5800X3D Processor').key, 'cpu:ryzen 7 5800x3d');
  assert.equal(identify('AMD Ryzen 9 7950X').key, 'cpu:ryzen 9 7950x');
  assert.equal(identify('Intel Core Ultra 7 265K').key, 'cpu:core ultra 7 265k');
  assert.equal(identify('Intel Xeon E5-2680 v4 Processor').key, 'cpu:xeon e5-2680 v4');
});

test('identifies RAM by generation, total capacity and speed', () => {
  assert.equal(identify('Corsair Vengeance 32GB (2x16GB) DDR5 6000MHz').key, 'ram:ddr5|32gb|6000');
  assert.equal(identify('G.Skill 2x16GB DDR4 3200MHz Desktop Memory').key, 'ram:ddr4|32gb|3200');
  assert.equal(identify('Samsung 16GB DDR4 PC4-25600 SODIMM Laptop RAM').key, 'ram:ddr4|16gb|3200|sodimm');
  assert.equal(identify('64GB DDR4 ECC Registered Server Memory 2666MHz').key, 'ram:ddr4|64gb|2666|ecc');
});

test('kit notation totals the capacity and reads an unsuffixed speed', () => {
  assert.equal(identify('DDR5 2x32GB 6000 CL30').key, 'ram:ddr5|64gb|6000');
  assert.equal(identify('Crucial DDR4-3200 16GB UDIMM').key, 'ram:ddr4|16gb|3200');
});

test('detects lot listings', () => {
  assert.equal(detectLotSize('Lot of 10 Intel Core i5-8500 CPUs'), 10);
  assert.equal(detectLotSize('5 pcs DDR4 8GB 2666MHz'), 5);
  assert.equal(detectLotSize('Single RTX 3060 12GB'), 1);
});

test('returns null for titles with no recognizable model', () => {
  assert.equal(identify('Gaming PC bundle great condition'), null);
  assert.equal(identify(''), null);
});

test('honours the expected type so a RAM query cannot match a GPU string', () => {
  assert.equal(identify('RTX 3080 10GB', { expectedType: 'ram' }), null);
  assert.equal(identify('RTX 3080 10GB', { expectedType: 'gpu' }).type, 'gpu');
});
