// OriaMaps – route calculation.
// Every leg's time = blocks ÷ speed × terrain multiplier. Each portal jump adds 4 seconds.
// With portal travel on, every combination of saved, linked portals is tested
// (shortest-path search), so the result is never slower than walking straight.

import { dist3 } from './util.js';

export const PORTAL_JUMP_SECONDS = 4;

/**
 * @param waypoints  [{key, label, dim, x, y, z, kind}] – start, your stopovers, destination (in order)
 * @param portals    [{key, label, dim, x, y, z, partnerKey}] – linked portals of the current world
 * @param opts       {portalTravel, defaultTransport, defaultTerrain, overrides, transports, terrains}
 * @returns {points, legs, totalBlocks, totalSeconds} or {error}
 */
export function computeRoute(waypoints, portals, opts) {
  if (!waypoints || waypoints.length < 2) return { error: 'A route needs a starting point and a destination.' };
  const transports = new Map(opts.transports.map((t) => [t.id, t]));
  const terrains = new Map(opts.terrains.map((t) => [t.id, t]));
  const overrides = opts.overrides || {};
  const portalByKey = new Map(portals.map((p) => [p.key, p]));

  const speedOf = (key) => {
    const id = overrides[key]?.transport || opts.defaultTransport;
    return transports.get(id)?.speed || transports.get(opts.defaultTransport)?.speed || 4.317;
  };
  const multOf = (key) => {
    const id = overrides[key]?.terrain || opts.defaultTerrain;
    return terrains.get(id)?.mult || 1;
  };
  const walkSeconds = (fromKey, blocks) => (blocks / speedOf(fromKey)) * multOf(fromKey);

  const points = [{ ...waypoints[0] }];
  const legs = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const path = opts.portalTravel ? shortestPath(a, b, portals, portalByKey, walkSeconds) : directPath(a, b);
    if (path.error) return path;
    for (let k = 0; k < path.length - 1; k++) {
      const u = path[k], v = path[k + 1];
      const fromIndex = points.length - 1;
      if (u.dim !== v.dim) {
        legs.push({ type: 'jump', from: fromIndex, to: fromIndex + 1, blocks: 0, seconds: PORTAL_JUMP_SECONDS });
      } else {
        const blocks = dist3(u, v);
        legs.push({
          type: 'walk', from: fromIndex, to: fromIndex + 1, blocks,
          seconds: walkSeconds(u.key, blocks),
          transport: overrides[u.key]?.transport || opts.defaultTransport,
          terrain: overrides[u.key]?.terrain || opts.defaultTerrain,
          dim: u.dim,
        });
      }
      const isWaypoint = k + 1 === path.length - 1;
      points.push(isWaypoint ? { ...b } : { ...v, kind: 'portal' });
    }
  }

  const totalBlocks = legs.reduce((s, l) => s + l.blocks, 0);
  const totalSeconds = legs.reduce((s, l) => s + l.seconds, 0);
  return { points, legs, totalBlocks, totalSeconds };
}

function directPath(a, b) {
  if (a.dim !== b.dim) {
    return { error: `${a.label} and ${b.label} are in different dimensions. Turn on Portal travel to route between them.` };
  }
  return [a, b];
}

// Dijkstra over: a, b and every linked portal. Walking is only possible inside one dimension;
// a portal leads to its linked partner in the other dimension.
function shortestPath(a, b, portals, portalByKey, walkSeconds) {
  const nodes = [];
  const index = new Map();
  const add = (n) => {
    if (index.has(n.key)) return;
    index.set(n.key, nodes.length);
    const asPortal = portalByKey.get(n.key);
    nodes.push({ ...n, partnerKey: asPortal ? asPortal.partnerKey : null });
  };
  add(a); add(b);
  portals.forEach(add);

  const n = nodes.length;
  const best = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  const start = index.get(a.key), goal = index.get(b.key);
  best[start] = 0;

  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u === -1 || best[i] < best[u])) u = i;
    if (u === -1 || best[u] === Infinity) break;
    if (u === goal) break;
    done[u] = true;
    const U = nodes[u];
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const V = nodes[v];
      let cost = Infinity;
      if (U.dim === V.dim) cost = walkSeconds(U.key, dist3(U, V));
      else if (U.partnerKey && U.partnerKey === V.key) cost = PORTAL_JUMP_SECONDS;
      if (best[u] + cost < best[v]) { best[v] = best[u] + cost; prev[v] = u; }
    }
  }

  if (best[goal] === Infinity) {
    return { error: `No route from ${a.label} to ${b.label}: no linked portals connect their dimensions.` };
  }
  const path = [];
  for (let v = goal; v !== -1; v = prev[v]) path.unshift(nodes[v]);
  return path;
}
