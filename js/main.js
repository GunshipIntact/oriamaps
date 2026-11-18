// OriaMaps – main page logic: map interaction, search, panels, router, compass, sidebar.
// Owner-only editing lives in editor.js.

import { Renderer } from './renderer.js';
import { computeRoute, PORTAL_JUMP_SECONDS } from './route.js';
import { loadData, saveData, prefs, saved } from './store.js';
import { getToken } from './github.js';
import { DOT_TYPES, escapeHtml as esc, fuzzyScore, parseCoordinates, formatTime, formatBlocks, formatY, ordinal, uid, matte } from './util.js';
import { initEditor } from './editor.js';

const $ = (id) => document.getElementById(id);

// ---------- State ----------
const S = {
  data: null,
  worldId: null,
  visibleDims: new Set(['overworld']),          // Overworld is on at the start
  types: new Set(DOT_TYPES.map((t) => t.id)),   // all toggles on at the start
  players: new Set(),                           // empty = show everyone's dots
  dark: true,
  grid: 'floor',
  view: '3d',
  saved3d: null,
  selectedId: null,
  hoverId: null,
  leftKind: null,
  owner: false,
  pictureCache: new Map(),
  route: { stops: [], overrides: {}, portal: true, transport: 'horse', terrain: 'none', result: null, lastStart: null, lastDest: null, shown: false },
};

const canvas = $('map');
const renderer = new Renderer(canvas);
const cam = renderer.cam;
let dirty = true;
let anim = null;
let drag = null;
const keys = new Set();

// ---------- Data helpers ----------
const dims = () => S.data.dimensions;
const dimById = (id) => dims().find((d) => d.id === id);
const dimName = (id) => dimById(id)?.name || id;
const dimColor = (id) => { const c = dimById(id)?.color || '#cccccc'; return S.dark ? c : matte(c); };
const world = () => S.data.worlds.find((w) => w.id === S.worldId) || null;
const worldDots = () => S.data.dots.filter((d) => d.world === S.worldId);
const dotById = (id) => S.data.dots.find((d) => d.id === id);
const typeInfo = (id) => DOT_TYPES.find((t) => t.id === id) || { single: id };

function partnerOf(d) {
  if (!d || d.type !== 'portal' || !d.link) return null;
  const p = dotById(d.link);
  return p && p.link === d.id ? p : null;
}
// Linked portals share a name, so the dimension is added in brackets.
const displayName = (d) => (d.type === 'portal' ? `${d.name} (${dimName(d.dim)})` : d.name);

// With several dimensions shown, dimensions with a ratio (Nether 1:8) are stretched to Overworld scale.
const scaleFor = (dimId) => (S.visibleDims.size > 1 ? dimById(dimId)?.ratio || 1 : 1);
// A dot whose height is unknown is drawn on the Y = 0 floor.
const displayPos = (p) => { const s = scaleFor(p.dim); return { x: p.x * s, y: p.y ?? 0, z: p.z * s }; };

// Checking or unchecking dimensions can change the scale (Nether alone: Nether blocks; together with others: Overworld blocks).
// The camera is converted with it, so you keep looking at the same place instead of jumping away.
const frameRatio = (set) => (set.size === 1 ? dimById([...set][0])?.ratio || 1 : 1);
function setVisibleDims(next) {
  const k = frameRatio(S.visibleDims) / frameRatio(next);
  if (k !== 1) {
    cam.target = { x: cam.target.x * k, y: cam.target.y, z: cam.target.z * k };
    cam.viewSize = Math.min(4e6, Math.max(2, cam.viewSize * k));
    anim = null;
  }
  S.visibleDims = next;
}

const isShown = (d) => S.visibleDims.has(d.dim) && S.types.has(d.type) && (S.players.size === 0 || S.players.has(d.finder));

const requestRender = () => { dirty = true; };

// ---------- Pictures and player faces ----------
// Faces come from free head services that turn a Java username into a face picture.
// If both services fail, a plain default head is shown.
const DEFAULT_HEAD = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="#7a7a7a"/><rect y="0" width="8" height="2" fill="#5a5a5a"/><rect x="1" y="4" width="2" height="1" fill="#2b2b2b"/><rect x="5" y="4" width="2" height="1" fill="#2b2b2b"/><rect x="3" y="6" width="2" height="1" fill="#5a5a5a"/></svg>');
const FACE_SOURCES = [
  (n) => `https://mc-heads.net/avatar/${encodeURIComponent(n)}/64`,
  (n) => `https://minotar.net/helm/${encodeURIComponent(n)}/64.png`,
];
// A player's face: an uploaded face picture, else the Minecraft (Java) account's head, else the default head.
function faceImg(name) {
  const p = name ? S.data.players.find((x) => x.name === name) : null;
  if (p && p.face) return `<img class="face" src="${esc(pictureSrc(p.face))}" data-fallback-head="1" alt="${esc(name)}">`;
  if (p && p.minecraft) return `<img class="face" src="${esc(FACE_SOURCES[0](p.minecraft))}" data-player="${esc(p.minecraft)}" data-try="0" alt="${esc(name)}">`;
  return `<img class="face" src="${DEFAULT_HEAD}" alt="">`;
}
const pictureSrc = (path) => S.pictureCache.get(path) || path;
function pictureImg(d) {
  const dim = dimById(d.dim);
  if (d.picture) return `<img src="${esc(pictureSrc(d.picture))}" data-fallback="${esc(dim?.icon || '')}" alt="Picture of ${esc(displayName(d))}">`;
  return dim?.icon ? `<img class="default-pic" src="${esc(dim.icon)}" alt="">` : '';
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('face')) {
    const next = Number(img.dataset.try || 0) + 1;
    img.dataset.try = next;
    if (img.src === DEFAULT_HEAD) return;
    img.src = next < FACE_SOURCES.length && img.dataset.player ? FACE_SOURCES[next](img.dataset.player) : DEFAULT_HEAD;
  } else if (img.dataset.fallback !== undefined && !img.classList.contains('default-pic')) {
    img.classList.add('default-pic');
    if (img.dataset.fallback) img.src = img.dataset.fallback; else img.remove();
  }
}, true);

// ---------- Rendering ----------
function buildScene() {
  const ow = dimById('overworld') || dims()[0];
  const visible = dims().filter((d) => S.visibleDims.has(d.id));
  return {
    dark: S.dark,
    gridMode: S.grid,
    gridColors: visible.length > 1 ? visible.map((d) => d.color) : [],
    // Axes take the colour of the checked dimension; with several (or none) checked they use the default Overworld green.
    axisColor: visible.length === 1 ? visible[0].color : ow ? ow.color : '#39e07a',
    dots: S.worldId ? worldDots().filter(isShown).map((d) => ({
      id: d.id, pos: displayPos(d), color: dimById(d.dim)?.color || '#cccccc', type: d.type,
      label: displayName(d), unlinked: d.type === 'portal' && !partnerOf(d),
      selected: d.id === S.selectedId, hovered: d.id === S.hoverId,
    })) : [],
    route: routeSegments(),
  };
}

function routeSegments() {
  const r = S.route.result;
  if (!r) return [];
  return r.legs.filter((l) => l.type === 'walk' && S.visibleDims.has(l.dim)).map((l) => [displayPos(r.points[l.from]), displayPos(r.points[l.to])]);
}

let lastFrame = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const f = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
  const r = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
  const u = (keys.has(' ') ? 1 : 0) - (keys.has('shift') ? 1 : 0);
  if (f || r || u) { cam.move(f, r, S.view === '3d' ? u : 0, dt); dirty = true; anim = null; }
  if (anim) { stepAnim(now); dirty = true; }
  if (dirty && S.data) {
    dirty = false;
    renderer.draw(buildScene());
    updateViewSize();
    if (!$('compass-panel').hidden) drawCompasses();
  }
  requestAnimationFrame(tick);
}

const fmtBlocks = (n) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n >= 10 ? n.toFixed(0) : n.toFixed(1));
function updateViewSize() {
  const v = renderer.visibleSize();
  $('view-size').textContent = `View: ${fmtBlocks(v.w)} × ${fmtBlocks(v.h)} blocks · grid square ${v.grid}`;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function flyTo(pos, size = 64) {
  anim = { from: { ...cam.target }, to: { ...pos }, s0: cam.viewSize, s1: Math.min(cam.viewSize, size), t0: performance.now(), dur: 700 };
}
function stepAnim(now) {
  const t = Math.min(1, (now - anim.t0) / anim.dur), e = ease(t);
  cam.target = { x: anim.from.x + (anim.to.x - anim.from.x) * e, y: anim.from.y + (anim.to.y - anim.from.y) * e, z: anim.from.z + (anim.to.z - anim.from.z) * e };
  cam.viewSize = Math.exp(Math.log(anim.s0) + (Math.log(anim.s1) - Math.log(anim.s0)) * e);
  if (t >= 1) anim = null;
}

// ---------- Map mouse and keyboard ----------
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  anim = null;
  drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, dot: renderer.pick(e.clientX, e.clientY), pivot: null };
  if (!drag.dot && S.view === '3d') drag.pivot = cam.pickFocus(e.clientX, e.clientY);
  hideHover();
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
    drag.lx = e.clientX; drag.ly = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) {
      drag.moved = true;
      if (S.view === '3d' && !drag.pivot) drag.pivot = cam.pickFocus(drag.x, drag.y);
      canvas.classList.add('dragging');
    }
    if (drag.moved) {
      if (S.view === '3d') cam.orbitAround(drag.pivot, dx, dy); else cam.pan2d(dx, dy);
      dirty = true;
    }
    return;
  }
  const id = renderer.pick(e.clientX, e.clientY);
  canvas.classList.toggle('over-dot', Boolean(id));
  if (id !== S.hoverId) { S.hoverId = id; dirty = true; }
  if (id) showHover(id, e.clientX, e.clientY); else hideHover();
});
const endDrag = () => {
  if (drag && !drag.moved && drag.dot) selectDot(drag.dot);
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { if (!drag) { hideHover(); if (S.hoverId) { S.hoverId = null; dirty = true; } } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  anim = null;
  const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
  cam.zoomAt(e.clientX, e.clientY, Math.exp(delta * 0.0015));
  hideHover();
  dirty = true;
}, { passive: false });

const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('.modal-back')) return;
    if (S.leftKind) closeLeft();
    return;
  }
  if (typing() || document.querySelector('.modal-back')) return;
  const k = e.key === 'Shift' ? 'shift' : e.key.toLowerCase();
  if (['w', 'a', 's', 'd', ' ', 'shift'].includes(k)) { keys.add(k); if (k === ' ') e.preventDefault(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key === 'Shift' ? 'shift' : e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('resize', () => { renderer.resize(); dirty = true; });

// ---------- Dot cards ----------
function dotCardHTML(d, { pinned = false, linked = false } = {}) {
  const dim = dimById(d.dim);
  const unlinked = d.type === 'portal' && !partnerOf(d);
  const owner = pinned && S.owner;
  return `<div class="tip dot-card">
    ${linked ? '<span class="kind">Linked portal</span>' : ''}
    <div class="head"><span class="name">${esc(displayName(d))}</span>${pinned && !linked ? '<button class="btn close-btn" type="button" data-act="close-left" aria-label="Close">X</button>' : ''}</div>
    <span class="coords" style="color:${dimColor(d.dim)}">X ${d.x} · Y ${formatY(d.y)} · Z ${d.z} · ${esc(dim?.name || d.dim)}</span>
    ${unlinked ? '<span class="kind" style="color:#ff6b6b">Unlinked portal: not used for routes</span>' : ''}
    <div class="row">
      <div class="finder"><div class="slot">${faceImg(d.finder)}</div><span>${esc(d.finder || 'Unknown')}</span></div>
      <div class="slot pic">${pictureImg(d)}</div>
    </div>
    ${d.comment ? `<p class="comment">${esc(d.comment)}</p>` : ''}
    ${owner ? `<div class="actions">${linked ? '' : `<button class="btn small" type="button" data-act="edit-dot" data-id="${d.id}">Edit</button>`}<button class="btn small red" type="button" data-act="delete-dot" data-id="${d.id}">Delete${linked ? ' this portal' : ''}</button></div>` : ''}
  </div>`;
}

function cardsFor(id, pinned) {
  const d = dotById(id);
  if (!d) return '';
  const p = partnerOf(d);
  return dotCardHTML(d, { pinned }) + (p ? dotCardHTML(p, { pinned, linked: true }) : '');
}

const hoverEl = $('hover-bubbles');
function showHover(id, x, y) {
  if (hoverEl.dataset.id !== id) { hoverEl.innerHTML = cardsFor(id, false); hoverEl.dataset.id = id; }
  hoverEl.hidden = false;
  placeBubble(x + 18, y + 18, x - 18);
}
function placeBubble(left, top, rightEdge) {
  const w = hoverEl.offsetWidth, h = hoverEl.offsetHeight;
  if (left + w > window.innerWidth - 170) left = rightEdge - w;
  hoverEl.style.left = Math.max(8, left) + 'px';
  hoverEl.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
}
function hideHover() { hoverEl.hidden = true; hoverEl.dataset.id = ''; }

// ---------- Left panel (pinned dot, results, saved, players – the newest replaces the others) ----------
const leftEl = $('left-panel');
function showLeft(kind, html) { leftEl.innerHTML = html; leftEl.hidden = false; leftEl.scrollTop = 0; S.leftKind = kind; }
function closeLeft() { leftEl.hidden = true; leftEl.innerHTML = ''; S.leftKind = null; }

function selectDot(id) {
  S.selectedId = id;
  showLeft('pinned', cardsFor(id, true));
  updateStar();
  dirty = true;
}

leftEl.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act],[data-dot],[data-player-pick],[data-route],[data-tab]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'close-left') { closeLeft(); return; } // the dot stays the compass target ("last clicked dot")
  if (act === 'edit-dot') return app.editor?.editDot(t.dataset.id);
  if (act === 'delete-dot') return app.editor?.deleteDot(t.dataset.id);
  if (act === 'unsave-loc') { e.stopPropagation(); saved.update(S.worldId, (s) => { s.locations = s.locations.filter((x) => x !== t.dataset.id); }); updateStar(); return openSaved('locations'); }
  if (act === 'delete-route') { e.stopPropagation(); return deleteSavedRoute(t.dataset.id); }
  if (act === 'rename-route') { e.stopPropagation(); return renameSavedRoute(t.dataset.id); }
  if (act === 'everyone') { S.players.clear(); dirty = true; return openPlayers(); }
  if (t.dataset.tab) return openSaved(t.dataset.tab);
  if (t.dataset.dot) return goToDot(t.dataset.dot);
  if (t.dataset.playerPick !== undefined) {
    const name = t.dataset.playerPick;
    if (S.leftKind === 'results') return openPlayers(name);
    if (S.players.has(name)) S.players.delete(name); else S.players.add(name);
    dirty = true;
    return openPlayers();
  }
  if (t.dataset.route) return loadSavedRoute(t.dataset.route);
});

function goToDot(id) {
  const d = dotById(id);
  if (!d) return;
  if (!S.visibleDims.has(d.dim)) setVisibleDims(new Set([...S.visibleDims, d.dim]));
  S.types.add(d.type);
  if (S.players.size && !S.players.has(d.finder)) S.players.clear();
  renderChecks();
  $('search').value = displayName(d);
  selectDot(id);
  flyTo(displayPos(d));
}

// ---------- Search ----------
const searchEl = $('search');
function runSearch() {
  updateStar();
  const q = searchEl.value.trim();
  if (!q) { if (S.leftKind === 'results') closeLeft(); return; }
  if (!S.worldId) return;
  const items = [];
  for (const d of worldDots()) { const sc = fuzzyScore(q, displayName(d)); if (sc >= 0) items.push({ sc, d }); }
  for (const p of S.data.players) { const sc = fuzzyScore(q, p.name); if (sc >= 0) items.push({ sc: sc - 1, p }); }
  items.sort((a, b) => b.sc - a.sc);
  const top = items.slice(0, 25);
  const rows = top.map(({ d, p }) => {
    if (d) {
      return `<button class="list-item" type="button" data-dot="${d.id}"><span class="txt"><span>${esc(displayName(d))}</span><small style="color:${dimColor(d.dim)}">${d.x}, ${formatY(d.y)}, ${d.z} · ${esc(dimName(d.dim))}</small></span><span class="slot thumb">${pictureImg(d)}</span></button>`;
    }
    const n = worldDots().filter((x) => x.finder === p.name).length;
    return `<button class="list-item" type="button" data-player-pick="${esc(p.name)}"><span class="slot face-slot">${faceImg(p.name)}</span><span class="txt" style="flex:1"><span>${esc(p.name)}</span><small class="muted">Player · ${n} dot${n === 1 ? '' : 's'} found</small></span></button>`;
  }).join('');
  showLeft('results', `<div class="panel list-panel"><div class="list-head"><span class="muted">Results · ${items.length} match${items.length === 1 ? '' : 'es'}</span></div>${rows || `<div class="empty">Nothing matches "${esc(q)}".</div>`}</div>`);
}
searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('focus', () => { if (searchEl.value.trim() && S.leftKind !== 'results') runSearch(); });
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = leftEl.querySelector('[data-dot],[data-player-pick]'); if (S.leftKind === 'results' && first) first.click(); }
});
// Clicking anywhere outside the results closes them.
document.addEventListener('pointerdown', (e) => {
  if (S.leftKind === 'results' && !leftEl.contains(e.target) && !$('search-wrap').contains(e.target)) closeLeft();
}, true);

function starDot() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q || !S.worldId) return null;
  return worldDots().find((d) => displayName(d).toLowerCase() === q) || null;
}
function updateStar() {
  const d = starDot();
  const btn = $('star-btn');
  btn.disabled = !d;
  const isSaved = Boolean(d && saved.forWorld(S.worldId).locations.includes(d.id));
  btn.classList.toggle('saved', isSaved);
  btn.setAttribute('aria-label', isSaved ? 'Remove from saved locations' : 'Save this dot');
  btn.title = btn.getAttribute('aria-label');
}
$('star-btn').addEventListener('click', () => {
  const d = starDot();
  if (!d) return;
  let nowSaved = false;
  saved.update(S.worldId, (s) => {
    if (s.locations.includes(d.id)) s.locations = s.locations.filter((x) => x !== d.id);
    else { s.locations.push(d.id); nowSaved = true; }
  });
  updateStar();
  toast(nowSaved ? `${displayName(d)} saved.` : `${displayName(d)} removed from saved locations.`);
  if (S.leftKind === 'saved') openSaved('locations');
});

// ---------- Saved popup ----------
function openSaved(tab) {
  if (!S.worldId) return toast('There is no world yet.');
  const s = saved.forWorld(S.worldId);
  let body;
  if (tab === 'locations') {
    const list = s.locations.map(dotById).filter(Boolean);
    body = list.map((d) => `<div class="list-item" role="button" tabindex="0" data-dot="${d.id}"><span class="txt"><span>${esc(displayName(d))}</span><small style="color:${dimColor(d.dim)}">${d.x}, ${formatY(d.y)}, ${d.z} · ${esc(dimName(d.dim))}</small></span><button class="btn small" type="button" data-act="unsave-loc" data-id="${d.id}" aria-label="Remove ${esc(displayName(d))}">X</button></div>`).join('')
      || '<div class="empty">No saved locations yet. Search for a dot and press the star next to the search bar.</div>';
  } else {
    body = s.routes.map((r) => `<div class="list-item" role="button" tabindex="0" data-route="${r.id}"><span class="txt"><span>${esc(r.name)}</span><small class="muted">${esc(r.start)} to ${esc(r.dest)}</small></span><span style="display:flex;gap:4px"><button class="btn small" type="button" data-act="rename-route" data-id="${r.id}">Rename</button><button class="btn small" type="button" data-act="delete-route" data-id="${r.id}" aria-label="Delete ${esc(r.name)}">X</button></span></div>`).join('')
      || '<div class="empty">No saved routes yet. Calculate a route and press the star in the Router.</div>';
  }
  showLeft('saved', `<div class="panel list-panel">
    <div class="list-head"><span class="list-title">Saved</span><button class="btn close-btn" type="button" data-act="close-left" aria-label="Close">X</button></div>
    <div class="tabs"><button class="btn small ${tab === 'locations' ? 'on' : ''}" type="button" data-tab="locations">Locations</button><button class="btn small ${tab === 'routes' ? 'on' : ''}" type="button" data-tab="routes">Routes</button></div>
    ${body}</div>`);
}
leftEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[role="button"]')) e.target.click(); });
$('saved-loc-btn').addEventListener('click', () => openSaved('locations'));
$('saved-route-btn').addEventListener('click', () => openSaved('routes'));

// ---------- Players (find dots by who discovered them) ----------
function openPlayers(focus) {
  if (focus) { S.players = new Set([focus]); dirty = true; }
  const counts = new Map();
  for (const d of worldDots()) counts.set(d.finder, (counts.get(d.finder) || 0) + 1);
  const rows = S.data.players.map((p) => {
    const on = S.players.has(p.name);
    const n = counts.get(p.name) || 0;
    return `<button class="list-item ${on ? 'active' : ''}" type="button" data-player-pick="${esc(p.name)}" aria-pressed="${on}">
      <span class="player-row" style="flex:1"><span class="check" aria-checked="${on}"><span class="box"></span></span><span class="slot face-slot">${faceImg(p.name)}</span><span class="txt"><span>${esc(p.name)}</span><small class="muted">${n} dot${n === 1 ? '' : 's'} found</small></span></span></button>`;
  }).join('') || '<div class="empty">No players yet.</div>';
  const note = S.players.size ? `Showing only dots found by ${[...S.players].map(esc).join(', ')}.` : 'Showing everyone\'s dots. Pick one or more players to see only theirs.';
  showLeft('players', `<div class="panel list-panel">
    <div class="list-head"><span class="list-title">Players</span><span style="display:flex;gap:4px"><button class="btn small" type="button" data-act="everyone">Show everyone</button><button class="btn close-btn" type="button" data-act="close-left" aria-label="Close">X</button></span></div>
    <div class="empty">${note}</div>${rows}</div>`);
}
$('players-btn').addEventListener('click', () => openPlayers());

// ---------- Sidebar ----------
function renderChecks() {
  if (!S.data) return;
  $('dim-list').innerHTML = dims().map((d) => `<button class="check" type="button" role="checkbox" aria-checked="${S.visibleDims.has(d.id)}" data-dim="${d.id}"><span class="box"></span>${d.icon ? `<img src="${esc(d.icon)}" alt="">` : ''}<span style="color:${S.dark ? d.color : '#ffffff'}">${esc(d.name)}</span></button>`).join('');
  $('type-list').innerHTML = DOT_TYPES.map((t) => `<button class="check" type="button" role="checkbox" aria-checked="${S.types.has(t.id)}" data-type="${t.id}"><span class="box"></span>${t.label}</button>`).join('');
  document.querySelectorAll('#view-seg .btn').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  document.querySelectorAll('#grid-seg .btn').forEach((b) => b.classList.toggle('on', b.dataset.grid === S.grid));
}
$('dim-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dim]');
  if (!b) return;
  const id = b.dataset.dim;
  const next = new Set(S.visibleDims);
  if (next.has(id)) next.delete(id); else next.add(id);
  setVisibleDims(next);
  renderChecks(); dirty = true;
});
$('type-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  const id = b.dataset.type;
  if (S.types.has(id)) S.types.delete(id); else S.types.add(id);
  renderChecks(); dirty = true;
});
$('view-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b || b.dataset.view === S.view) return;
  S.view = b.dataset.view;
  if (S.view === '2d') { S.saved3d = { yaw: cam.yaw, pitch: cam.pitch }; cam.mode = '2d'; }
  else { cam.mode = '3d'; if (S.saved3d) { cam.yaw = S.saved3d.yaw; cam.pitch = S.saved3d.pitch; } }
  prefs.set({ view: S.view });
  renderChecks(); dirty = true;
});
$('grid-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-grid]');
  if (!b) return;
  S.grid = b.dataset.grid;
  prefs.set({ grid: S.grid });
  renderChecks(); dirty = true;
});
function applyTheme() {
  document.body.classList.toggle('light', !S.dark);
  renderChecks();
  dirty = true;
}
$('theme-btn').addEventListener('click', () => { S.dark = !S.dark; prefs.set({ dark: S.dark }); applyTheme(); if (S.selectedId && S.leftKind === 'pinned') selectDot(S.selectedId); });

// ---------- World picker ----------
function renderWorldMenu() {
  const w = world();
  $('world-name').textContent = w ? w.name : 'none';
  const menu = $('world-menu');
  menu.innerHTML = S.data.worlds.map((x) => `<button class="btn small ${x.id === S.worldId ? 'on' : ''}" type="button" data-world="${x.id}">${esc(x.name)}</button>`).join('') || '<span class="empty">No worlds yet.</span>';
  menu.classList.add('hover-open');
}
$('world-btn').addEventListener('click', () => { const m = $('world-menu'); m.hidden = !m.hidden; m.classList.toggle('hover-open', m.hidden); });
$('world-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-world]');
  if (!b) return;
  setWorld(b.dataset.world);
  $('world-menu').hidden = true;
  $('world-menu').classList.add('hover-open');
  $('world-btn').blur();
});
function setWorld(id) {
  S.worldId = id;
  prefs.set({ worldId: id });
  S.selectedId = null;
  S.route.result = null;
  $('router').hidden = true;
  closeLeft();
  refreshAll();
}

// ---------- Route planner ----------
function transportLabel(t, long) {
  const twin = S.data.transports.some((o) => o !== t && o.name === t.name);
  const base = twin ? `${t.name} (${t.condition})` : t.name;
  return long ? `${base} · ${t.speed} m/s` : base;
}
function fillRouteSelects() {
  const R = S.route;
  if (!S.data.transports.some((t) => t.id === R.transport)) R.transport = S.data.transports[0]?.id;
  $('transport-select').innerHTML = S.data.transports.map((t) => `<option value="${t.id}" ${t.id === R.transport ? 'selected' : ''}>${esc(transportLabel(t, true))}</option>`).join('');
  $('terrain-select').innerHTML = S.data.terrains.map((t) => `<option value="${t.id}" ${t.id === R.terrain ? 'selected' : ''}>${t.mult}x · ${esc(t.name)}</option>`).join('');
}

// A route point can be a saved dot (by name) or coordinates with a dimension.
function resolvePoint(text, key, kind) {
  const t = String(text || '').trim();
  const what = kind === 'start' ? 'a starting point' : kind === 'dest' ? 'a destination' : 'the new point';
  if (!t) return { error: `Enter ${what}.` };
  const lower = t.toLowerCase();
  const wd = worldDots();
  let d = wd.find((x) => displayName(x).toLowerCase() === lower);
  if (!d) {
    const same = wd.filter((x) => x.name.toLowerCase() === lower);
    if (same.length === 1) d = same[0];
    else if (same.length > 1) return { error: `"${t}" is a portal pair. Write ${same.map(displayName).join(' or ')}.` };
  }
  if (d) return { key: 'dot:' + d.id, label: displayName(d), dim: d.dim, x: d.x, y: d.y, z: d.z, kind, dotId: d.id };
  const c = parseCoordinates(t, dims());
  if (c.error === 'dimension') return { error: `"${c.dimText}" is not a dimension. Use ${dims().map((x) => x.name).join(', ')}.` };
  if (c.error) return { error: `"${t}" is neither a saved dot nor coordinates like 120, 64, -340 (Overworld).` };
  let dim = c.dim;
  if (!dim) {
    if (S.visibleDims.size === 1) dim = dimById([...S.visibleDims][0]);
    else return { error: `Add the dimension to "${t}", for example (Overworld).` };
  }
  return { key, label: `${c.x}, ${c.y}, ${c.z}`, dim: dim.id, x: c.x, y: c.y, z: c.z, kind };
}

function calcRoute({ fresh = false } = {}) {
  const R = S.route;
  if (!S.worldId) return toast('There is no world yet.');
  const startText = $('start-input').value.trim();
  const destText = $('dest-input').value.trim();
  // A new start or destination means a brand-new route: stopovers and per-point choices are cleared.
  if (fresh || startText !== R.lastStart || destText !== R.lastDest) { R.stops = []; R.overrides = {}; }
  R.lastStart = startText; R.lastDest = destText;
  const start = resolvePoint(startText, 'start', 'start');
  const dest = resolvePoint(destText, 'dest', 'dest');
  const stops = R.stops.map((s) => ({ s, p: resolvePoint(s.text, 'stop:' + s.uid, 'stop') }));
  const errors = [start.error, dest.error, ...stops.map((x) => x.p.error)].filter(Boolean);
  if (errors.length) { R.result = null; showRouter(errors.join(' ')); dirty = true; return; }
  const portals = worldDots().filter((d) => d.type === 'portal' && partnerOf(d)).map((d) => ({
    key: 'dot:' + d.id, label: displayName(d), dim: d.dim, x: d.x, y: d.y, z: d.z, partnerKey: 'dot:' + partnerOf(d).id, dotId: d.id,
  }));
  const waypoints = [start, ...stops.map((x) => ({ ...x.p, stopUid: x.s.uid })), dest];
  const res = computeRoute(waypoints, portals, {
    portalTravel: R.portal, defaultTransport: R.transport, defaultTerrain: R.terrain,
    overrides: R.overrides, transports: S.data.transports, terrains: S.data.terrains,
  });
  R.result = res.error ? null : res;
  showRouter(res.error || '');
  dirty = true;
}

function showRouter(message) {
  const R = S.route, res = R.result;
  R.shown = true;
  $('router').hidden = false;
  const msg = $('router-msg');
  msg.hidden = !message;
  msg.textContent = message || '';
  $('route-time').textContent = res ? formatTime(res.totalSeconds) : '-';
  $('route-blocks').textContent = res ? formatBlocks(res.totalBlocks) : '-';
  $('add-point-btn').disabled = !res;
  $('route-star').classList.remove('saved');
  if (!res) { $('router-rows').innerHTML = ''; return; }
  const last = res.points.length - 1;
  $('router-rows').innerHTML = res.points.map((p, i) => {
    const label = i === 0 ? 'Starting point' : i === last ? 'Destination point' : `${ordinal(i + 1)} point`;
    const name = p.dotId ? p.label : `${p.label} (${dimName(p.dim)})`;
    const leg = res.legs[i];
    let ctl = '';
    if (i < last && leg.type === 'jump') ctl = `<span class="jump">portal jump ${PORTAL_JUMP_SECONDS} s</span>`;
    else if (i < last) {
      ctl = `<span class="ctl">
        <select class="btn select" data-ov="transport" data-key="${esc(p.key)}" aria-label="Transport from ${esc(name)}">${S.data.transports.map((t) => `<option value="${t.id}" ${t.id === leg.transport ? 'selected' : ''}>${esc(transportLabel(t))}</option>`).join('')}</select>
        <select class="btn select" data-ov="terrain" data-key="${esc(p.key)}" aria-label="Terrain from ${esc(name)}">${S.data.terrains.map((t) => `<option value="${t.id}" ${t.id === leg.terrain ? 'selected' : ''}>${t.mult}x</option>`).join('')}</select></span>`;
    }
    const isStop = p.kind === 'stop';
    return `<div class="rrow" data-index="${i}" ${isStop ? `data-stop="${p.stopUid}"` : ''} ${p.dotId ? `data-hover-dot="${p.dotId}"` : `data-hover-xyz="${esc(name)}"`}>
      <span class="handle" ${isStop ? 'draggable="true" title="Drag to reorder"' : ''}>${isStop ? '⋮' : ''}</span>
      <span class="who">${label}${isStop ? ` <button class="btn remove" type="button" data-remove="${p.stopUid}" aria-label="Remove this point">X</button>` : ''}<span class="sub" style="color:${dimColor(p.dim)}">${esc(name)}</span></span>
      ${ctl}</div>`;
  }).join('');
}

$('calc-btn').addEventListener('click', () => calcRoute());
for (const id of ['start-input', 'dest-input']) {
  $(id).addEventListener('change', () => { if ($('start-input').value.trim() && $('dest-input').value.trim()) calcRoute({ fresh: true }); });
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); calcRoute(); } });
}
$('portal-btn').addEventListener('click', () => {
  const R = S.route;
  R.portal = !R.portal;
  $('portal-btn').textContent = `Portal travel: ${R.portal ? 'ON' : 'OFF'}`;
  $('portal-btn').setAttribute('aria-pressed', String(R.portal));
  $('portal-btn').classList.toggle('blue', R.portal);
  $('portal-btn').classList.toggle('off-state', !R.portal);
  if (R.shown && R.lastStart !== null) calcRoute();
});
$('transport-select').addEventListener('change', (e) => { S.route.transport = e.target.value; if (S.route.shown && S.route.lastStart !== null) calcRoute(); });
$('terrain-select').addEventListener('change', (e) => { S.route.terrain = e.target.value; if (S.route.shown && S.route.lastStart !== null) calcRoute(); });

const rowsEl = $('router-rows');
rowsEl.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-ov]');
  if (!sel) return;
  const key = sel.dataset.key;
  S.route.overrides[key] = { ...(S.route.overrides[key] || {}), [sel.dataset.ov]: sel.value };
  calcRoute();
});
rowsEl.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (!rm) return;
  S.route.stops = S.route.stops.filter((s) => s.uid !== rm.dataset.remove);
  calcRoute();
});
rowsEl.addEventListener('mouseover', (e) => {
  const row = e.target.closest('.rrow');
  if (!row) return;
  const r = $('router').getBoundingClientRect();
  if (row.dataset.hoverDot) {
    showHover(row.dataset.hoverDot, r.left - 300, row.getBoundingClientRect().top);
    placeBubble(r.left - 300, row.getBoundingClientRect().top, r.left - 10);
  } else if (row.dataset.hoverXyz) {
    hoverEl.innerHTML = `<div class="tip dot-card"><span class="coords">${esc(row.dataset.hoverXyz)}</span></div>`;
    hoverEl.dataset.id = '';
    hoverEl.hidden = false;
    placeBubble(r.left - 300, row.getBoundingClientRect().top, r.left - 10);
  }
});
rowsEl.addEventListener('mouseleave', hideHover);

// Drag a stopover to another position between start and destination.
let draggingStop = null;
rowsEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-stop]');
  if (!row) return;
  draggingStop = row.dataset.stop;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingStop);
});
rowsEl.addEventListener('dragover', (e) => {
  const row = e.target.closest('.rrow');
  if (!draggingStop || !row || Number(row.dataset.index) === 0) return;
  e.preventDefault();
  rowsEl.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  row.classList.add('drop-target');
});
rowsEl.addEventListener('drop', (e) => {
  const row = e.target.closest('.rrow');
  if (!draggingStop || !row) return;
  e.preventDefault();
  const targetIndex = Number(row.dataset.index);
  const before = [...rowsEl.querySelectorAll('[data-stop]')].filter((r) => Number(r.dataset.index) < targetIndex && r.dataset.stop !== draggingStop).length;
  const moving = S.route.stops.find((s) => s.uid === draggingStop);
  const rest = S.route.stops.filter((s) => s.uid !== draggingStop);
  rest.splice(before, 0, moving);
  S.route.stops = rest;
  draggingStop = null;
  calcRoute();
});
rowsEl.addEventListener('dragend', () => { draggingStop = null; rowsEl.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target')); });

$('add-point-btn').addEventListener('click', () => {
  if (rowsEl.querySelector('.new-point')) return rowsEl.querySelector('.new-point input').focus();
  const lastRow = rowsEl.lastElementChild;
  const row = document.createElement('div');
  row.className = 'rrow new-point';
  row.innerHTML = '<span class="handle"></span><input class="field" type="text" list="dot-names" placeholder="Dot name or 120, 64, -340 (Nether)" aria-label="New point" style="grid-column: span 2">';
  rowsEl.insertBefore(row, lastRow);
  const input = row.querySelector('input');
  input.focus();
  const commit = () => {
    const text = input.value.trim();
    if (!text) { row.remove(); return; }
    S.route.stops.push({ uid: uid('s'), text });
    calcRoute();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') row.remove(); });
  input.addEventListener('blur', () => { if (row.isConnected) commit(); });
});

// Saving routes (personal, kept in this browser).
$('route-star').addEventListener('click', async () => {
  const R = S.route;
  if (!R.result) return toast('Calculate a route first.');
  const name = await promptDialog('Save route', 'Name for this route', `${R.lastStart} to ${R.lastDest}`);
  if (!name) return;
  saved.update(S.worldId, (s) => s.routes.push({
    id: uid('route'), name, start: R.lastStart, dest: R.lastDest, stops: R.stops.map((x) => ({ ...x })),
    overrides: { ...R.overrides }, portal: R.portal, transport: R.transport, terrain: R.terrain,
  }));
  $('route-star').classList.add('saved');
  toast(`Route "${name}" saved.`);
});
function loadSavedRoute(id) {
  const r = saved.forWorld(S.worldId).routes.find((x) => x.id === id);
  if (!r) return;
  const R = S.route;
  $('start-input').value = r.start;
  $('dest-input').value = r.dest;
  Object.assign(R, { lastStart: r.start, lastDest: r.dest, stops: r.stops.map((x) => ({ ...x })), overrides: { ...r.overrides }, portal: r.portal, transport: r.transport, terrain: r.terrain });
  $('portal-btn').textContent = `Portal travel: ${R.portal ? 'ON' : 'OFF'}`;
  $('portal-btn').classList.toggle('blue', R.portal);
  $('portal-btn').classList.toggle('off-state', !R.portal);
  fillRouteSelects();
  calcRoute();
  closeLeft();
}
async function renameSavedRoute(id) {
  const r = saved.forWorld(S.worldId).routes.find((x) => x.id === id);
  if (!r) return;
  const name = await promptDialog('Rename route', 'New name', r.name);
  if (!name) return;
  saved.update(S.worldId, (s) => { const x = s.routes.find((y) => y.id === id); if (x) x.name = name; });
  openSaved('routes');
}
async function deleteSavedRoute(id) {
  const r = saved.forWorld(S.worldId).routes.find((x) => x.id === id);
  if (!r || !(await confirmDialog(`Delete the saved route "${r.name}"?`))) return;
  saved.update(S.worldId, (s) => { s.routes = s.routes.filter((y) => y.id !== id); });
  openSaved('routes');
}

// ---------- Compass ----------
function drawCompass(c, angle) {
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 16, 16);
  const poly = (pts, color) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); };
  poly([[5, 0], [11, 0], [16, 5], [16, 11], [11, 16], [5, 16], [0, 11], [0, 5]], '#3b3b3b');
  poly([[6, 2], [10, 2], [14, 6], [14, 10], [10, 14], [6, 14], [2, 10], [2, 6]], '#9a9a9a');
  const sx = Math.sin(angle), sy = -Math.cos(angle);
  for (let t = 5; t >= 1; t--) { ctx.fillStyle = '#f2f2f2'; ctx.fillRect(Math.round(8 - sx * t * 0.8 - 1), Math.round(8 - sy * t * 0.8 - 1), 2, 2); }
  for (let t = 5; t >= 1; t--) { ctx.fillStyle = '#d42a2a'; ctx.fillRect(Math.round(8 + sx * t - 1), Math.round(8 + sy * t - 1), 2, 2); }
  ctx.fillStyle = '#3b3b3b'; ctx.fillRect(7, 7, 2, 2);
}
function drawCompasses() {
  cam.prepare();
  drawCompass($('compass-north'), cam.screenAngle(0, -1));
  const d = S.selectedId ? dotById(S.selectedId) : null;
  const goal = d ? displayPos(d) : { x: 0, y: 0, z: 0 }; // nothing clicked yet: point at 0 0 0
  const dx = goal.x - cam.target.x, dz = goal.z - cam.target.z;
  drawCompass($('compass-dot'), Math.hypot(dx, dz) < 1e-6 ? 0 : cam.screenAngle(dx, dz));
  $('compass-dot-label').textContent = d ? `To: ${displayName(d)}` : 'To: 0 0 0';
}
$('compass-btn').addEventListener('click', () => {
  const p = $('compass-panel');
  p.hidden = !p.hidden;
  $('compass-btn').setAttribute('aria-expanded', String(!p.hidden));
  if (!p.hidden) drawCompasses();
});

// ---------- Dialogs and messages ----------
let toastTimer = null;
function toast(text, ms = 3800) {
  const t = $('toast');
  t.className = 'toast tip';
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function openModal(html, { onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="gui" role="dialog" aria-modal="true">${html}</div>`;
  $('modal-root').appendChild(back);
  keys.clear();
  hideHover();
  const close = () => { back.remove(); onClose && onClose(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) back.dataset.down = '1'; });
  back.addEventListener('click', (e) => { if (e.target === back && back.dataset.down) close(); back.dataset.down = ''; });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  setTimeout(() => back.querySelector('input, select, button.green, button')?.focus(), 0);
  return { root: back.firstElementChild, close };
}

function confirmDialog(text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(`<div class="head"><h2>Are you sure?</h2></div><p style="margin:0;line-height:1.4">${esc(text)}</p>
      <div class="foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn red" type="button" data-ok>${esc(okLabel)}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    m.root.querySelector('[data-ok]').addEventListener('click', () => { answered = true; resolve(true); m.close(); });
  });
}

function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal(`<div class="head"><h2>${esc(title)}</h2></div>
      <div class="row"><label for="prompt-input">${esc(label)}</label><input id="prompt-input" class="field" type="text" value="${esc(value)}"></div>
      <div class="foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn green" type="button" data-ok>Save</button></div>`,
    { onClose: () => { if (!answered) resolve(null); } });
    const input = m.root.querySelector('input');
    const ok = () => { const v = input.value.trim(); if (!v) return input.focus(); answered = true; resolve(v); m.close(); };
    m.root.querySelector('[data-ok]').addEventListener('click', ok);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    setTimeout(() => input.select(), 0);
  });
}

// ---------- Refresh everything after data changes ----------
function refreshAll() {
  if (!world()) S.worldId = S.data.worlds[0]?.id || null;
  renderWorldMenu();
  renderChecks();
  fillRouteSelects();
  $('dot-names').innerHTML = S.worldId ? worldDots().map((d) => `<option value="${esc(displayName(d))}"></option>`).join('') : '';
  if (S.selectedId && !dotById(S.selectedId)) { S.selectedId = null; if (S.leftKind === 'pinned') closeLeft(); }
  else if (S.selectedId && S.leftKind === 'pinned') showLeft('pinned', cardsFor(S.selectedId, true));
  if (S.leftKind === 'players') openPlayers();
  const note = $('empty-note');
  let text = '';
  if (!S.data.worlds.length) text = S.owner ? 'No world yet. Press + World at the bottom to create one.' : 'No world has been added yet.';
  else if (!worldDots().length) text = S.owner ? 'No dots in this world yet. Press + Dot at the bottom to add one.' : 'No dots in this world yet.';
  note.textContent = text;
  note.className = 'empty-note tip';
  note.hidden = !text;
  $('editor-wrap').hidden = !S.owner;
  $('owner-btn').textContent = S.owner ? 'Sign out' : 'Owner sign in';
  hideHover();
  updateStar();
  dirty = true;
}

// Everything the owner tools need.
export const app = {
  S, cam, dims, dimById, dimName, world, worldDots, dotById, partnerOf, displayName, faceImg, pictureImg,
  refreshAll, selectDot, closeLeft, goToDot, toast, openModal, confirmDialog, setWorld,
  saveData: (message) => saveData(S.data, message),
  editor: null,
};

// ---------- Start ----------
async function init() {
  const p = prefs.get();
  if (typeof p.dark === 'boolean') S.dark = p.dark;
  if (p.grid) S.grid = p.grid;
  if (p.view === '2d') { S.view = '2d'; cam.mode = '2d'; }
  applyTheme();
  renderer.resize();
  drawCompass($('compass-icon'), 0);
  try {
    S.data = await loadData();
  } catch (e) {
    const note = $('empty-note');
    note.className = 'empty-note tip';
    note.textContent = `Could not load the map data. ${e.message}`;
    note.hidden = false;
    return;
  }
  S.owner = Boolean(getToken());
  S.worldId = S.data.worlds.some((w) => w.id === p.worldId) ? p.worldId : S.data.worlds[0]?.id || null;
  if (!dimById('overworld') && dims()[0]) S.visibleDims = new Set([dims()[0].id]);
  app.editor = initEditor(app);
  window.oriamaps = { app, renderer }; // handy for checking things in the browser console
  refreshAll();
  requestAnimationFrame(tick);
}
init();
