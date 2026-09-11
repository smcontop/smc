import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { createDealServer } from '../src/server.js';
import { Store } from '../src/store.js';

const dirs = [];
const servers = [];

after(async () => {
  for (const server of servers) await new Promise((r) => server.close(r));
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function sampleDeal(id = 'v1|deal|0') {
  return {
    listing: { id, title: 'RTX 4080 16GB', url: 'https://ebay.com/itm/1', condition: 'Used', seller: {} },
    identity: { type: 'gpu', model: 'rtx 4080|16gb', lotSize: 1 },
    score: { profit: 160, buyPrice: 450, market: 727.5, investment: 450, totalUnits: 1, roi: 0.35, discount: 0.38 },
    risks: [],
  };
}

async function startServer({ deals = [sampleDeal()] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'deal-server-'));
  dirs.push(dir);
  const store = await new Store(join(dir, 'state.json'), DEFAULTS.store).load();
  store.saveDeals(deals);

  const server = createDealServer({ store, config: DEFAULTS });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

test('serves the viewer page', async () => {
  const { base } = await startServer();
  const res = await fetch(base);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /<title>Flip Scanner<\/title>/);
});

test('serves the current deals with the rules in force', async () => {
  const { base } = await startServer();
  const data = await (await fetch(`${base}/api/deals`)).json();

  assert.equal(data.deals.length, 1);
  assert.equal(data.deals[0].id, 'v1|deal|0');
  assert.equal(data.rules.minInvestment, 300);
  assert.equal(data.rules.minDiscount, 0.3);
  assert.equal(data.rules.minFeedbackPercentage, 90);
  assert.equal(data.rules.desktopRamOnly, true);
});

test('hiding a deal persists across a reload', async () => {
  const { base, store } = await startServer();
  const res = await fetch(`${base}/api/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'v1|deal|0', dismissed: true }),
  });

  assert.equal(res.status, 200);
  assert.ok(store.dismissed()['v1|deal|0']);

  const reopened = await new Store(store.path, DEFAULTS.store).load();
  assert.ok(reopened.dismissed()['v1|deal|0'], 'written to disk, so the phone and the PC agree');

  await fetch(`${base}/api/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'v1|deal|0', dismissed: false }),
  });
  assert.equal(store.dismissed()['v1|deal|0'], undefined);
});

test('rejects a dismiss with no id', async () => {
  const { base } = await startServer();
  const res = await fetch(`${base}/api/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('exports a deals file the viewer can load back', async () => {
  const { base } = await startServer();
  const res = await fetch(`${base}/api/export`);
  const body = await res.json();

  assert.match(res.headers.get('content-disposition'), /deals\.json/);
  assert.equal(body.deals.length, 1);
  assert.equal(body.deals[0].score.investment, 450);
});

test('unknown paths 404 instead of leaking files', async () => {
  const { base } = await startServer();
  for (const path of ['/nope', '/../src/config.js', '/api/unknown']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});
