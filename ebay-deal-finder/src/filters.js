// Keeps broken hardware, accessories and obvious scams out of both the comp
// pool and the alerts. A listing that survives this is a real, working part.

export const DEFAULT_BLOCK_PATTERNS = [
  // Broken / not fully working
  'for parts', 'parts only', 'not working', 'not tested', 'untested', 'as-is', 'as is',
  'broken', 'faulty', 'defective', 'dead', 'damaged', 'cracked', 'bent pins?', 'no display',
  'artifact(?:ing|s)?', 'for repair', 'needs repair', 'spares? or repair', 'read (?:the )?description',
  // Not the item itself
  'empty box', 'box only', 'photos? only', 'picture only', 'replica', 'dummy', 'non.?functional',
  'display model', 'fake', 'placeholder', 'manual only', 'poster', 'keychain', 'sticker',
];

export const DEFAULT_ACCESSORY_PATTERNS = [
  'cooler', 'heat ?sink', 'water ?block', 'backplate', 'bracket', 'shroud', 'gpu support',
  'sag bracket', 'riser', 'extension cable', 'power cable', 'adapter', 'thermal (?:pad|paste)',
  'delid', 'holder', 'stand', 'anti-?sag', 'replacement fan', 'fan only', 'cooling kit',
];

// Words that prove the listing really is the part, so an accessory word in the
// title (e.g. "RTX 3080 graphics card with cooler") does not disqualify it.
const PART_NOUNS = [
  'graphics card', 'video card', 'gpu', 'processor', 'cpu', 'memory', 'ram', 'dimm',
  'founders edition', 'oc edition', 'desktop memory', 'server memory', 'sodimm',
];

function compile(patterns) {
  return new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'i');
}

// "bracket for RTX 3080", "thermal paste for Ryzen 7" — an accessory word
// followed closely by a compatibility phrase means the listing is the
// accessory, not the part, even when the part's name is in the title.
function compileAccessoryFor(patterns) {
  return new RegExp(`\\b(?:${patterns.join('|')})\\b(?:\\s+\\w+){0,2}\\s+(?:for|fits|compatible with)\\b`, 'i');
}

export function createFilter({ blockPatterns, accessoryPatterns, allowUntested = false } = {}) {
  // null is a valid config value meaning "use the built-in list".
  const blockList = blockPatterns?.length ? blockPatterns : DEFAULT_BLOCK_PATTERNS;
  const accessoryList = accessoryPatterns?.length ? accessoryPatterns : DEFAULT_ACCESSORY_PATTERNS;

  const blocked = compile(blockList);
  const accessory = compile(accessoryList);
  const accessoryFor = compileAccessoryFor(accessoryList);
  const partNoun = compile(PART_NOUNS);

  return function screen(listing) {
    const title = listing.title ?? '';

    if (!allowUntested && blocked.test(title)) {
      return { ok: false, reason: 'broken-or-not-the-item' };
    }
    if (accessory.test(title) && (!partNoun.test(title) || accessoryFor.test(title))) {
      return { ok: false, reason: 'accessory-listing' };
    }
    if (!Number.isFinite(listing.price) || listing.price <= 0) {
      return { ok: false, reason: 'no-price' };
    }
    return { ok: true };
  };
}

// Trust checks applied only to alert candidates (never to the comp pool, where
// a low-feedback seller's price is still a valid data point).
export function assessRisk(listing, { minFeedbackScore = 20, minFeedbackPercentage = 95, maxDiscount = 0.8 } = {}, discount = 0) {
  const flags = [];
  const { feedbackScore, feedbackPercentage } = listing.seller ?? {};

  if (feedbackScore != null && feedbackScore < minFeedbackScore) {
    flags.push(`seller has only ${feedbackScore} feedback`);
  }
  if (feedbackPercentage != null && feedbackPercentage < minFeedbackPercentage) {
    flags.push(`seller rated ${feedbackPercentage}%`);
  }
  if (discount > maxDiscount) {
    flags.push(`${Math.round(discount * 100)}% under market — too good to be true`);
  }
  if (listing.isAuction) {
    flags.push('auction — price can still climb');
  }
  return flags;
}
