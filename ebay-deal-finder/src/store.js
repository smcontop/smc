// Local JSON state: the rolling price history that comps are built from, plus
// which listings have already been alerted on so you are not pinged twice.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY = { version: 1, prices: {}, seen: {}, deals: [], dismissed: {}, lastScanAt: null };

export class Store {
  constructor(path, { retentionDays = 30, maxSamplesPerKey = 400, seenRetentionDays = 14 } = {}) {
    this.path = path;
    this.retentionDays = retentionDays;
    this.maxSamplesPerKey = maxSamplesPerKey;
    this.seenRetentionDays = seenRetentionDays;
    this.data = structuredClone(EMPTY);
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...structuredClone(EMPTY), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = structuredClone(EMPTY);
    }
    return this;
  }

  async save() {
    this.prune();
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data), 'utf8');
    await rename(tmp, this.path); // atomic, so a crash mid-write cannot corrupt state
  }

  // One sample per distinct listing: a listing that sits unsold for weeks must
  // not be counted once per scan, or it would dominate its own comp pool.
  recordPrice(key, price, { itemId = null, at = Date.now() } = {}) {
    if (!Number.isFinite(price) || price <= 0) return;
    const rounded = Math.round(price * 100) / 100;
    const samples = (this.data.prices[key] ??= []);

    if (itemId) {
      const existing = samples.findIndex((s) => s[2] === itemId);
      if (existing !== -1) {
        samples[existing] = [at, rounded, itemId];
        return;
      }
    }
    samples.push([at, rounded, itemId]);
  }

  // Comparable prices for a key within the retention window. Pass the listing
  // being judged as excludeItemId so it is never compared against itself.
  history(key, { now = Date.now(), excludeItemId = null } = {}) {
    const cutoff = now - this.retentionDays * 86_400_000;
    return (this.data.prices[key] ?? [])
      .filter(([ts, , itemId]) => ts >= cutoff && (!excludeItemId || itemId !== excludeItemId))
      .map(([, price]) => price);
  }

  hasNotified(itemId) {
    return Boolean(this.data.seen[itemId]);
  }

  markNotified(itemId, at = Date.now()) {
    this.data.seen[itemId] = at;
  }

  prune(now = Date.now()) {
    const priceCutoff = now - this.retentionDays * 86_400_000;
    for (const [key, samples] of Object.entries(this.data.prices)) {
      const kept = samples.filter(([ts]) => ts >= priceCutoff).slice(-this.maxSamplesPerKey);
      if (kept.length) this.data.prices[key] = kept;
      else delete this.data.prices[key];
    }
    const seenCutoff = now - this.seenRetentionDays * 86_400_000;
    for (const [id, ts] of Object.entries(this.data.seen)) {
      if (ts < seenCutoff) delete this.data.seen[id];
    }
  }

  // The deal list the viewer app reads. Kept in the same file as the price
  // history so a scan and its results can never drift apart.
  saveDeals(deals, { at = Date.now() } = {}) {
    this.data.deals = deals.map((deal) => ({
      id: deal.listing.id,
      foundAt: this.data.deals?.find((d) => d.id === deal.listing.id)?.foundAt ?? at,
      listing: deal.listing,
      identity: deal.identity,
      score: deal.score,
      risks: deal.risks ?? [],
    }));
    this.data.lastScanAt = at;
  }

  deals() {
    return this.data.deals ?? [];
  }

  dismissed() {
    return this.data.dismissed ?? {};
  }

  setDismissed(itemId, value, at = Date.now()) {
    this.data.dismissed ??= {};
    if (value) this.data.dismissed[itemId] = at;
    else delete this.data.dismissed[itemId];
  }

  stats() {
    const keys = Object.keys(this.data.prices);
    const samples = keys.reduce((sum, k) => sum + this.data.prices[k].length, 0);
    return { keys: keys.length, samples, seen: Object.keys(this.data.seen).length };
  }
}
