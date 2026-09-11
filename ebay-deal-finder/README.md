# eBay PC Parts Deal Finder

Scans eBay for **CPU, GPU and RAM** listings that are priced well below what the
same part is selling for, and notifies you when one is worth buying to resell.

It is not a keyword alert. Every listing is matched to a specific model
(`RTX 3080 10GB`, `i7-12700K`, `DDR5 32GB 6000`), compared against that model's
own market, and then run through the actual resale maths — eBay fees, shipping
both ways, and packing supplies — before it will alert you. Zero dependencies.

## What it does

1. **Searches** the CPU, GPU and RAM categories for a list of models you care about.
2. **Screens out** the junk: for-parts, broken, empty-box, photo-only, and
   accessory listings ("bracket *for* RTX 3080") never become deals or comps.
3. **Identifies the exact part** from the title, so comparisons are like-for-like.
   VRAM size, chip suffix, DDR generation, kit capacity, ECC and SODIMM all
   change the key, because they all change the price.
4. **Builds a price baseline** per model *and condition* from every listing it
   sees, kept in a rolling 30-day local history so baselines get better with use.
   Outliers are trimmed with a median-absolute-deviation filter, so one scam
   listing at $5 and one dreamer at $9,000 can't move the baseline.
5. **Scores the flip**, not just the discount:

   ```
   buy price   = item price + shipping     (per unit for lots)
   resale      = 45th percentile of comps  (you undercut a bit to actually sell)
   costs       = 13.25% eBay fee + $0.40 + your shipping + supplies
   profit      = resale - costs - buy price
   ```

   It alerts only when the discount, the profit **and** the ROI all clear your
   thresholds.
6. **Notifies** via console, Discord/Slack/generic webhook, or ntfy.sh for phone
   pushes — once per listing, never the same one twice.

## Setup

You need free eBay developer API keys:

1. Sign up at [developer.ebay.com](https://developer.ebay.com/), create an app,
   and copy the **production** App ID (Client ID) and Cert ID (Client Secret).
2. Export them:

   ```bash
   export EBAY_CLIENT_ID=your-app-id
   export EBAY_CLIENT_SECRET=your-cert-id
   ```

No `npm install` is needed — the tool has no dependencies and requires Node 18+.

## Usage

```bash
cd ebay-deal-finder

node src/index.js scan                  # one scan, print deals
node src/index.js scan --verbose        # with scan statistics
node src/index.js watch --interval 20   # keep scanning every 20 minutes
node src/index.js comps                 # what the tool thinks parts are worth
node src/index.js scan --json           # machine-readable output
npm test                                # 45 tests, no network needed
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--types gpu,cpu` | Only scan certain categories |
| `--min-profit 75` | Only alert above $75 estimated profit |
| `--min-roi 0.4` | Only alert above 40% return |
| `--min-discount 0.35` | Only alert at 35%+ below market |
| `--min-samples 12` | Demand more comps before trusting a price |
| `--include-auctions` | Also score auction listings |
| `--dry-run` | Print deals, send no notifications, mark nothing as seen |
| `--renotify` | Re-alert on listings you were already told about |

### Sample output

```
GPU  rtx 3080|10gb
  NVIDIA GeForce RTX 3080 10GB Founders Edition
  Buy $250.00  |  Market $427.50  |  42% under  (n=12)
  Est. resale $425.50 - $76.28 costs  =>  profit $99.22  (ROI 40%)
  Used | buy it now | seller pcpartsguy (1420 @ 99.6%)
  https://www.ebay.com/itm/...
```

## Getting notified on your phone

Pick either one (or both):

```bash
# ntfy.sh — install the ntfy app, subscribe to a topic name only you know
export DEAL_NTFY_TOPIC=my-secret-deal-topic-8f3a

# Discord or Slack incoming webhook
export DEAL_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Then run `node src/index.js watch`. To have it run without your machine on,
the included GitHub Actions workflow (`.github/workflows/ebay-deal-scan.yml`)
scans every 2 hours — add the same values as repository secrets.

## Configuration

Copy `config.example.json` to `config.json` and edit. Everything is optional;
the defaults in `src/config.js` are used for anything you leave out. The most
useful knobs:

- **`search.targets`** — the model queries per category. Add the parts you
  actually flip; each query is what gathers the comps for those models.
- **`valuation.minProfit` / `minRoi` / `minDiscount`** — how good a deal has to
  be. Raise these if you get too many marginal alerts. Note the $40 default
  profit floor filters out most RAM, where a genuine 50%-off kit may only clear
  $30; drop `--min-profit` to around 20 if you want those.
- **`valuation.minSamples`** — how many comparable listings are required before
  the tool will state an opinion. Lower it and you will get noise.
- **`valuation.feePercent` / `shippingCostByType`** — match your real costs.
  If your fee tier or shipping differs, the profit numbers are only as good as
  these.
- **`risk.skipRisky`** — set to `false` to see flagged deals with warnings
  attached rather than having them dropped.

## Important limitations — read before spending money

- **Comps are asking prices, not sold prices.** The public Browse API exposes
  active listings only; sold data lives behind eBay's Marketplace Insights API,
  which requires separate approval. Active asking prices skew **high** versus
  what things actually sell for, which is why the resale estimate defaults to
  the 45th percentile rather than the median. Treat the profit figure as an
  optimistic ceiling and spot-check completed listings before you buy.
- **The tool cannot see condition beyond what the seller claims**, spot fake
  photos, or know a GPU was mined on for two years.
- **Very low prices are usually scams, not deals.** Anything more than 80% under
  market is dropped by default for that reason.
- **Auctions** are off by default: the current bid is not the final price.
- A model the tool has never seen enough of will produce no alerts at all until
  enough comps accumulate. That is deliberate. Run `comps` to see the coverage.

## Layout

| File | Purpose |
| --- | --- |
| `src/index.js` | CLI: `scan`, `watch`, `comps` |
| `src/scanner.js` | The pipeline: pull → screen → identify → comp → score |
| `src/ebay.js` | Browse API client (OAuth, paging, response flattening) |
| `src/normalize.js` | Title → model key for CPU, GPU and RAM |
| `src/valuation.js` | Comps, outlier trimming, fees, profit and ROI |
| `src/filters.js` | Junk, accessory and seller-risk screening |
| `src/store.js` | Rolling price history and already-notified listings |
| `src/notify.js` | Console, webhook and ntfy delivery |
