#!/usr/bin/env node
// CLI: scan once, watch on an interval, or inspect the comp data collected so far.

import { parseArgs } from 'node:util';
import { credentialsFromEnv, loadConfig } from './config.js';
import { EbayClient } from './ebay.js';
import { notify } from './notify.js';
import { FatalScanError, scan } from './scanner.js';
import { Store } from './store.js';
import { median } from './valuation.js';

const USAGE = `
eBay PC parts deal finder — flags CPU/GPU/RAM listings priced below market.

Usage:
  node src/index.js scan [options]     Run one scan
  node src/index.js watch [options]    Scan repeatedly on an interval
  node src/index.js comps [options]    Show the price data collected so far

Options:
  --config <path>       Config file (default: config.json)
  --types <list>        Comma-separated: cpu,gpu,ram
  --min-profit <n>      Minimum estimated profit per flip
  --min-roi <n>         Minimum return on investment, e.g. 0.3 for 30%
  --min-discount <n>    Minimum gap below market, e.g. 0.25 for 25%
  --min-samples <n>     Minimum comparable listings before trusting a price
  --interval <minutes>  Watch interval (default 30)
  --include-auctions    Also alert on auction listings
  --dry-run             Score everything but send no notifications
  --json                Print machine-readable JSON instead of text
  --renotify            Ignore the already-notified list
  --verbose             Print scan statistics
  -h, --help            Show this help

Environment:
  EBAY_CLIENT_ID, EBAY_CLIENT_SECRET   Required (developer.ebay.com app keys)
  DEAL_WEBHOOK_URL                     Optional Discord/Slack/generic webhook
  DEAL_NTFY_TOPIC                      Optional ntfy.sh topic for phone pushes
`;

const OPTIONS = {
  config: { type: 'string', default: 'config.json' },
  types: { type: 'string' },
  'min-profit': { type: 'string' },
  'min-roi': { type: 'string' },
  'min-discount': { type: 'string' },
  'min-samples': { type: 'string' },
  interval: { type: 'string' },
  'include-auctions': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  renotify: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

function overridesFrom(values) {
  const valuation = {};
  if (values['min-profit']) valuation.minProfit = Number(values['min-profit']);
  if (values['min-roi']) valuation.minRoi = Number(values['min-roi']);
  if (values['min-discount']) valuation.minDiscount = Number(values['min-discount']);
  if (values['min-samples']) valuation.minSamples = Number(values['min-samples']);

  const search = {};
  if (values['include-auctions']) search.includeAuctions = true;

  const watch = {};
  if (values.interval) watch.intervalMinutes = Number(values.interval);

  const overrides = {};
  if (Object.keys(valuation).length) overrides.valuation = valuation;
  if (Object.keys(search).length) overrides.search = search;
  if (Object.keys(watch).length) overrides.watch = watch;
  return overrides;
}

async function runScan({ client, config, store, values }) {
  const onlyTypes = values.types ? values.types.split(',').map((t) => t.trim().toLowerCase()) : null;
  const { deals, stats } = await scan({ client, config, store, onlyTypes });

  const fresh = values.renotify ? deals : deals.filter((d) => !store.hasNotified(d.listing.id));
  const capped = fresh.slice(0, config.notifications.maxPerScan);

  if (values.verbose && !values.json) {
    console.error(
      `[${new Date().toISOString()}] ${stats.queries} queries, ${stats.fetched} listings, ` +
      `${stats.identified} identified, ${deals.length} deals (${fresh.length} new), ${stats.errors} errors`,
    );
  }

  if (values['dry-run']) {
    if (values.json) console.log(JSON.stringify({ stats, deals: capped }, null, 2));
    else if (!capped.length) console.log('No deals found.');
    else await notify(capped, { console: true }, {});
  } else {
    if (values.json) console.log(JSON.stringify({ stats, deals: capped }, null, 2));
    await notify(capped, { ...config.notifications, console: config.notifications.console && !values.json }, {});
    for (const deal of capped) store.markNotified(deal.listing.id);
  }

  await store.save();
  return { deals: capped, stats };
}

function showComps(store, values) {
  const entries = Object.entries(store.data.prices)
    .map(([key, samples]) => ({
      key,
      samples: samples.length,
      median: median(samples.map(([, price]) => price)),
    }))
    .filter((e) => e.median != null)
    .sort((a, b) => b.samples - a.samples);

  if (values.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log('No price history yet — run a scan first.');
    return;
  }
  const stats = store.stats();
  console.log(`${stats.keys} models tracked, ${stats.samples} price samples\n`);
  for (const { key, samples, median: m } of entries.slice(0, 60)) {
    console.log(`${key.padEnd(46)} n=${String(samples).padStart(4)}  median $${m.toFixed(2)}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const command = positionals[0] ?? 'scan';

  if (values.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const config = await loadConfig(values.config, overridesFrom(values));
  const store = await new Store(config.store.path, config.store).load();

  if (command === 'comps') {
    showComps(store, values);
    return;
  }

  if (command !== 'scan' && command !== 'watch') {
    console.error(`Unknown command: ${command}`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const credentials = credentialsFromEnv();
  if (!credentials.clientId || !credentials.clientSecret) {
    console.error('Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET. See README.md for how to get them.');
    process.exitCode = 1;
    return;
  }

  const client = new EbayClient({
    ...credentials,
    environment: config.environment,
    marketplaceId: config.marketplaceId,
  });

  if (command === 'scan') {
    await runScan({ client, config, store, values });
    return;
  }

  const intervalMs = Math.max(1, config.watch.intervalMinutes) * 60_000;
  console.error(`Watching every ${config.watch.intervalMinutes} min. Ctrl+C to stop.`);
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    console.error('\nStopping.');
    process.exit(0);
  });

  while (!stopped) {
    try {
      await runScan({ client, config, store, values });
    } catch (err) {
      if (err instanceof FatalScanError) throw err; // retrying will not help
      console.error(`Scan failed, will retry next interval: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
