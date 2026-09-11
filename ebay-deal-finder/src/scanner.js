// The scan pipeline: pull listings -> screen -> identify -> build comps ->
// score each listing against its own market -> return the deals worth alerting.

import { CATEGORIES } from './config.js';
import { toListing } from './ebay.js';
import { createFilter, assessRisk, screenSeller } from './filters.js';
import { identify } from './normalize.js';
import { compKey, effectivePrice, evaluate } from './valuation.js';

// A condition that will keep failing until the operator changes something,
// so watch mode must stop rather than retry it on every interval.
export class FatalScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalScanError';
  }
}

// Everything except the total-spend floor already passed, and the single-unit
// spend falls short: the seller's stock is the only thing that can rescue it.
function worthCheckingStock(score, config, lookupsSoFar) {
  const { checkStockUnderInvestment = true, minInvestment = 300, maxStockLookupsPerScan = 60 } = config.valuation;
  if (!checkStockUnderInvestment || lookupsSoFar >= maxStockLookupsPerScan) return false;
  if (score.skipped || score.isDeal) return false;
  if (score.investment >= minInvestment) return false; // already failed on something else

  const { minDiscount = 0.3, minRoi = 0.25, minUnitProfit = 15 } = config.valuation;
  return score.discount >= minDiscount && score.roi >= minRoi && score.unitProfit >= minUnitProfit;
}

function buildApiFilters({ priceMin, priceMax, itemLocationCountry }, { auctionsOnly = false, fixedOnly = false } = {}) {
  const filters = [];
  if (priceMin != null || priceMax != null) {
    filters.push(`price:[${priceMin ?? ''}..${priceMax ?? ''}]`, 'priceCurrency:USD');
  }
  if (itemLocationCountry) filters.push(`itemLocationCountry:${itemLocationCountry}`);
  if (fixedOnly) filters.push('buyingOptions:{FIXED_PRICE}');
  else if (auctionsOnly) filters.push('buyingOptions:{AUCTION}');
  return filters;
}

// Two pulls per query: relevance for a representative comp population, and
// newest-first so a fresh underpriced listing is seen within a scan cycle.
async function pullListings(client, { query, type, search }) {
  const categoryIds = CATEGORIES[type];
  const filters = buildApiFilters(search, { fixedOnly: !search.includeAuctions });
  const maxItems = search.maxItemsPerQuery;

  const [relevance, newest] = await Promise.all([
    client.search({ query, categoryIds, filters, maxItems }),
    client.search({ query, categoryIds, filters, sort: 'newlyListed', maxItems }),
  ]);

  return [...relevance, ...newest];
}

export async function scan({ client, config, store, logger = console, onlyTypes = null }) {
  const screen = createFilter(config.filters);
  const types = (onlyTypes ?? config.search.types).filter((t) => CATEGORIES[t]);

  const seenIds = new Set(); // every item id returned this scan, deal or not
  const candidates = new Map(); // itemId -> { listing, identity, key }
  const stats = { fetched: 0, screened: 0, identified: 0, queries: 0, errors: 0, rejectedSeller: 0 };

  for (const type of types) {
    for (const query of config.search.targets[type] ?? []) {
      stats.queries += 1;
      let raw;
      try {
        raw = await pullListings(client, { query, type, search: config.search });
      } catch (err) {
        // Bad keys or a spent quota will fail every remaining query too, so
        // stop rather than emitting the same error a few dozen times.
        if (err.status === 401 || err.status === 403) {
          throw new FatalScanError(
            `eBay rejected the credentials (${err.status}). Check EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.`,
          );
        }
        if (err.status === 429) {
          throw new Error('eBay rate limit reached (429). Try again later or scan fewer targets.');
        }
        stats.errors += 1;
        logger.error(`Search failed for "${query}": ${err.message}`);
        continue;
      }

      for (const rawItem of raw) {
        const listing = toListing(rawItem);
        // The relevance and newest pulls overlap; screen each item only once.
        if (!listing.id || seenIds.has(listing.id)) continue;
        seenIds.add(listing.id);
        stats.fetched += 1;

        const identity = identify(listing.title, { expectedType: type });
        if (!screen(listing, identity).ok) continue;
        stats.screened += 1;

        if (!identity) continue;
        stats.identified += 1;

        const key = compKey(identity, listing);
        const unitPrice = effectivePrice(listing, {
          lotSize: identity.lotSize,
          assumedShipping: config.valuation.assumedShipping,
        });
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

        candidates.set(listing.id, { listing, identity, key, unitPrice });
        // The store holds this scan's prices and the retained history together,
        // so it is the single source of comps — no separate per-scan pool.
        store.recordPrice(key, unitPrice, { itemId: listing.id });
      }
    }
  }

  const deals = [];
  const evaluated = [];
  let stockLookups = 0;

  for (const candidate of candidates.values()) {
    const { listing, identity, key } = candidate;

    // Comps exclude the listing itself, so a lowball cannot pull down the very
    // median it is being judged against.
    const comps = store.history(key, { excludeItemId: listing.id });

    let score = evaluate({ listing, identity, comps, config: config.valuation });

    // A cheap item can still qualify if the seller has enough of them: only
    // then is the extra availability call worth spending.
    if (worthCheckingStock(score, config, stockLookups)) {
      try {
        const quantity = await client.getAvailableQuantity(listing.id);
        stockLookups += 1;
        if (quantity > 1) {
          score = evaluate({ listing, identity, comps, config: config.valuation, quantityAvailable: quantity });
        }
      } catch (err) {
        stats.errors += 1;
        logger.error(`Stock lookup failed for ${listing.id}: ${err.message}`);
      }
    }

    evaluated.push({ listing, identity, score });
    if (score.skipped || !score.isDeal) continue;
    if (listing.isAuction && !config.search.includeAuctions) continue;

    // Hard seller rules: below the feedback floor, or no feedback at all.
    const sellerProblem = screenSeller(listing, config.risk);
    if (sellerProblem) {
      stats.rejectedSeller += 1;
      continue;
    }

    const risks = assessRisk(listing, config.risk, score.discount);
    if (risks.length && config.risk.skipRisky) {
      // A "too good to be true" gap is a scam signal, not a bargain.
      const onlyAuctionFlag = risks.every((r) => r.startsWith('auction'));
      if (!onlyAuctionFlag) continue;
    }

    deals.push({ listing, identity, score, risks });
  }

  deals.sort((a, b) => b.score.profit - a.score.profit);
  return { deals, evaluated, stats };
}

