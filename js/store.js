// OriaMaps – loading the shared data and keeping each visitor's personal settings.
// Shared (same for everyone): data/oriamaps.json in the repository.
// Personal (only in this browser): theme, last world, saved locations and routes.

import { getToken, readFile, writeFile, utf8ToBase64 } from './github.js';

export const DATA_PATH = 'data/oriamaps.json';

function normalise(data) {
  for (const key of ['dimensions', 'worlds', 'players', 'transports', 'terrains', 'dots']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  // Players: name = how you know them (e.g. Discord name), minecraft = Java username for the face (optional),
  // face = uploaded face picture (optional). Older files only had a name, which was the Minecraft name.
  data.players = data.players.map((p) => ({ name: p.name, minecraft: p.minecraft ?? p.name, face: p.face || null }));
  return data;
}

export async function loadData() {
  // The owner reads straight from GitHub, so fresh edits show at once.
  if (getToken()) {
    try {
      const f = await readFile(DATA_PATH);
      return normalise(JSON.parse(f.text));
    } catch (e) {
      console.warn('Could not read from GitHub, using the site copy instead.', e);
    }
  }
  // ?data=… lets a test copy be opened; only files of this site are allowed.
  const asked = new URLSearchParams(location.search).get('data');
  const path = asked && /^[\w./-]+\.json$/.test(asked) && !asked.includes('..') ? asked : DATA_PATH;
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status}).`);
  return normalise(await res.json());
}

export async function saveData(data, message) {
  const text = JSON.stringify(data, null, 2) + '\n';
  await writeFile(DATA_PATH, utf8ToBase64(text), message);
}

// ---------- Personal settings ----------

const PREFS_KEY = 'oriamaps.prefs';
const SAVED_KEY = 'oriamaps.saved';

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export const prefs = {
  get() { return readJson(PREFS_KEY, {}); },
  set(patch) { writeJson(PREFS_KEY, { ...prefs.get(), ...patch }); },
};

// Saved (starred) items, kept per world: { [worldId]: { locations: [dotId], routes: [route] } }
export const saved = {
  all() { return readJson(SAVED_KEY, {}); },
  forWorld(worldId) {
    const s = saved.all()[worldId] || {};
    return { locations: s.locations || [], routes: s.routes || [] };
  },
  update(worldId, fn) {
    const all = saved.all();
    const cur = { locations: [], routes: [], ...(all[worldId] || {}) };
    fn(cur);
    all[worldId] = cur;
    writeJson(SAVED_KEY, all);
  },
};
