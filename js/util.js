// OriaMaps – small helpers shared by every other file.

export const DOT_TYPES = [
  { id: 'landmark', label: 'Landmarks', single: 'Landmark' },
  { id: 'farm', label: 'Farms', single: 'Farm' },
  { id: 'biome', label: 'Biomes', single: 'Biome' },
  { id: 'dungeon', label: 'Dungeons', single: 'Dungeon' },
  { id: 'misc', label: 'Misc', single: 'Misc' },
  { id: 'portal', label: 'Portals', single: 'Portal' },
];

export function uid(prefix = 'id') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export function slugify(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Straight 3D distance. If one point's height is unknown, the height difference is left out.
export function dist3(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  const dy = a.y === null || a.y === undefined || b.y === null || b.y === undefined ? 0 : a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// "0 h 1 min 18 s" – hours are always shown (decided with the owner).
export function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h} h ${m} min ${s} s`;
}

export function formatBlocks(blocks) {
  return Math.round(blocks).toLocaleString('en-US') + ' blocks';
}

export function formatXYZ(p) {
  return `${p.x}, ${formatY(p.y)}, ${p.z}`;
}

// Finds a dimension from a typed name: full name, start of a name, or short forms OW / N / E.
export function findDimension(text, dims) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const short = { ow: 'overworld', o: 'overworld', n: 'nether', e: 'end' };
  const byId = dims.find((d) => d.id === (short[t] || t));
  if (byId) return byId;
  return dims.find((d) => d.name.toLowerCase() === t) || dims.find((d) => d.name.toLowerCase().startsWith(t)) || null;
}

// Reads "120, 64, -340 (Overworld)", "120 64 -340 (N)" or "120 64 -340 Nether".
// Returns {x, y, z, dim} or {error}. dim is null when none was written.
export function parseCoordinates(text, dims) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'empty' };
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;/\s]\s*(-?\d+(?:\.\d+)?)\s*[,;/\s]\s*(-?\d+(?:\.\d+)?)\s*(?:[,;]?\s*\(?\s*([A-Za-zÀ-ž _-]+?)\s*\)?)?\s*$/);
  if (!m) return { error: 'format' };
  const [x, y, z] = [m[1], m[2], m[3]].map(Number);
  let dim = null;
  if (m[4]) {
    dim = findDimension(m[4], dims);
    if (!dim) return { error: 'dimension', dimText: m[4] };
  }
  return { x, y, z, dim };
}

// Whole numbers only for dot coordinates. "x y z", "x, y, z" and "x/y/z" all work.
// Only two numbers means X and Z with an unknown height (y = null).
export function parseDotCoordinates(text) {
  const parts = String(text || '').trim().split(/\s*[,;/\s]\s*/).filter((s) => s !== '');
  if (!parts.every((s) => /^-?\d+$/.test(s))) return null;
  if (parts.length === 3) return { x: Number(parts[0]), y: Number(parts[1]), z: Number(parts[2]) };
  if (parts.length === 2) return { x: Number(parts[0]), y: null, z: Number(parts[1]) };
  return null;
}

// "1970, ?, -2213" when the height is not known.
export function formatY(y) {
  return y === null || y === undefined ? '?' : String(y);
}

// Letters of the query must appear in the same order in the text.
// Higher score = better. Returns -1 when it does not match.
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, '');
  const t = String(text).toLowerCase();
  if (!q) return -1;
  const direct = t.indexOf(String(query).toLowerCase().trim());
  if (direct === 0) return 1000 - t.length;
  if (direct > 0) return 800 - direct - t.length * 0.1;
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

export function shade(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r * factor, g: g * factor, b: b * factor });
}

export function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}

// Light mode uses a matte version of each colour, made automatically from the neon one.
export function matte(hex) {
  return shade(mixHex(hex, '#7a7a7a', 0.35), 0.85);
}

export function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
