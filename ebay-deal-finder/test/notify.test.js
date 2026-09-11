import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDeal, formatMoney, notify } from '../src/notify.js';

const deal = {
  listing: {
    id: 'v1|deal|0',
    title: 'NVIDIA GeForce RTX 3080 10GB Founders Edition',
    url: 'https://www.ebay.com/itm/123',
    image: 'https://img/1.jpg',
    currency: 'USD',
    condition: 'Used',
    isAuction: false,
    seller: { username: 'pcpartsguy', feedbackScore: 1420, feedbackPercentage: 99.6 },
  },
  identity: { type: 'gpu', model: 'rtx 3080|10gb', lotSize: 1 },
  score: {
    buyPrice: 250, market: 427.5, resale: 425.5, profit: 99.22, roi: 0.397,
    discount: 0.415, sampleSize: 12, lotSize: 1, costs: { total: 76.28 },
  },
  risks: [],
};

test('formats money', () => {
  assert.equal(formatMoney(99.2, 'USD'), '$99.20');
  assert.equal(formatMoney(99.2, 'GBP'), 'GBP 99.20');
});

test('the console line carries every number needed to decide', () => {
  const text = formatDeal(deal);
  assert.match(text, /GPU {2}rtx 3080\|10gb/);
  assert.match(text, /Buy \$250\.00/);
  assert.match(text, /Market \$427\.50/);
  assert.match(text, /42% under/);
  assert.match(text, /profit \$99\.22/);
  assert.match(text, /ROI 40%/);
  assert.match(text, /n=12/);
  assert.match(text, /pcpartsguy \(1420 @ 99\.6%\)/);
  assert.match(text, /https:\/\/www\.ebay\.com\/itm\/123/);
});

test('risks and lot size are surfaced', () => {
  const risky = { ...deal, risks: ['seller has only 2 feedback'], score: { ...deal.score, lotSize: 4 } };
  const text = formatDeal(risky);
  assert.match(text, /lot of 4/);
  assert.match(text, /\/unit/);
  assert.match(text, /!! seller has only 2 feedback/);
});

test('sends a Discord embed when the webhook looks like Discord', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, text: async () => '' };
  };
  const { delivered } = await notify([deal], {
    console: false, webhookUrl: 'https://discord.com/api/webhooks/abc',
  }, { fetchImpl, logger: { log() {}, error() {} } });

  assert.deepEqual(delivered, ['discord']);
  assert.equal(sent[0].body.embeds[0].url, 'https://www.ebay.com/itm/123');
  assert.equal(sent[0].body.embeds[0].fields[0].value, '$250.00');
});

test('sends Slack text for a Slack webhook', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, text: async () => '' };
  };
  await notify([deal], { console: false, webhookUrl: 'https://hooks.slack.com/services/x' },
    { fetchImpl, logger: { log() {}, error() {} } });
  assert.match(sent[0].text, /ebay\.com\/itm\/123\|NVIDIA GeForce RTX 3080/);
});

test('pushes to ntfy', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { ok: true, text: async () => '' };
  };
  const { delivered } = await notify([deal], { console: false, ntfyTopic: 'my-topic', ntfyServer: 'https://ntfy.sh' },
    { fetchImpl, logger: { log() {}, error() {} } });

  assert.deepEqual(delivered, ['ntfy']);
  assert.equal(sent[0].url, 'https://ntfy.sh/my-topic');
  assert.match(sent[0].body, /\$250\.00/);
});

test('a failing webhook does not throw away the run', async () => {
  const errors = [];
  const fetchImpl = async () => { throw new Error('network down'); };
  const { delivered } = await notify([deal], { console: false, webhookUrl: 'https://discord.com/api/webhooks/x' },
    { fetchImpl, logger: { log() {}, error: (m) => errors.push(m) } });

  assert.deepEqual(delivered, []);
  assert.match(errors[0], /network down/);
});

test('no deals means no delivery attempts', async () => {
  const fetchImpl = async () => { throw new Error('should not be called'); };
  const { delivered } = await notify([], { webhookUrl: 'https://discord.com/api/webhooks/x' }, { fetchImpl });
  assert.deepEqual(delivered, []);
});
