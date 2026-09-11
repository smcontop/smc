// Turns a listing title into a comparable market key, e.g. "gpu:rtx 3080 ti|10gb".
// Two listings only get compared against each other if their keys match exactly,
// so the keys deliberately include the things that move price (VRAM, suffix,
// DDR generation, ECC, laptop form factor) and ignore everything else.

const LOT_PATTERNS = [
  /\blot\s+of\s+(\d{1,3})\b/i,
  /\b(\d{1,3})\s*[-\s]?(?:pack|pcs|pieces|units)\b/i,
  /\bqty\.?\s*[:=]?\s*(\d{1,3})\b/i,
  /\bbulk\s+(\d{1,3})\b/i,
];

export function detectLotSize(title) {
  for (const re of LOT_PATTERNS) {
    const m = title.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 1 && n <= 500) return n;
    }
  }
  return 1;
}

function cleanTitle(title) {
  return title.replace(/\s+/g, ' ').trim();
}

export function detectGpu(title) {
  const t = cleanTitle(title);

  // NVIDIA GeForce: RTX 4090, RTX 3080 Ti, GTX 1660 Super
  let m = t.match(/\b(rtx|gtx)\s*-?\s*(\d{3,4})\s*(ti\s*super|super|ti)?\b/i);
  if (m) {
    const suffix = m[3] ? ` ${m[3].replace(/\s+/g, ' ').toLowerCase()}` : '';
    return withVram(`${m[1].toLowerCase()} ${m[2]}${suffix}`, t);
  }

  // AMD Radeon: RX 7900 XTX, RX 6800 XT, RX 6750 GRE
  m = t.match(/\brx\s*-?\s*(\d{3,4})\s*(xtx|xt|gre)?\b/i);
  if (m) {
    const suffix = m[2] ? ` ${m[2].toLowerCase()}` : '';
    return withVram(`rx ${m[1]}${suffix}`, t);
  }

  // Intel Arc: A770, B580
  m = t.match(/\barc\s+([ab]\d{3})\b/i);
  if (m) return withVram(`arc ${m[1].toLowerCase()}`, t);

  // Workstation / compute: Quadro RTX 5000, Tesla P40, Titan RTX
  m = t.match(/\b(quadro|tesla|titan)\s+((?:rtx|gtx)\s*)?([a-z]?\d{2,4}\s*(?:ti|super|s)?)\b/i);
  if (m) {
    const mid = m[2] ? `${m[2].trim().toLowerCase()} ` : '';
    return withVram(`${m[1].toLowerCase()} ${mid}${m[3].trim().toLowerCase()}`, t);
  }

  return null;
}

// VRAM separates real price tiers (3080 10GB vs 12GB, 4060 Ti 8GB vs 16GB).
function withVram(model, title) {
  const m = title.match(/\b(\d{1,2})\s*gb\b/i);
  return m ? `${model}|${Number(m[1])}gb` : model;
}

export function detectCpu(title) {
  const t = cleanTitle(title);

  // Intel Core Ultra: Core Ultra 7 265K
  let m = t.match(/\bcore\s+ultra\s+([3579])\s+(\d{3})\s*([a-z]{0,3})\b/i);
  if (m) return `core ultra ${m[1]} ${m[2]}${m[3].toLowerCase()}`;

  // Intel Core: i9-14900K, i7 12700KF, i5-9600k
  m = t.match(/\b(i[3579])\s*[-\s]?\s*(\d{4,5})\s*([a-z]{0,3})\b/i);
  if (m) return `${m[1].toLowerCase()}-${m[2]}${m[3].toLowerCase()}`;

  // AMD Ryzen: Ryzen 9 7950X3D, Ryzen 5 5600
  m = t.match(/\bryzen\s+([3579])\s+(\d{4})\s*([a-z0-9]{0,3})\b/i);
  if (m) return `ryzen ${m[1]} ${m[2]}${m[3].toLowerCase()}`;

  // AMD Threadripper: Threadripper 3970X, Threadripper PRO 5975WX
  m = t.match(/\bthreadripper\s+(pro\s+)?(\d{4})\s*([a-z]{0,2})\b/i);
  if (m) return `threadripper ${m[1] ? 'pro ' : ''}${m[2]}${m[3].toLowerCase()}`;

  // Intel Xeon: Xeon E5-2680 v4, Xeon Gold 6248R, Xeon W-2295
  m = t.match(/\bxeon\s+((?:[edwlx]\d?-)?\d{4}[a-z]{0,2})(?:\s+(v\d))?\b/i);
  if (m) return `xeon ${m[1].toLowerCase()}${m[2] ? ` ${m[2].toLowerCase()}` : ''}`;
  m = t.match(/\bxeon\s+(gold|silver|bronze|platinum)\s+(\d{4}[a-z]{0,2})\b/i);
  if (m) return `xeon ${m[1].toLowerCase()} ${m[2].toLowerCase()}`;

  // AMD EPYC: EPYC 7742
  m = t.match(/\bepyc\s+(\d{4}[a-z]{0,2})\b/i);
  if (m) return `epyc ${m[1].toLowerCase()}`;

  return null;
}

export function detectRam(title) {
  const t = cleanTitle(title);

  let generation = null;
  let m = t.match(/\bddr\s*-?\s*([345])\b/i);
  if (m) generation = `ddr${m[1]}`;

  let speed = null;
  // PC4-25600 encodes both generation and bandwidth.
  const pc = t.match(/\bpc\s*-?\s*([345])\s*-?\s*(\d{4,5})\b/i);
  if (pc) {
    generation ??= `ddr${pc[1]}`;
    speed = pcToSpeed(Number(pc[2]));
  }
  // "DDR5-6000" / "DDR4 3200" — the speed attached directly to the generation.
  const attached = t.match(/\bddr\s*-?\s*([345])\s*-\s*(\d{4,5})\b/i);
  if (attached) {
    generation ??= `ddr${attached[1]}`;
    speed ??= plausibleSpeed(Number(attached[2]));
  }
  // A bare speed next to a CAS latency: "DDR5 6000 CL30".
  const cas = t.match(/\b(\d{4,5})\s*(?:mhz|mt\/s)?\s*cl\s*-?\s*\d{1,2}\b/i);
  if (cas) speed ??= plausibleSpeed(Number(cas[1]));

  const mhz = t.match(/\b(\d{4,5})\s*(?:mhz|mt\/s)\b/i);
  if (mhz) speed = plausibleSpeed(Number(mhz[1])) ?? speed;

  if (!generation) return null;

  const capacity = detectRamCapacity(t);
  if (!capacity) return null;

  const parts = [generation, `${capacity}gb`];
  if (speed) parts.push(String(speed));
  if (/\b(ecc|rdimm|lrdimm|registered)\b/i.test(t)) parts.push('ecc');
  if (/\b(sodimm|so-dimm|so dimm|laptop|notebook)\b/i.test(t)) parts.push('sodimm');
  return parts.join('|');
}

// Total capacity of the kit: "2x16GB" is 32GB, a bare "32GB" is 32GB.
function detectRamCapacity(title) {
  const kit = title.match(/\b(\d{1,2})\s*[x*]\s*(\d{1,3})\s*gb\b/i);
  if (kit) {
    const total = Number(kit[1]) * Number(kit[2]);
    if (total > 0 && total <= 4096) return total;
  }
  const kitAlt = title.match(/\b(\d{1,3})\s*gb\s*\(\s*(\d{1,2})\s*[x*]\s*\d{1,3}\s*gb\s*\)/i);
  if (kitAlt) return Number(kitAlt[1]);

  const single = title.match(/\b(\d{1,3})\s*gb\b/i);
  if (single) {
    const v = Number(single[1]);
    if (v > 0 && v <= 4096) return v;
  }
  return null;
}

// Guards against capacities and model numbers being read as a clock speed.
function plausibleSpeed(value) {
  return value >= 1066 && value <= 12000 ? value : null;
}

function pcToSpeed(pcNumber) {
  // PC4-25600 -> 25600 MB/s / 8 bytes per transfer = 3200 MT/s
  return Math.round(pcNumber / 8);
}

const DETECTORS = [
  ['gpu', detectGpu],
  ['cpu', detectCpu],
  ['ram', detectRam],
];

// Returns { type, model, key, lotSize } or null when the title is unidentifiable.
export function identify(title, { expectedType = null } = {}) {
  if (!title) return null;
  const order = expectedType ? DETECTORS.filter(([t]) => t === expectedType) : DETECTORS;

  for (const [type, detect] of order) {
    const model = detect(title);
    if (model) {
      return {
        type,
        model,
        key: `${type}:${model}`,
        lotSize: detectLotSize(title),
      };
    }
  }
  return null;
}
