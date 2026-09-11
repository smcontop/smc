// Alert delivery. Console always; Discord/Slack/generic webhooks and ntfy are
// opt-in via config so the tool works with zero setup and zero dependencies.

export function formatMoney(value, currency = 'USD') {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}

// "3 units" reads better than the raw arithmetic when a lot or a multi-stock
// listing is what gets the buy over the minimum spend.
export function describeUnits(score) {
  const parts = [];
  if (score.lotSize > 1) parts.push(`lot of ${score.lotSize}`);
  if (score.quantityAvailable > 1) parts.push(`${score.quantityAvailable} in stock`);
  return parts.join(', ');
}

export function formatDeal(deal) {
  const { listing, identity, score, risks } = deal;
  const pct = (n) => `${Math.round(n * 100)}%`;
  const units = describeUnits(score);
  const perUnit = score.totalUnits > 1 ? '/unit' : '';

  const lines = [
    `${identity.type.toUpperCase()}  ${identity.model}${units ? `  (${units})` : ''}`,
    `  ${listing.title}`,
    `  Buy ${formatMoney(score.buyPrice, listing.currency)}${perUnit}` +
      `  |  Market ${formatMoney(score.market, listing.currency)}` +
      `  |  ${pct(score.discount)} under  (n=${score.sampleSize})`,
    `  Est. resale ${formatMoney(score.resale, listing.currency)} - ${formatMoney(score.costs.total, listing.currency)} costs` +
      `  =>  profit ${formatMoney(score.profit, listing.currency)}  (ROI ${pct(score.roi)})`,
    `  Total spend ${formatMoney(score.investment, listing.currency)}` +
      (score.totalUnits > 1 ? ` for ${score.totalUnits} units` : ''),
    `  ${listing.condition}${listing.isAuction ? ` | auction, ${listing.bidCount ?? 0} bids` : ' | buy it now'}` +
      `  | seller ${listing.seller.username ?? '?'} (${listing.seller.feedbackScore ?? '?'} @ ${listing.seller.feedbackPercentage ?? '?'}%)`,
    `  ${listing.url}`,
  ];
  if (risks?.length) lines.push(`  !! ${risks.join('; ')}`);
  return lines.join('\n');
}

function discordPayload(deals) {
  return {
    content: `**${deals.length} eBay flip candidate${deals.length === 1 ? '' : 's'}**`,
    embeds: deals.slice(0, 10).map(({ listing, identity, score, risks }) => ({
      title: listing.title.slice(0, 250),
      url: listing.url,
      color: risks?.length ? 0xe6a817 : 0x2ecc71,
      thumbnail: listing.image ? { url: listing.image } : undefined,
      fields: [
        { name: 'Buy', value: `${formatMoney(score.buyPrice, listing.currency)}${score.totalUnits > 1 ? '/unit' : ''}`, inline: true },
        { name: 'Market', value: formatMoney(score.market, listing.currency), inline: true },
        { name: 'Est. profit', value: `${formatMoney(score.profit, listing.currency)} (${Math.round(score.roi * 100)}% ROI)`, inline: true },
        { name: 'Model', value: `${identity.type.toUpperCase()} ${identity.model}`, inline: true },
        { name: 'Total spend', value: `${formatMoney(score.investment, listing.currency)}${describeUnits(score) ? ` (${describeUnits(score)})` : ''}`, inline: true },
        { name: 'Condition', value: `${listing.condition} · n=${score.sampleSize}`, inline: true },
        ...(risks?.length ? [{ name: 'Watch out', value: risks.join('; ').slice(0, 1000) }] : []),
      ],
    })),
  };
}

function slackPayload(deals) {
  const text = deals
    .map(({ listing, score }) =>
      `• <${listing.url}|${listing.title.slice(0, 120)}> — buy ${formatMoney(score.buyPrice, listing.currency)}, ` +
      `market ${formatMoney(score.market, listing.currency)}, profit ~${formatMoney(score.profit, listing.currency)}`)
    .join('\n');
  return { text: `*${deals.length} eBay flip candidate${deals.length === 1 ? '' : 's'}*\n${text}` };
}

export async function notify(deals, config = {}, { fetchImpl = fetch, logger = console } = {}) {
  if (!deals.length) return { delivered: [] };
  const delivered = [];

  if (config.console !== false) {
    logger.log(`\n=== ${deals.length} deal${deals.length === 1 ? '' : 's'} found ===\n`);
    for (const deal of deals) logger.log(`${formatDeal(deal)}\n`);
    delivered.push('console');
  }

  const url = config.webhookUrl;
  if (url) {
    const kind = config.webhookKind ?? (url.includes('discord') ? 'discord' : url.includes('slack') ? 'slack' : 'generic');
    const payload =
      kind === 'discord' ? discordPayload(deals) : kind === 'slack' ? slackPayload(deals) : { deals };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) logger.error(`Webhook failed: ${res.status} ${await res.text()}`);
      else delivered.push(kind);
    } catch (err) {
      logger.error(`Webhook error: ${err.message}`);
    }
  }

  // ntfy.sh — easiest route to a phone push notification.
  if (config.ntfyTopic) {
    const server = config.ntfyServer ?? 'https://ntfy.sh';
    const body = deals
      .map(({ listing, score }) => `${formatMoney(score.buyPrice, listing.currency)} (worth ~${formatMoney(score.market, listing.currency)}) ${listing.title.slice(0, 90)}\n${listing.url}`)
      .join('\n\n');
    try {
      const res = await fetchImpl(`${server}/${config.ntfyTopic}`, {
        method: 'POST',
        headers: {
          Title: `${deals.length} eBay flip candidate${deals.length === 1 ? '' : 's'}`,
          Priority: 'high',
          Tags: 'moneybag',
        },
        body,
      });
      if (!res.ok) logger.error(`ntfy failed: ${res.status}`);
      else delivered.push('ntfy');
    } catch (err) {
      logger.error(`ntfy error: ${err.message}`);
    }
  }

  return { delivered };
}
