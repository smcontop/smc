// Works out what a part is actually worth, then whether a listing is cheap
// enough to be worth buying and reselling after eBay takes its cut.

// Condition moves price more than almost anything else, so comps are bucketed by it.
export function conditionBucket(listing) {
  const id = Number(listing.conditionId);
  if (Number.isFinite(id)) {
    if (id <= 1500) return 'new';
    if (id < 3000) return 'refurb';
    if (id < 7000) return 'used';
    return 'parts';
  }
  const c = (listing.condition ?? '').toLowerCase();
  if (c.includes('new') || c.includes('open box')) return 'new';
  if (c.includes('refurb')) return 'refurb';
  if (c.includes('parts')) return 'parts';
  return 'used';
}

export function compKey(identity, listing) {
  return `${identity.key}#${conditionBucket(listing)}`;
}

export function median(values) {
  return percentile(values, 50);
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

// Median absolute deviation — robust spread measure, unlike stddev it is not
// dragged around by the very outliers we are trying to remove.
export function medianAbsoluteDeviation(values) {
  const m = median(values);
  if (m == null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

// Drops listings that are far from the median in either direction: scam-bait
// lowballs and delusional overpriced listings both poison an average.
export function trimOutliers(values, threshold = 3) {
  if (values.length < 4) return [...values];
  const m = median(values);
  const mad = medianAbsoluteDeviation(values);
  if (!mad) return [...values];
  return values.filter((v) => Math.abs(v - m) / mad <= threshold);
}

// What the buyer actually pays, per unit for multi-part lots.
export function effectivePrice(listing, { lotSize = 1, assumedShipping = 0 } = {}) {
  const shipping = listing.shipping ?? assumedShipping;
  const total = listing.price + shipping;
  return total / Math.max(1, lotSize);
}

// eBay final value fee + fixed per-order fee + what it costs you to ship it on.
export function resaleCosts(salePrice, { feePercent = 13.25, fixedFee = 0.4, shippingCost = 0, supplies = 1.5 } = {}) {
  const fees = salePrice * (feePercent / 100) + fixedFee;
  return { fees, shippingCost, supplies, total: fees + shippingCost + supplies };
}

/**
 * Scores one listing against its comp pool.
 * Returns null when there is not enough market data to have an opinion.
 */
export function evaluate({ listing, identity, comps, config }) {
  const {
    minSamples = 8,
    resalePercentile = 45,
    feePercent = 13.25,
    fixedFee = 0.4,
    shippingCostByType = {},
    defaultShippingCost = 12,
    assumedShipping = 0,
    supplies = 1.5,
    minDiscount = 0.25,
    minProfit = 40,
    minRoi = 0.25,
  } = config ?? {};

  const cleanComps = trimOutliers(comps.filter((v) => Number.isFinite(v) && v > 0));
  if (cleanComps.length < minSamples) {
    return { skipped: true, reason: 'insufficient-comps', sampleSize: cleanComps.length };
  }

  const market = median(cleanComps);
  const buyPrice = effectivePrice(listing, { lotSize: identity.lotSize, assumedShipping });
  if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
    return { skipped: true, reason: 'no-price', sampleSize: cleanComps.length };
  }

  // Assume you have to undercut the market a little to actually sell it.
  const resale = percentile(cleanComps, resalePercentile);
  const shippingCost = shippingCostByType[identity.type] ?? defaultShippingCost;
  const costs = resaleCosts(resale, { feePercent, fixedFee, shippingCost, supplies });

  const unitProfit = resale - costs.total - buyPrice;
  const lotSize = Math.max(1, identity.lotSize);
  const profit = unitProfit * lotSize;
  const roi = unitProfit / buyPrice;
  const discount = (market - buyPrice) / market;

  const isDeal = discount >= minDiscount && profit >= minProfit && roi >= minRoi;

  return {
    skipped: false,
    isDeal,
    market: round(market),
    buyPrice: round(buyPrice),
    resale: round(resale),
    unitProfit: round(unitProfit),
    profit: round(profit),
    roi: Number(roi.toFixed(3)),
    discount: Number(discount.toFixed(3)),
    lotSize,
    sampleSize: cleanComps.length,
    costs: {
      fees: round(costs.fees),
      shipping: round(costs.shippingCost),
      supplies: round(costs.supplies),
      total: round(costs.total),
    },
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
