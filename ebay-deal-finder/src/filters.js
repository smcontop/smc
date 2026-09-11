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
  // Bare silicon and stripped boards sold as if they were cards or chips
  'gpu (?:core|chip|die)', 'bare (?:die|chip|pcb|board)', 'chip only', 'core only', 'die only',
  'pcb only', 'board only', 'no (?:gpu|core|die|heatsink)', 'de-?soldered', 'desolder(?:ed|ing)?',
  'pulled chip', 'bga (?:chip|reball|rework)', 'reball(?:ed|ing)?', 'donor (?:board|card|chip)',
  'salvage', 'scrap', 'gold recovery', 'harvest(?:ed|ing)?', 'stripped',
  // Water-cooling parts that use the same model names as the cards
  'gpu ?block', 'water ?block', 'waterblock', 'full ?cover block', 'cooling block',
];

export const DEFAULT_ACCESSORY_PATTERNS = [
  'cooler', 'heat ?sink', 'water ?block', 'backplate', 'bracket', 'shroud', 'gpu support',
  'sag bracket', 'riser', 'extension cable', 'power cable', 'adapter', 'thermal (?:pad|paste)',
  'delid', 'holder', 'stand', 'anti-?sag', 'replacement fan', 'fan only', 'cooling kit',
  'mounting kit', 'screw kit', 'dust cover', 'carrying case', 'anti-?static bag', 'tray only',
];

// Laptop and small-form memory: same DDR generation, a different market.
export const LAPTOP_RAM_PATTERNS = [
  'sodimm', 'so-dimm', 'so dimm', 'laptop', 'notebook', 'macbook', 'imac', 'mac ?mini',
  'nuc', 'mini ?pc', 'small form factor memory',
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

export function createFilter({
  blockPatterns,
  accessoryPatterns,
  allowUntested = false,
  desktopRamOnly = true,
} = {}) {
  // null is a valid config value meaning "use the built-in list".
  const blockList = blockPatterns?.length ? blockPatterns : DEFAULT_BLOCK_PATTERNS;
  const accessoryList = accessoryPatterns?.length ? accessoryPatterns : DEFAULT_ACCESSORY_PATTERNS;

  const blocked = compile(blockList);
  const accessory = compile(accessoryList);
  const accessoryFor = compileAccessoryFor(accessoryList);
  const partNoun = compile(PART_NOUNS);
  const laptopRam = compile(LAPTOP_RAM_PATTERNS);

  return function screen(listing, identity = null) {
    const title = listing.title ?? '';

    if (!allowUntested && blocked.test(title)) {
      return { ok: false, reason: 'broken-or-not-the-item' };
    }
    if (accessory.test(title) && (!partNoun.test(title) || accessoryFor.test(title))) {
      return { ok: false, reason: 'accessory-listing' };
    }
    // Desktop memory only: laptop SODIMMs are a different market at a different price.
    if (desktopRamOnly && isRam(listing, identity) && laptopRam.test(title)) {
      return { ok: false, reason: 'laptop-ram' };
    }
    if (!Number.isFinite(listing.price) || listing.price <= 0) {
      return { ok: false, reason: 'no-price' };
    }
    return { ok: true };
  };
}

function isRam(listing, identity) {
  if (identity?.type) return identity.type === 'ram';
  // Screening runs before identification, so fall back to the title.
  return /\b(?:ddr[345]|dimm|memory|ram)\b/i.test(listing.title ?? '');
}

// Hard seller rules, applied to alert candidates only — a low-feedback
// seller's asking price is still a valid data point for the comp pool.
// Returns null when the seller is acceptable, or the reason they are not.
export function screenSeller(listing, { minFeedbackPercentage = 90, requireFeedback = true } = {}) {
  const { feedbackScore, feedbackPercentage } = listing.seller ?? {};

  // No reviews at all: excluded outright, including when eBay reports nothing.
  if (requireFeedback && (feedbackScore == null || feedbackScore < 1)) {
    return 'seller has no feedback';
  }
  if (requireFeedback && feedbackPercentage == null) {
    return 'seller feedback percentage unknown';
  }
  if (feedbackPercentage != null && feedbackPercentage < minFeedbackPercentage) {
    return `seller rated ${feedbackPercentage}% (below ${minFeedbackPercentage}%)`;
  }
  return null;
}

// Softer warnings shown alongside a deal that already passed the hard rules.
export function assessRisk(listing, { maxDiscount = 0.8 } = {}, discount = 0) {
  const flags = [];
  const { feedbackScore } = listing.seller ?? {};

  if (feedbackScore != null && feedbackScore < 20) {
    flags.push(`seller has only ${feedbackScore} feedback`);
  }
  if (discount > maxDiscount) {
    flags.push(`${Math.round(discount * 100)}% under market — too good to be true`);
  }
  if (listing.isAuction) {
    flags.push('auction — price can still climb');
  }
  return flags;
}
