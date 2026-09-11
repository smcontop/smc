# eBay PC Parts Deal Finder

Scans eBay for **CPU, GPU and RAM** listings that are priced well below what the
same part is selling for, notifies you when one is worth buying to resell, and
shows the survivors in a viewer that works on a PC and a phone.

It is not a keyword alert. Every listing is matched to a specific model
(`RTX 4080 16GB`, `i7-12700K`, `DDR5 32GB 6000`), compared against that model's
own market, and then run through the actual resale maths — eBay fees, shipping
both ways, and packing supplies — before it will alert you. Zero dependencies.

## The buying rules

Every alert has cleared all five. They are the defaults in `src/config.js`:

| Rule | Setting |
| --- | --- |
| **$300 minimum spend** — one item at $300+, or a cheaper one with enough stock to total $300 (a $60 kit with 5 available) | `valuation.minInvestment` |
| **30% or more under market** | `valuation.minDiscount` |
| **GPU, CPU or RAM only** | `search.types` |
| **Desktop RAM only** — SODIMM and laptop memory excluded | `filters.desktopRamOnly` |
| **Seller at 90%+ positive, and no-feedback sellers excluded** | `risk.minFeedbackPercentage`, `risk.requireFeedback` |

Two more floors stop technically-qualifying but pointless buys: `minUnitProfit`
($15, so each unit is worth handling) and `minRoi` (25%).

## What it does

1. **Searches** the CPU, GPU and RAM categories for a list of models you care about.
2. **Screens out** the junk: for-parts, broken, empty-box and photo-only
   listings; accessories ("bracket *for* RTX 4080"); GPU water blocks and
   "GPU chip", bare die, BGA, reballed, PCB-only, donor-board and scrap
   listings; and laptop SODIMM memory. None of them become deals *or* comps.
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
   profit      = (resale - costs - buy price) x every unit you would buy
   spend       = buy price x every unit you would buy
   ```

   When a listing is under $300 but clears everything else, the scanner spends
   one extra API call to ask eBay how many the seller has — that is how a $60
   item with 5 in stock qualifies. Listings that fail on price anyway never
   cost that call.
6. **Notifies** via console, Discord/Slack/generic webhook, or ntfy.sh for phone
   pushes — once per listing, never the same one twice — and keeps the current
   deal list for the viewer app.

## Setup

You need free eBay developer API keys. Node 18+ is the only other requirement —
there is nothing to `npm install`.

1. Sign up at [developer.ebay.com](https://developer.ebay.com/) and create an
   application keyset. Take the **Production** one; Sandbox has no real
   listings, so it produces no real prices.

2. **Enable the keyset.** A new production keyset is disabled until you
   subscribe to (or opt out of) eBay marketplace account deletion notifications.
   Opting out is the right choice here, because this tool stores no eBay user
   data: **Application Keys → Notifications** under the Production keys →
   toggle **"Not persisting eBay data"**. Skip this and every call returns 401.

3. Copy the **App ID** (your Client ID) and **Cert ID** (your Client Secret) and
   put them in your terminal.

   Windows PowerShell, for this session:

   ```powershell
   $env:EBAY_CLIENT_ID="your-app-id"
   $env:EBAY_CLIENT_SECRET="your-cert-id"
   ```

   To keep them for good on Windows, `setx EBAY_CLIENT_ID "your-app-id"` (then
   open a new terminal). On macOS or Linux use `export` and add it to your
   shell profile.

4. Confirm it all works before scanning:

   ```bash
   node src/index.js check
   ```

   It tests the keys, one live search, and a stock lookup, and names the fix for
   whatever fails.

## Usage

```bash
cd ebay-deal-finder

node src/index.js serve                 # viewer app + scanning on a schedule
node src/index.js scan                  # one scan, print deals
node src/index.js scan --verbose        # with scan statistics
node src/index.js watch --interval 20   # keep scanning every 20 minutes
node src/index.js check                 # test your keys and the connection
node src/index.js comps                 # what the tool thinks parts are worth
node src/index.js scan --json           # machine-readable output
npm test                                # 77 tests, no network needed
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
| `--port 8787` | Port for the viewer app |
| `--no-scan` | With `serve`: show saved deals without scanning |
| `--dry-run` | Print deals, send no notifications, mark nothing as seen |
| `--renotify` | Re-alert on listings you were already told about |

### Sample output

```
RAM  ddr5|32gb|6000  (5 in stock)
  Corsair Vengeance 32GB (2x16GB) DDR5 6000MHz CL30 Desktop Memory
  Buy $62.00/unit  |  Market $160.00  |  61% under  (n=9)
  Est. resale $158.00 - $89.75 costs  =>  profit $341.03  (ROI 110%)
  Total spend $310.00 for 5 units
  New | buy it now | seller pcpartsguy (1420 @ 99.6%)
  https://www.ebay.com/itm/...
```

## The viewer app

```bash
node src/index.js serve
```

```
Deal viewer running:
  On this PC   http://localhost:8787
  On your phone http://192.168.1.24:8787
```

Open the first link on Windows; type the second into your iPhone on the same
Wi-Fi. It is one page: your five rules across the top, then a card per
qualifying listing showing estimated profit, what you pay against what it is
worth, how the spend reaches $300, the seller's numbers, and a button straight
to the listing. Filter by GPU/CPU/RAM, sort by profit, ROI, discount, newest or
lowest spend, and hide the ones you have looked at (hidden state is saved, so
your phone and PC agree).

`serve` also keeps scanning on the usual interval, so the page stays current —
add `--no-scan` to browse the last results without touching the API.

The first time you open it from your phone, Windows will ask whether to allow
Node through the firewall: allow it on **private networks**, or the phone URL
will not load.

To look at deals away from your PC, save `http://localhost:8787/api/export` as
`deals.json` and load it into the hosted viewer with **Load deals.json**.

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
- **`valuation.minInvestment` / `minDiscount` / `minProfit` / `minRoi`** — the
  buying rules above. Raise them if you get too many marginal alerts.
- **`valuation.minSamples`** — how many comparable listings are required before
  the tool will state an opinion. Lower it and you will get noise.
- **`valuation.feePercent` / `shippingCostByType`** — match your real costs.
  If your fee tier or shipping differs, the profit numbers are only as good as
  these.
- **`risk.minFeedbackPercentage` / `requireFeedback`** — the seller gate. These
  apply to alerts only: a low-feedback seller's asking price is still valid
  market data, so their listings still count as comps.
- **`risk.skipRisky`** — set to `false` to see flagged deals with warnings
  attached rather than having them dropped.
- **`filters.blockPatterns`** — add your own junk words. Anything you list
  replaces the built-in block list, so copy `DEFAULT_BLOCK_PATTERNS` from
  `src/filters.js` before editing.

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
- **Stock counts are eBay's estimate.** A seller showing 5 available may cancel
  after you buy 5; the $300 total is a plan, not a guarantee.
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
| `src/server.js` | Local HTTP server behind the viewer |
| `web/app.html` | The viewer app (also published as a hosted page) |
