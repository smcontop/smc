import { readFile } from 'node:fs/promises';

// eBay US leaf categories these searches are pinned to.
export const CATEGORIES = {
  cpu: ['164'], // CPUs/Processors
  gpu: ['27386'], // Graphics/Video Cards
  ram: ['170083'], // Memory (RAM)
};

// Searching per model (rather than sweeping a whole category) is what makes the
// comps meaningful: one query returns many listings of the same part.
export const DEFAULT_TARGETS = {
  gpu: [
    'rtx 5090', 'rtx 5080', 'rtx 5070', 'rtx 4090', 'rtx 4080', 'rtx 4070', 'rtx 4060',
    'rtx 3090', 'rtx 3080', 'rtx 3070', 'rtx 3060', 'rtx 2080', 'gtx 1080', 'gtx 1660',
    'rx 7900', 'rx 7800', 'rx 7600', 'rx 6800', 'rx 6700', 'rx 6600', 'arc a770',
  ],
  cpu: [
    'ryzen 9', 'ryzen 7', 'ryzen 5', 'threadripper',
    'core i9', 'core i7', 'core i5', 'core ultra', 'xeon gold', 'xeon e5',
  ],
  ram: [
    'ddr5 64gb', 'ddr5 32gb', 'ddr5 16gb', 'ddr4 64gb', 'ddr4 32gb', 'ddr4 16gb',
    'ddr4 ecc', 'ddr5 ecc', 'ddr4 sodimm', 'ddr5 sodimm',
  ],
};

export const DEFAULTS = {
  environment: 'production',
  marketplaceId: 'EBAY_US',

  search: {
    types: ['cpu', 'gpu', 'ram'],
    targets: DEFAULT_TARGETS,
    maxItemsPerQuery: 200,
    priceMin: 20,
    priceMax: 5000,
    itemLocationCountry: 'US',
    includeAuctions: false, // auctions are scored but not alerted on unless enabled
  },

  filters: {
    allowUntested: false,
    desktopRamOnly: true, // laptop SODIMM memory is excluded
    blockPatterns: null, // null = built-in list
    accessoryPatterns: null,
  },

  valuation: {
    minSamples: 8, // never call something a deal on thin data
    resalePercentile: 45, // assume you undercut the market slightly to sell
    feePercent: 13.25, // eBay final value fee
    fixedFee: 0.4,
    supplies: 1.5,
    defaultShippingCost: 12,
    shippingCostByType: { cpu: 6, gpu: 18, ram: 6 },
    assumedShipping: 0, // added to listings with unknown/calculated shipping
    minDiscount: 0.3, // must be at least 30% under market
    minInvestment: 300, // total spend, so a $60 item needs 5 in stock to qualify
    minProfit: 40, // across everything you would buy
    minUnitProfit: 15, // each unit has to be worth handling
    minRoi: 0.25,
    checkStockUnderInvestment: true, // one extra API call to count cheap items' stock
    maxStockLookupsPerScan: 60,
  },

  risk: {
    minFeedbackPercentage: 90, // hard rule
    requireFeedback: true, // no reviews at all means no deal
    maxDiscount: 0.8, // beyond this it is almost always a scam listing
    skipRisky: true,
  },

  notifications: {
    console: true,
    webhookUrl: null,
    webhookKind: null, // discord | slack | generic (auto-detected from the URL)
    ntfyTopic: null,
    ntfyServer: 'https://ntfy.sh',
    maxPerScan: 25,
  },

  store: {
    path: 'data/state.json',
    retentionDays: 30,
    maxSamplesPerKey: 400,
    seenRetentionDays: 14,
  },

  watch: {
    intervalMinutes: 30,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

export async function loadConfig(path, overrides = {}) {
  let fileConfig = {};
  if (path) {
    try {
      fileConfig = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Could not read config ${path}: ${err.message}`);
      if (!path.endsWith('config.json')) throw new Error(`Config file not found: ${path}`);
    }
  }

  const envConfig = {
    marketplaceId: process.env.EBAY_MARKETPLACE_ID,
    environment: process.env.EBAY_ENV,
    notifications: {
      webhookUrl: process.env.DEAL_WEBHOOK_URL,
      ntfyTopic: process.env.DEAL_NTFY_TOPIC,
    },
  };

  return mergeConfig(mergeConfig(mergeConfig(DEFAULTS, fileConfig), pruneUndefined(envConfig)), overrides);
}

function pruneUndefined(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isPlainObject(value)) {
      const nested = pruneUndefined(value);
      if (Object.keys(nested).length) out[key] = nested;
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function credentialsFromEnv() {
  return {
    clientId: process.env.EBAY_CLIENT_ID,
    clientSecret: process.env.EBAY_CLIENT_SECRET,
  };
}
