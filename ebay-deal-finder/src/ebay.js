// Thin client for the eBay Browse API (application/client-credentials OAuth).
// Docs: https://developer.ebay.com/api-docs/buy/browse/resources/methods

const ENDPOINTS = {
  production: {
    oauth: 'https://api.ebay.com/identity/v1/oauth2/token',
    browse: 'https://api.ebay.com/buy/browse/v1',
  },
  sandbox: {
    oauth: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    browse: 'https://api.sandbox.ebay.com/buy/browse/v1',
  },
};

const SCOPE = 'https://api.ebay.com/oauth/api_scope';

export class EbayError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'EbayError';
    this.status = status;
    this.body = body;
  }
}

export class EbayClient {
  constructor({ clientId, clientSecret, environment = 'production', marketplaceId = 'EBAY_US', fetchImpl = fetch }) {
    if (!clientId || !clientSecret) {
      throw new EbayError('Missing eBay credentials: set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.endpoints = ENDPOINTS[environment] ?? ENDPOINTS.production;
    this.marketplaceId = marketplaceId;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetch(this.endpoints.oauth, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new EbayError(`eBay OAuth failed (${res.status}). Check your app keys.`, { status: res.status, body });
    }
    const json = JSON.parse(body);
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in ?? 7200) * 1000;
    return this.token;
  }

  // One page of item_summary/search. Returns { items, total }.
  async searchPage({ query, categoryIds, filters = [], sort, limit = 200, offset = 0 }) {
    const token = await this.getToken();
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (categoryIds?.length) params.set('category_ids', categoryIds.join(','));
    if (filters.length) params.set('filter', filters.join(','));
    if (sort) params.set('sort', sort);
    params.set('limit', String(Math.min(limit, 200)));
    params.set('offset', String(offset));

    const url = `${this.endpoints.browse}/item_summary/search?${params.toString()}`;
    const res = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
        Accept: 'application/json',
      },
    });

    const body = await res.text();
    if (!res.ok) {
      throw new EbayError(`eBay search failed (${res.status}) for "${query ?? categoryIds?.join(',')}"`, {
        status: res.status,
        body,
      });
    }
    const json = body ? JSON.parse(body) : {};
    return { items: json.itemSummaries ?? [], total: json.total ?? 0 };
  }

  // Walks pages until maxItems or the result set is exhausted.
  async search({ query, categoryIds, filters, sort, maxItems = 400, pageSize = 200 }) {
    const collected = [];
    for (let offset = 0; collected.length < maxItems; offset += pageSize) {
      const { items, total } = await this.searchPage({
        query,
        categoryIds,
        filters,
        sort,
        limit: Math.min(pageSize, maxItems - collected.length),
        offset,
      });
      collected.push(...items);
      if (items.length === 0 || collected.length >= total) break;
    }
    return collected;
  }

  // How many units the seller actually has. item_summary/search does not carry
  // this, so it costs one extra call — only worth making for a listing that has
  // already cleared every other rule but is too cheap to qualify on its own.
  async getAvailableQuantity(itemId) {
    const token = await this.getToken();
    const res = await this.fetch(`${this.endpoints.browse}/item/${encodeURIComponent(itemId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new EbayError(`eBay item lookup failed (${res.status}) for ${itemId}`, { status: res.status });
    }
    const json = JSON.parse((await res.text()) || '{}');
    return readQuantity(json);
  }
}

// eBay reports availability as an exact number or a bucketed hint; take the
// most conservative reading, since the whole point is a floor on total spend.
function readQuantity(item) {
  const availability = item.estimatedAvailabilities?.[0];
  if (!availability) return 1;

  const exact = availability.estimatedAvailableQuantity;
  if (Number.isFinite(exact) && exact > 0) return exact;

  const remaining = availability.estimatedRemainingQuantity;
  if (Number.isFinite(remaining) && remaining > 0) return remaining;

  // "MORE_THAN" with a threshold means at least that many.
  if (availability.availabilityThresholdType === 'MORE_THAN' && Number.isFinite(availability.availabilityThreshold)) {
    return Math.max(1, availability.availabilityThreshold);
  }
  return 1;
}

// Flattens an eBay item summary into the shape the rest of the pipeline uses.
export function toListing(raw) {
  const price = Number(raw.price?.value ?? NaN);
  const currentBid = raw.currentBidPrice ? Number(raw.currentBidPrice.value) : null;
  const shipping = pickShippingCost(raw.shippingOptions);
  const buyingOptions = raw.buyingOptions ?? [];
  const isAuction = buyingOptions.includes('AUCTION') && !buyingOptions.includes('FIXED_PRICE');

  return {
    id: raw.itemId,
    title: raw.title ?? '',
    url: raw.itemWebUrl ?? raw.itemAffiliateWebUrl ?? '',
    image: raw.image?.imageUrl ?? raw.thumbnailImages?.[0]?.imageUrl ?? null,
    price: isAuction && currentBid != null ? currentBid : price,
    currency: raw.price?.currency ?? 'USD',
    shipping,
    condition: raw.condition ?? 'Unspecified',
    conditionId: raw.conditionId ?? null,
    buyingOptions,
    isAuction,
    bidCount: raw.bidCount ?? null,
    seller: {
      username: raw.seller?.username ?? null,
      feedbackScore: raw.seller?.feedbackScore ?? null,
      feedbackPercentage: raw.seller?.feedbackPercentage != null ? Number(raw.seller.feedbackPercentage) : null,
    },
    categoryIds: (raw.categories ?? []).map((c) => c.categoryId),
    location: raw.itemLocation?.country ?? null,
    listedAt: raw.itemCreationDate ?? null,
  };
}

// null shipping means "unknown" (calculated/local pickup) so valuation can fall back to an estimate.
function pickShippingCost(shippingOptions) {
  if (!shippingOptions?.length) return null;
  const costs = shippingOptions
    .map((o) => (o.shippingCost?.value != null ? Number(o.shippingCost.value) : null))
    .filter((v) => v != null && Number.isFinite(v));
  if (!costs.length) return null;
  return Math.min(...costs);
}
