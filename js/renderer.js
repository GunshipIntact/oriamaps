// OriaMaps – draws the 3D / 2D map on a <canvas>. No external libraries.
// Coordinates follow Minecraft: X east (+) / west (-), Y height, Z south (+) / north (-).

import { rgba, shade, matte } from './util.js';

const FOV = (60 * Math.PI) / 180;
const TAN = Math.tan(FOV / 2);
const DOT_PX = 11; // dots keep this size on screen at every zoom
const LABEL_FONT = '15px Minecraft, "Pixelify Sans", monospace';
const TICK_FONT = '12px Minecraft, "Pixelify Sans", monospace';
const TYPE_FONT = '11px Minecraft, "Pixelify Sans", monospace';

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Camera {
  constructor() {
    this.target = { x: 0, y: 0, z: 0 };
    this.yaw = 0.65;          // turning around the Y axis
    this.pitch = 0.55;        // looking down (+) or up (-)
    this.viewSize = 256;      // blocks visible from top to bottom of the screen
    this.mode = '3d';         // '3d' or '2d' (top-down, north up)
    this.w = 1; this.h = 1;
  }

  get dist() { return this.viewSize / (2 * TAN); }

  position() {
    const d = this.dist, cp = Math.cos(this.pitch);
    return { x: this.target.x + d * cp * Math.sin(this.yaw), y: this.target.y + d * Math.sin(this.pitch), z: this.target.z + d * cp * Math.cos(this.yaw) };
  }

  static basisFor(yaw, pitch) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch), sy = Math.sin(yaw), cy = Math.cos(yaw);
    const F = { x: -cp * sy, y: -sp, z: -cp * cy };
    const R = { x: cy, y: 0, z: -sy };
    return { F, R, U: cross(R, F) };
  }

  prepare() {
    this.C = this.position();
    Object.assign(this, Camera.basisFor(this.yaw, this.pitch));
    this.f = this.h / 2 / TAN;
    this.k = this.h / this.viewSize;
    this.near = Math.max(0.02, this.dist * 0.002);
  }

  toCam(p) {
    const v = sub(p, this.C);
    return { x: dot(v, this.R), y: dot(v, this.U), z: dot(v, this.F) };
  }

  camToScreen(c) {
    return { x: this.w / 2 + (c.x / c.z) * this.f, y: this.h / 2 - (c.y / c.z) * this.f, d: c.z };
  }

  project(p) {
    if (this.mode === '2d') {
      return { x: this.w / 2 + (p.x - this.target.x) * this.k, y: this.h / 2 + (p.z - this.target.z) * this.k, d: 1 };
    }
    const c = this.toCam(p);
    if (c.z < this.near) return null;
    return this.camToScreen(c);
  }

  // Projects a line, cutting off the part behind the camera.
  segment(a, b) {
    if (this.mode === '2d') return [this.project(a), this.project(b)];
    let ca = this.toCam(a), cb = this.toCam(b);
    const n = this.near;
    if (ca.z < n && cb.z < n) return null;
    if (ca.z < n) { const t = (n - ca.z) / (cb.z - ca.z); ca = { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: n }; }
    else if (cb.z < n) { const t = (n - cb.z) / (ca.z - cb.z); cb = { x: cb.x + (ca.x - cb.x) * t, y: cb.y + (ca.y - cb.y) * t, z: n }; }
    return [this.camToScreen(ca), this.camToScreen(cb)];
  }

  ray(sx, sy) {
    const a = (sx - this.w / 2) / this.f, b = -(sy - this.h / 2) / this.f;
    return { o: this.C, d: norm(add(add(this.F, mul(this.R, a)), mul(this.U, b))) };
  }

  pickPlane(sx, sy, planeY = 0) {
    if (this.mode === '2d') {
      return { x: this.target.x + (sx - this.w / 2) / this.k, y: planeY, z: this.target.z + (sy - this.h / 2) / this.k };
    }
    const r = this.ray(sx, sy);
    if (Math.abs(r.d.y) < 1e-6) return null;
    const t = (planeY - r.o.y) / r.d.y;
    if (t <= 0) return null;
    return add(r.o, mul(r.d, t));
  }

  // The point under the mouse: on the Y = 0 floor if it is close enough, otherwise at the current focus distance.
  pickFocus(sx, sy) {
    this.prepare();
    if (this.mode === '2d') return this.pickPlane(sx, sy, this.target.y);
    const hit = this.pickPlane(sx, sy, 0);
    if (hit && Math.hypot(hit.x - this.C.x, hit.y - this.C.y, hit.z - this.C.z) < this.dist * 4) return hit;
    const r = this.ray(sx, sy);
    return add(r.o, mul(r.d, this.dist));
  }

  // Click + drag: the whole view turns around the grabbed point P, like moving on a sphere around it.
  // Dragging down makes the view look up.
  orbitAround(P, dx, dy) {
    const dyaw = -dx * 0.006;
    const newPitch = clamp(this.pitch - dy * 0.006, -1.55, 1.55);
    const dp = newPitch - this.pitch;
    // turn around the vertical axis through P
    this.target = add(P, rotateY(sub(this.target, P), dyaw));
    this.yaw += dyaw;
    // tilt around the camera's horizontal right axis through P
    const k = { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
    this.target = add(P, rotateAxis(sub(this.target, P), k, -dp));
    this.pitch = newPitch;
  }

  pan2d(dx, dy) {
    this.target.x -= dx / this.k;
    this.target.z -= dy / this.k;
  }

  zoomAt(sx, sy, factor) {
    const newSize = clamp(this.viewSize * factor, 2, 4e6);
    factor = newSize / this.viewSize;
    const P = this.pickFocus(sx, sy);
    this.target = add(P, mul(sub(this.target, P), factor));
    if (this.mode === '2d') this.target.y = P.y;
    this.viewSize = newSize;
  }

  // WASD + Space / Shift. Movement follows the way the camera faces (horizontally).
  move(forward, right, up, dt) {
    const speed = this.viewSize * 0.7 * dt;
    const yaw = this.mode === '2d' ? 0 : this.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    this.target.x += (fx * forward + rx * right) * speed;
    this.target.z += (fz * forward + rz * right) * speed;
    this.target.y += up * speed;
  }

  // Screen angle (clockwise from straight up) of a horizontal direction in the world.
  screenAngle(dx, dz) {
    const yaw = this.mode === '2d' ? 0 : this.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
  }
}

// ---------- Dot shapes (unit size, Y up) ----------

function quad(a, b, c, d) { return { v: [a, b, c, d] }; }

function buildMeshes() {
  const m = {};
  { // Dungeon: cube
    const s = 0.72, v = [];
    for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) v.push({ x, y, z });
    m.dungeon = { v, f: [quad(0, 1, 3, 2), quad(4, 5, 7, 6), quad(0, 1, 5, 4), quad(2, 3, 7, 6), quad(0, 2, 6, 4), quad(1, 3, 7, 5)] };
  }
  { // Farm: pyramid
    const s = 0.85, b = -0.7;
    const v = [{ x: -s, y: b, z: -s }, { x: s, y: b, z: -s }, { x: s, y: b, z: s }, { x: -s, y: b, z: s }, { x: 0, y: 0.95, z: 0 }];
    m.farm = { v, f: [quad(0, 1, 2, 3), { v: [0, 1, 4] }, { v: [1, 2, 4] }, { v: [2, 3, 4] }, { v: [3, 0, 4] }] };
  }
  { // Misc: hourglass made of two pyramids touching at their tips
    const s = 0.7, h = 1.0;
    const v = [
      { x: -s, y: h, z: -s }, { x: s, y: h, z: -s }, { x: s, y: h, z: s }, { x: -s, y: h, z: s },
      { x: -s, y: -h, z: -s }, { x: s, y: -h, z: -s }, { x: s, y: -h, z: s }, { x: -s, y: -h, z: s },
      { x: 0, y: 0, z: 0 },
    ];
    const top = { x: 0, y: 0.6, z: 0 }, bottom = { x: 0, y: -0.6, z: 0 };
    m.misc = { v, f: [
      { v: [0, 1, 2, 3], c: top }, { v: [0, 1, 8], c: top }, { v: [1, 2, 8], c: top }, { v: [2, 3, 8], c: top }, { v: [3, 0, 8], c: top },
      { v: [4, 5, 6, 7], c: bottom }, { v: [4, 5, 8], c: bottom }, { v: [5, 6, 8], c: bottom }, { v: [6, 7, 8], c: bottom }, { v: [7, 4, 8], c: bottom },
    ] };
  }
  { // Landmark: 3D star (a thick five-pointed star)
    const v = [], t = 0.24;
    for (const z of [t, -t]) for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 1.15 : 0.48, a = -Math.PI / 2 + (i * Math.PI) / 5;
      v.push({ x: r * Math.cos(a), y: -r * Math.sin(a), z });
    }
    const f = [{ v: [...Array(10).keys()] }, { v: [...Array(10).keys()].map((i) => i + 10) }];
    for (let i = 0; i < 10; i++) f.push(quad(i, (i + 1) % 10, ((i + 1) % 10) + 10, i + 10));
    m.landmark = { v, f, facing: true };
  }
  { // Portal: upright oval disc
    const v = [], seg = 16, t = 0.2;
    for (const z of [t, -t]) for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      v.push({ x: 0.62 * Math.cos(a), y: 1.15 * Math.sin(a), z });
    }
    const inner = v.length;
    for (const z of [t + 0.01, -t - 0.01]) for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      v.push({ x: 0.36 * Math.cos(a), y: 0.82 * Math.sin(a), z });
    }
    const idx = (o) => [...Array(seg).keys()].map((i) => i + o);
    const f = [{ v: idx(0) }, { v: idx(seg) }];
    for (let i = 0; i < seg; i++) f.push(quad(i, (i + 1) % seg, ((i + 1) % seg) + seg, i + seg));
    f.push({ v: idx(inner), glow: true }, { v: idx(inner + seg), glow: true });
    m.portal = { v, f, facing: true };
  }
  for (const key of Object.keys(m)) {
    const mesh = m[key];
    for (const face of mesh.f) {
      const [a, b, c] = face.v.map((i) => mesh.v[i]);
      let n = norm(cross(sub(b, a), sub(c, a)));
      const centre = face.v.reduce((s, i) => add(s, mesh.v[i]), { x: 0, y: 0, z: 0 });
      const mid = mul(centre, 1 / face.v.length);
      if (dot(n, sub(mid, face.c || { x: 0, y: 0, z: 0 })) < 0) n = mul(n, -1);
      face.n = n;
    }
  }
  return m;
}

const MESHES = buildMeshes();

// Small picture of a dot shape, used next to the type toggles in the sidebar.
export function shapeIconURL(type, color = '#f2f2f2', px = 20) {
  const dpr = 2;
  const c = document.createElement('canvas');
  c.width = c.height = px * dpr;
  const r = Object.create(Renderer.prototype);
  r.ctx = c.getContext('2d');
  r.ctx.scale(dpr, dpr);
  r.cam = { mode: '2d', yaw: 0 };
  r.drawShape({ type, color }, { x: px / 2, y: px / 2 }, ICON_BASIS, false, { size: px * 0.36, exactColor: true, noGlow: true });
  return c.toDataURL();
}
const LIGHT = norm({ x: 0.35, y: 0.9, z: 0.45 });
const ICON_BASIS = Camera.basisFor(0.65, 0.5); // fixed angle used for dots in the 2D view

function rotateY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

// Rotates v around the unit axis k by angle a (Rodrigues' formula).
function rotateAxis(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// ---------- Renderer ----------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = new Camera();
    this.screenDots = [];
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    this.cam.w = r.width;
    this.cam.h = r.height;
  }

  /**
   * scene = { dark, gridMode: '3d'|'floor'|'off', gridColors: [hex], axisColor,
   *           dots: [{id, pos, color, type, label, unlinked, selected, hovered}],
   *           route: [[a, b], ...] in display coordinates }
   */
  draw(scene) {
    const { ctx, cam } = this;
    cam.prepare();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = ctx.createRadialGradient(cam.w * 0.5, cam.h * 0.55, 0, cam.w * 0.5, cam.h * 0.55, Math.max(cam.w, cam.h) * 0.75);
    if (scene.dark) { g.addColorStop(0, '#14263a'); g.addColorStop(1, '#0a121c'); }
    else { g.addColorStop(0, '#f6f8fa'); g.addColorStop(1, '#d9e2e8'); }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cam.w, cam.h);

    this.drawGrid(scene);
    this.drawAxes(scene);
    this.drawRoute(scene);
    this.drawDots(scene);
  }

  line(a, b) {
    const s = this.cam.segment(a, b);
    if (!s) return false;
    this.ctx.moveTo(s[0].x, s[0].y);
    this.ctx.lineTo(s[1].x, s[1].y);
    return true;
  }

  gridStep() {
    return Math.max(1, 16 * Math.pow(2, Math.round(Math.log2(this.cam.viewSize / 256))));
  }

  drawGrid(scene) {
    if (scene.gridMode === 'off') return;
    const { ctx, cam } = this;
    const step = this.gridStep();
    const colors = scene.gridColors && scene.gridColors.length > 1 ? scene.gridColors.map((c) => (scene.dark ? c : matte(c))) : null;
    const neutral = scene.dark ? '#8fb3c9' : '#4f6676';
    const lattice = scene.gridMode === '3d' && cam.mode === '3d';
    let N = lattice ? 6 : 24; // how many grid squares reach out from the centre
    if (cam.mode === '2d') N = Math.ceil((cam.viewSize * (cam.w / cam.h)) / step / 2) + 2;
    const cx = Math.round(cam.target.x / step) * step;
    const cz = Math.round(cam.target.z / step) * step;
    const cy = Math.round(cam.target.y / step) * step;
    const levels = lattice ? [...Array(2 * N + 1).keys()].map((j) => cy + (j - N) * step) : [0];
    const base = colors ? 0.75 : scene.dark ? 0.32 : 0.4;
    ctx.lineWidth = 1;
    const stroke = (k, alpha, draw) => {
      ctx.beginPath();
      draw();
      const c = colors ? colors[((k % colors.length) + colors.length) % colors.length] : neutral;
      ctx.strokeStyle = rgba(c, alpha);
      ctx.stroke();
    };
    const fade = (k) => (cam.mode === '2d' ? 1 : 1 - Math.abs(k) / (N + 1));
    for (const y of levels) {
      const ly = lattice ? (y - cy) / step : 0;
      const levelFade = lattice ? 1 - Math.abs(ly) / (N + 1) : 1;
      for (let k = -N; k <= N; k++) {
        const z = cz + k * step, x = cx + k * step;
        const ia = Math.round(z / step), ib = Math.round(x / step);
        stroke(ia, base * fade(k) * levelFade, () => this.line({ x: cx - N * step, y, z }, { x: cx + N * step, y, z }));
        stroke(ib, base * fade(k) * levelFade, () => this.line({ x, y, z: cz - N * step }, { x, y, z: cz + N * step }));
      }
    }
    if (lattice) {
      for (let i = -N; i <= N; i++) for (let k = -N; k <= N; k++) {
        const x = cx + i * step, z = cz + k * step;
        stroke(Math.round(x / step), base * 0.6 * fade(Math.max(Math.abs(i), Math.abs(k))), () => this.line({ x, y: cy - N * step, z }, { x, y: cy + N * step, z }));
      }
    }
  }

  drawAxes(scene) {
    const { ctx, cam } = this;
    const col = scene.dark ? scene.axisColor : matte(scene.axisColor);
    const O = { x: 0, y: 0, z: 0 };
    const dirs = [
      { v: { x: 1, y: 0, z: 0 }, label: '+X East' },
      { v: { x: -1, y: 0, z: 0 }, label: '-X West' },
      { v: { x: 0, y: 0, z: -1 }, label: '-Z North' },
      { v: { x: 0, y: 0, z: 1 }, label: '+Z South' },
    ];
    if (cam.mode === '3d') dirs.push({ v: { x: 0, y: 1, z: 0 }, label: '+Y Up' }, { v: { x: 0, y: -1, z: 0 }, label: '-Y' });
    // Each arrow reaches to just inside the screen edge where its axis leaves the screen. This also works when
    // 0 0 0 itself is off screen: the visible stretch of each axis is found first, then its far end becomes the tip.
    const axes = dirs.map(({ v, label }) => {
      const r = this.axisRange(v);
      return r ? { to: mul(v, r.t2), label, v, L: r.t2, t1: r.t1 } : null;
    }).filter((a) => a && a.L - a.t1 > cam.viewSize * 0.02);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    if (scene.dark) { ctx.shadowColor = col; ctx.shadowBlur = 6; }
    ctx.font = LABEL_FONT;
    for (const a of axes) {
      const s = cam.segment(O, a.to);
      if (!s) continue;
      const [p, q] = s;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      const tipVisible = cam.mode === '2d' || cam.toCam(a.to).z >= cam.near;
      if (!tipVisible) continue;
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - 13 * Math.cos(ang - 0.42), q.y - 13 * Math.sin(ang - 0.42));
      ctx.lineTo(q.x - 13 * Math.cos(ang + 0.42), q.y - 13 * Math.sin(ang + 0.42));
      ctx.closePath(); ctx.fill();
      const lx = q.x + Math.cos(ang) * 14, ly = q.y + Math.sin(ang) * 14 + 5;
      ctx.textAlign = Math.cos(ang) > 0.3 ? 'left' : Math.cos(ang) < -0.3 ? 'right' : 'center';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 4; ctx.strokeStyle = scene.dark ? '#000' : '#fff';
      ctx.strokeText(a.label, lx, ly);
      ctx.fillText(a.label, lx, ly);
      ctx.lineWidth = 3; ctx.strokeStyle = col;
      if (scene.dark) ctx.shadowBlur = 6;
    }
    ctx.restore();
    this.drawTicks(axes, col, scene.dark);
    const o = cam.project(O);
    if (o) {
      ctx.fillStyle = scene.dark ? '#fff' : '#222';
      ctx.fillRect(o.x - 3, o.y - 3, 6, 6);
    }
  }

  // Finds which stretch [t1, t2] of the axis ray (from 0 0 0 along v) is on screen, inside a small margin.
  axisRange(v) {
    const cam = this.cam;
    const margin = 60;
    const inside = (t) => {
      const p = cam.project(mul(v, t));
      return Boolean(p) && p.x > margin && p.x < cam.w - margin && p.y > margin && p.y < cam.h - margin;
    };
    const ts = [0];
    for (let k = -40; k <= 6; k++) ts.push(cam.viewSize * Math.pow(2, k / 2)); // up to 8 × the view size
    let i1 = -1, i2 = -1;
    ts.forEach((t, i) => { if (inside(t)) { if (i1 < 0) i1 = i; i2 = i; } });
    if (i1 < 0) return null;
    const edge = (inT, outT) => { // binary search for where the axis crosses the screen edge
      for (let i = 0; i < 30; i++) { const mid = (inT + outT) / 2; if (inside(mid)) inT = mid; else outT = mid; }
      return inT;
    };
    const t2 = i2 === ts.length - 1 ? ts[i2] : edge(ts[i2], ts[i2 + 1]);
    const t1 = i1 === 0 ? 0 : edge(ts[i1], ts[i1 - 1]);
    return { t1, t2 };
  }

  // Numbers along each axis, so you can read the scale. Spacing grows with zoom so labels never crowd.
  tickStep(v, t1, L) {
    const cam = this.cam;
    let step = this.gridStep();
    const at = (d) => cam.project(mul(v, d));
    const mid = (t1 + L) / 2; // measured in the middle of the visible stretch
    for (let i = 0; i < 40; i++) {
      const a = at(mid), b = at(mid + step);
      if (a && b && Math.hypot(b.x - a.x, b.y - a.y) >= 64) return step;
      step *= 2;
    }
    return step;
  }

  drawTicks(axes, col, dark) {
    const { ctx, cam } = this;
    ctx.save();
    ctx.font = TICK_FONT;
    ctx.textAlign = 'center';
    ctx.lineWidth = 2;
    for (const a of axes) {
      const s = cam.segment({ x: 0, y: 0, z: 0 }, a.to);
      if (!s) continue;
      const len = Math.hypot(s[1].x - s[0].x, s[1].y - s[0].y) || 1;
      const ux = (s[1].x - s[0].x) / len, uy = (s[1].y - s[0].y) / len;
      let px = -uy, py = ux;
      if (py < 0 || (Math.abs(py) < 0.2 && px < 0)) { px = -px; py = -py; } // labels below / right of the axis
      const step = this.tickStep(a.v, a.t1, a.L);
      const sign = a.v.x + a.v.y + a.v.z;
      let count = 0, last = { x: -1e9, y: -1e9 };
      const o = cam.project({ x: 0, y: 0, z: 0 });
      if (o) last = o;
      const first = Math.max(step, Math.ceil(a.t1 / step) * step);
      for (let d = first; d < a.L - (a.L - a.t1) * 0.06 && count < 400; d += step, count++) {
        const p = cam.project(mul(a.v, d));
        if (!p) continue;
        // Far away the perspective squeezes the ticks together: skip any that would crowd the previous one.
        if (Math.hypot(p.x - last.x, p.y - last.y) < 48) continue;
        last = p;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(p.x - px * 5, p.y - py * 5);
        ctx.lineTo(p.x + px * 5, p.y + py * 5);
        ctx.stroke();
        const text = String(sign * d);
        const lx = p.x + px * 16, ly = p.y + py * 16 + 4;
        ctx.lineWidth = 3;
        ctx.strokeStyle = dark ? '#000' : '#fff';
        ctx.strokeText(text, lx, ly);
        ctx.fillStyle = col;
        ctx.fillText(text, lx, ly);
        ctx.lineWidth = 2;
      }
    }
    ctx.restore();
  }

  // How much of the world is visible: width and height in blocks at the centre of the screen.
  visibleSize() {
    const h = this.cam.viewSize;
    return { w: h * (this.cam.w / this.cam.h), h, grid: this.gridStep() };
  }

  drawRoute(scene) {
    if (!scene.route || !scene.route.length) return;
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (const [a, b] of scene.route) this.line(a, b);
    ctx.strokeStyle = scene.dark ? '#000' : '#333';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.setLineDash([10, 6]);
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }

  drawDots(scene) {
    const { ctx, cam } = this;
    const list = [];
    for (const d of scene.dots) {
      const p = cam.project(d.pos);
      if (!p || p.x < -40 || p.y < -40 || p.x > cam.w + 40 || p.y > cam.h + 40) continue;
      list.push({ d, p });
    }
    list.sort((a, b) => b.p.d - a.p.d);

    // Dashed line from each dot down (or up) to the Y = 0 floor, to show its height.
    if (cam.mode === '3d') {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      for (const { d } of list) {
        if (Math.abs(d.pos.y) < 0.5) continue;
        ctx.beginPath();
        if (this.line(d.pos, { x: d.pos.x, y: 0, z: d.pos.z })) {
          ctx.strokeStyle = rgba(scene.dark ? d.color : matte(d.color), 0.4);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    const basis = cam.mode === '3d' ? { R: cam.R, U: cam.U, F: cam.F } : ICON_BASIS;
    for (const { d, p } of list) this.drawShape(d, p, basis, scene.dark);

    this.screenDots = list.map(({ d, p }) => ({ id: d.id, x: p.x, y: p.y, d: p.d }));

    // Name tags: nearest first; tags that would overlap are hidden (except selected / hovered).
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    const placed = [];
    const order = [...list].sort((a, b) => (b.d.selected || b.d.hovered) - (a.d.selected || a.d.hovered) || a.p.d - b.p.d);
    for (const { d, p } of order) {
      // Name in normal size, the dot type after it in smaller letters, e.g. "Lush cave (Biomes)".
      ctx.font = LABEL_FONT;
      const nameW = ctx.measureText(d.label).width;
      const typeText = d.typeLabel ? ` (${d.typeLabel})` : '';
      ctx.font = TYPE_FONT;
      const typeW = typeText ? ctx.measureText(typeText).width : 0;
      const w = nameW + typeW + 8;
      const rect = { x: p.x - w / 2, y: p.y - DOT_PX * 1.6 - 20, w, h: 18 };
      const must = d.selected || d.hovered;
      if (!must && placed.some((r) => r.x < rect.x + rect.w && rect.x < r.x + r.w && r.y < rect.y + rect.h && rect.y < r.y + r.h)) continue;
      placed.push(rect);
      ctx.fillStyle = scene.dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.75)';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      const textColor = d.selected ? (scene.dark ? '#ffd84a' : '#8a6a00') : scene.dark ? '#ffffff' : '#1d1d1d';
      ctx.textAlign = 'left';
      ctx.font = LABEL_FONT;
      ctx.fillStyle = textColor;
      ctx.fillText(d.label, rect.x + 4, rect.y + 14);
      if (typeText) {
        ctx.font = TYPE_FONT;
        ctx.fillStyle = scene.dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.6)';
        ctx.fillText(typeText, rect.x + 4 + nameW, rect.y + 14);
      }
      ctx.textAlign = 'center';
      ctx.font = LABEL_FONT;
      // Warning marks above the name: red = unlinked portal, yellow = height (Y) unknown.
      const marks = [];
      if (d.unlinked) marks.push(['#c62828', '#ffffff']);
      if (d.noY) marks.push(['#f2c200', '#2a1b00']);
      marks.forEach(([bg, fg], i) => {
        const cx = p.x + (i - (marks.length - 1) / 2) * 28;
        const bx = cx - 10, by = rect.y - 26;
        ctx.fillStyle = '#000'; ctx.fillRect(bx - 2, by - 2, 24, 26);
        ctx.fillStyle = bg; ctx.fillRect(bx, by, 20, 22);
        ctx.fillStyle = fg; ctx.fillText('!', cx, by + 17);
      });
    }

    // Corner brackets around the selected dot.
    const sel = list.find((x) => x.d.selected);
    if (sel) {
      const s = 20, { x, y } = sel.p;
      ctx.save();
      ctx.strokeStyle = scene.dark ? '#ffffff' : '#111111';
      ctx.lineWidth = 3;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * s, y + sy * s - sy * 7);
        ctx.lineTo(x + sx * s, y + sy * s);
        ctx.lineTo(x + sx * s - sx * 7, y + sy * s);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawShape(d, p, basis, dark, opts = {}) {
    const { ctx } = this;
    const SIZE = opts.size || DOT_PX;
    const base = opts.exactColor || dark ? d.color : matte(d.color);
    if (dark && !opts.noGlow) { // soft neon glow
      const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, DOT_PX * 2.2);
      g.addColorStop(0, rgba(base, 0.35)); g.addColorStop(1, rgba(base, 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - DOT_PX * 2.2, p.y - DOT_PX * 2.2, DOT_PX * 4.4, DOT_PX * 4.4);
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = dark ? '#000000' : 'rgba(0,0,0,0.65)';
    ctx.lineJoin = 'round';
    if (d.type === 'biome') {
      const g = ctx.createRadialGradient(p.x - 4, p.y - 4, 1, p.x, p.y, SIZE * 1.05);
      g.addColorStop(0, shade(base, 1.6)); g.addColorStop(1, shade(base, 0.6));
      ctx.beginPath(); ctx.arc(p.x, p.y, SIZE * 1.05, 0, Math.PI * 2);
      ctx.fillStyle = g; ctx.fill(); ctx.stroke();
      return;
    }
    const mesh = MESHES[d.type] || MESHES.misc;
    // Star and portal turn to face the camera (slightly angled so they still look 3D).
    const viewYaw = this.cam.mode === '3d' ? this.cam.yaw : 0.65;
    const facingYaw = mesh.facing ? viewYaw + 0.45 : 0.3;
    const { R, U, F } = basis;
    const pts = mesh.v.map((v) => {
      const r = rotateY(v, facingYaw);
      return { x: p.x + dot(r, R) * SIZE, y: p.y - dot(r, U) * SIZE, z: dot(r, F) };
    });
    const faces = mesh.f.map((f) => ({ f, depth: f.v.reduce((s, i) => s + pts[i].z, 0) / f.v.length + (f.glow ? -0.02 : 0) }));
    faces.sort((a, b) => b.depth - a.depth);
    for (const { f } of faces) {
      const n = rotateY(f.n, facingYaw);
      if (f.glow) {
        if (dot(n, F) > 0) continue; // inner glow only on the side facing the camera
        ctx.fillStyle = shade(base, 1.7);
      } else {
        const light = 0.55 + 0.5 * Math.max(0, dot(n, LIGHT));
        ctx.fillStyle = shade(base, light);
      }
      ctx.beginPath();
      f.v.forEach((i, k) => (k ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y)));
      ctx.closePath();
      ctx.fill();
      if (!f.glow) ctx.stroke();
    }
  }

  pick(sx, sy, radius = 16) {
    let best = null, bestD = radius;
    for (const s of this.screenDots) {
      const dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < bestD || (best && Math.abs(dd - bestD) < 2 && s.d < best.d)) { best = s; bestD = Math.min(dd, bestD); }
    }
    return best ? best.id : null;
  }
}
