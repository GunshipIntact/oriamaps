// OriaMaps – owner tools. Only shown after the owner signs in with their GitHub key.
// Every change is written straight into the repository, so all visitors see it about a minute later.

import { getToken, setToken, clearToken, verifyToken, writeFile, blobToBase64, shrinkPicture, REPO } from './github.js';
import { loadData } from './store.js';
import { DOT_TYPES, escapeHtml as esc, slugify, uid, parseDotCoordinates } from './util.js';

export function initEditor(app) {
  const { S } = app;
  const $ = (id) => document.getElementById(id);

  // ---------- Saving ----------
  function setStatus(text, failed = false) {
    const el = $('editor-status');
    el.innerHTML = esc(text) + (failed ? ' <button class="btn small red" type="button" id="retry-save">Retry save</button>' : '');
    if (failed) $('retry-save').addEventListener('click', () => save('Retry saving map data'));
  }
  async function save(message) {
    setStatus('Saving…');
    try {
      await app.saveData(message);
      setStatus('All changes saved');
      app.toast('Saved. Everyone sees the change within about a minute.');
      return true;
    } catch (e) {
      setStatus('Not saved yet', true);
      app.toast(`Could not save to GitHub: ${e.message}. Your change is still on this page; press Retry save.`, 8000);
      return false;
    }
  }
  async function uploadPicture(file, baseName) {
    const blob = await shrinkPicture(file);
    const path = `pictures/${slugify(baseName)}-${Date.now().toString(36)}.jpg`;
    await writeFile(path, await blobToBase64(blob), `Add picture ${path}`);
    S.pictureCache.set(path, URL.createObjectURL(blob)); // shows at once, before GitHub Pages updates
    return path;
  }

  // ---------- Sign in / out ----------
  $('owner-btn').addEventListener('click', () => (S.owner ? signOut() : signIn()));

  function signIn() {
    const m = app.openModal(`<div class="head"><h2>Owner sign in</h2><button class="btn close-btn" type="button" data-close aria-label="Close">X</button></div>
      <p class="hint" style="margin:0">Only the owner can change the map. Paste your GitHub key (a fine-grained personal access token with <b>Contents: Read and write</b> for the <code>${esc(REPO.repo)}</code> repository). It stays only in this browser.</p>
      <div class="row"><label for="token-input">GitHub key</label><input id="token-input" class="field" type="password" autocomplete="off" placeholder="github_pat_…"></div>
      <div class="err" hidden></div>
      <div class="foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn green" type="button" data-ok>Sign in</button></div>`);
    const input = m.root.querySelector('#token-input');
    const err = m.root.querySelector('.err');
    const go = async () => {
      const token = input.value.trim();
      if (!token) return input.focus();
      err.hidden = true;
      m.root.querySelector('[data-ok]').disabled = true;
      try {
        if (!(await verifyToken(token))) throw new Error(`This key can't change the ${REPO.repo} repository. Check that "Contents" is set to "Read and write".`);
        setToken(token);
        S.owner = true;
        S.data = await loadData();
        m.close();
        app.refreshAll();
        app.toast('Signed in as owner. The editing tools are at the bottom of the screen.');
      } catch (e) {
        err.textContent = e.status === 401 ? 'GitHub did not accept this key. Copy it again, or make a new one.' : e.message;
        err.hidden = false;
        m.root.querySelector('[data-ok]').disabled = false;
      }
    };
    m.root.querySelector('[data-ok]').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  async function signOut() {
    if (!(await app.confirmDialog('Sign out of owner mode in this browser? You can sign in again with your GitHub key.', 'Sign out'))) return;
    clearToken();
    S.owner = false;
    app.refreshAll();
  }

  // A stored key that GitHub no longer accepts is removed.
  if (S.owner) {
    verifyToken(getToken()).then((ok) => {
      if (!ok) throw Object.assign(new Error('no push'), { status: 403 });
    }).catch((e) => {
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        clearToken(); S.owner = false; app.refreshAll();
        app.toast('Your owner key no longer works. Sign in again with a new GitHub key.', 7000);
      }
    });
  }

  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    if (!S.owner) return;
    ({ dot: () => editDot(null), world: openWorlds, dimension: openDimensions, players: openPlayers, transport: openTransports })[b.dataset.edit]();
  }));

  // ---------- Dots ----------
  function choiceButtons(items, selected, attr, disabled = () => false) {
    return items.map((it) => `<button class="btn small ${it.id === selected ? 'on' : ''}" type="button" data-${attr}="${esc(it.id)}" ${disabled(it) ? 'disabled' : ''}>${it.icon ? `<img src="${esc(it.icon)}" alt="" width="16" height="16" class="pixel">` : ''}${esc(it.name)}</button>`).join('');
  }
  const limitsText = (dimId) => { const d = app.dimById(dimId); return d ? `${d.name}: Y must be between ${d.minY} and ${d.maxY}.` : ''; };

  function editDot(id) {
    if (!S.data.worlds.length) return app.toast('Create a world first with + World.');
    const dot = id ? app.dotById(id) : null;
    const partner = dot ? app.partnerOf(dot) : null;
    const st = {
      dim: dot ? dot.dim : [...S.visibleDims][0] || app.dims()[0].id,
      type: dot ? dot.type : 'landmark',
      mode: partner ? 'partner' : dot && dot.type === 'portal' ? 'unlinked' : 'new',
      pdim: partner ? partner.dim : null,
      file: null, pfile: null, removePic: false,
    };
    if (!st.pdim) st.pdim = app.dims().find((d) => d.id !== st.dim)?.id || null;
    const players = S.data.players.map((p) => p.name);
    if (dot && dot.finder && !players.includes(dot.finder)) players.push(dot.finder);

    const m = app.openModal(`<div class="head"><h2>${dot ? 'Edit dot' : 'Add dot'}</h2><button class="btn close-btn" type="button" data-close aria-label="Close">X</button></div>
      <div class="row"><label for="dot-name">Name</label><input id="dot-name" class="field" type="text" placeholder="e.g. Iron Farm" value="${esc(dot?.name || '')}"></div>
      <div class="row"><label for="dot-xyz">Coordinates</label><input id="dot-xyz" class="field" type="text" placeholder="e.g. 120, 64, -340" value="${dot ? `${dot.x}, ${dot.y}, ${dot.z}` : ''}"><span class="hint" id="dot-limits"></span></div>
      <div class="row"><span class="lbl">Dimension</span><div class="choices" id="dot-dims"></div></div>
      <div class="row"><span class="lbl">Type</span><div class="choices grid3" id="dot-types">${DOT_TYPES.map((t) => `<button class="btn small" type="button" data-type="${t.id}">${t.single}</button>`).join('')}</div></div>
      <div class="cols">
        <div class="row"><label for="dot-finder">Discovered by</label><select id="dot-finder" class="field"><option value="">Unknown</option>${players.map((n) => `<option ${dot?.finder === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><span class="hint">Picked from the Players list.</span></div>
        <div class="row"><span class="lbl">Location picture</span><div class="pic-row"><div class="slot" id="dot-pic">${dot ? app.pictureImg(dot) : ''}</div><label class="btn small" for="dot-file">Choose</label><input id="dot-file" type="file" accept="image/*" hidden></div>${dot?.picture ? '<button class="btn small" type="button" id="dot-nopic" style="align-self:flex-start">Remove picture</button>' : '<span class="hint">No picture? The dimension\'s block is shown instead.</span>'}</div>
      </div>
      <div id="portal-part"></div>
      <div class="err" hidden></div>
      <div class="foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn green" type="button" data-ok>${dot ? 'Save changes' : 'Create dot'}</button></div>`);
    const R = m.root;
    const q = (sel) => R.querySelector(sel);

    function renderTop() {
      q('#dot-dims').innerHTML = choiceButtons(app.dims(), st.dim, 'dim');
      R.querySelectorAll('#dot-types [data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === st.type));
      q('#dot-limits').textContent = limitsText(st.dim);
      renderPortal();
    }
    function renderPortal() {
      const box = q('#portal-part');
      if (st.type !== 'portal') { box.innerHTML = ''; return; }
      if (st.pdim === st.dim) st.pdim = app.dims().find((d) => d.id !== st.dim)?.id || null;
      const others = app.worldDots().filter((d) => d.type === 'portal' && !app.partnerOf(d) && d.id !== dot?.id && d.dim !== st.dim);
      const modes = [
        { id: partner ? 'partner' : 'new', name: partner ? 'Linked portal' : 'New partner portal' },
        ...(others.length ? [{ id: 'existing', name: 'Link to an existing portal' }] : []),
        { id: 'unlinked', name: 'Partner not known yet' },
      ];
      let inner = '';
      if (st.mode === 'new' || st.mode === 'partner') {
        inner = `<div class="row"><span class="lbl">Partner's dimension</span><div class="choices" id="dot-pdims">${choiceButtons(app.dims(), st.pdim, 'pdim', (d) => d.id === st.dim)}</div><span class="hint">Must be a different dimension from this portal. ${esc(limitsText(st.pdim))}</span></div>
          <div class="cols"><div class="row"><label for="dot-pxyz">Partner's coordinates</label><input id="dot-pxyz" class="field" type="text" placeholder="e.g. 15, 70, -42" value="${partner ? `${partner.x}, ${partner.y}, ${partner.z}` : esc(st.pxyz || '')}"></div>
          <div class="row"><span class="lbl">Partner's picture</span><div class="pic-row"><div class="slot" id="dot-ppic">${partner ? app.pictureImg(partner) : ''}</div><label class="btn small" for="dot-pfile">Choose</label><input id="dot-pfile" type="file" accept="image/*" hidden></div></div></div>
          <span class="hint">Name, finder and type are shared with the partner. It only gets its own coordinates and picture.</span>`;
      } else if (st.mode === 'existing') {
        inner = `<div class="row"><label for="dot-existing">Portal to link with</label><select id="dot-existing" class="field">${others.map((d) => `<option value="${d.id}">${esc(app.displayName(d))} · ${d.x}, ${d.y}, ${d.z}</option>`).join('')}</select><span class="hint">That portal takes over this name and finder.</span></div>`;
      } else {
        inner = '<span class="hint">Saved without a partner. It shows a red ! on the map and routes skip it until you link it.</span>';
      }
      box.innerHTML = `<div class="divider"></div><div class="row"><span class="lbl" style="font-size:17px">Linked portal</span><div class="choices" id="dot-modes">${modes.map((x) => `<button class="btn small ${x.id === st.mode ? 'on' : ''}" type="button" data-mode="${x.id}">${esc(x.name)}</button>`).join('')}</div></div>${inner}`;
      const pfile = q('#dot-pfile');
      if (pfile) pfile.addEventListener('change', () => { st.pfile = pfile.files[0] || null; if (st.pfile) q('#dot-ppic').innerHTML = `<img src="${URL.createObjectURL(st.pfile)}" alt="">`; });
      const pxyz = q('#dot-pxyz');
      if (pxyz) pxyz.addEventListener('input', () => { st.pxyz = pxyz.value; });
    }
    R.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dim],[data-type],[data-pdim],[data-mode]');
      if (!b || b.disabled) return;
      if (b.dataset.dim) st.dim = b.dataset.dim;
      if (b.dataset.type) { st.type = b.dataset.type; if (st.type === 'portal' && !partner && st.mode === 'partner') st.mode = 'new'; }
      if (b.dataset.pdim) st.pdim = b.dataset.pdim;
      if (b.dataset.mode) st.mode = b.dataset.mode;
      renderTop();
    });
    q('#dot-file').addEventListener('change', (e) => { st.file = e.target.files[0] || null; st.removePic = false; if (st.file) q('#dot-pic').innerHTML = `<img src="${URL.createObjectURL(st.file)}" alt="">`; });
    q('#dot-nopic')?.addEventListener('click', () => { st.removePic = true; st.file = null; q('#dot-pic').innerHTML = ''; });
    renderTop();

    const fail = (text) => { const err = q('.err'); err.textContent = text; err.hidden = false; return null; };
    const inLimits = (dimId, c) => { const d = app.dimById(dimId); return !d || (c.y >= d.minY && c.y <= d.maxY); };

    q('[data-ok]').addEventListener('click', async () => {
      q('.err').hidden = true;
      const name = q('#dot-name').value.trim();
      if (!name) return fail('Give the dot a name.');
      const c = parseDotCoordinates(q('#dot-xyz').value);
      if (!c) return fail('Write the coordinates as three whole numbers, e.g. 120, 64, -340.');
      if (!inLimits(st.dim, c)) return fail(limitsText(st.dim));
      const keepPartner = st.type === 'portal' && st.mode === 'partner' ? partner : null;
      const linkExisting = st.type === 'portal' && st.mode === 'existing' ? app.dotById(q('#dot-existing')?.value) : null;
      const ignore = new Set([dot?.id, keepPartner?.id, linkExisting?.id].filter(Boolean));
      if (app.worldDots().some((d) => !ignore.has(d.id) && d.name.toLowerCase() === name.toLowerCase())) return fail(`There is already a dot called "${name}" in this world. Every dot needs its own name.`);
      let pc = null;
      if (st.type === 'portal' && (st.mode === 'new' || st.mode === 'partner')) {
        if (!st.pdim || st.pdim === st.dim) return fail('Pick a different dimension for the partner portal.');
        pc = parseDotCoordinates(q('#dot-pxyz').value);
        if (!pc) return fail("Write the partner's coordinates as three whole numbers, e.g. 15, 70, -42.");
        if (!inLimits(st.pdim, pc)) return fail(limitsText(st.pdim));
      }
      if (st.type === 'portal' && st.mode === 'existing' && !linkExisting) return fail('Pick the portal to link with.');

      const okBtn = q('[data-ok]');
      okBtn.disabled = true; okBtn.textContent = 'Saving…';
      try {
        const finder = q('#dot-finder').value;
        const target = dot || { id: uid('dot'), world: S.worldId };
        let picture = st.removePic ? null : target.picture || null;
        if (st.file) picture = await uploadPicture(st.file, `${name}-${st.dim}`);
        Object.assign(target, { name, dim: st.dim, x: c.x, y: c.y, z: c.z, type: st.type, finder, picture });
        if (!dot) S.data.dots.push(target);

        // Old partner that is no longer wanted becomes an unlinked portal.
        const oldPartner = partner;
        const unlinkOld = () => { if (oldPartner && oldPartner !== keepPartner && oldPartner !== linkExisting) oldPartner.link = null; };
        if (st.type !== 'portal') { unlinkOld(); target.link = null; }
        else if (st.mode === 'unlinked') { unlinkOld(); target.link = null; }
        else if (st.mode === 'existing') { unlinkOld(); Object.assign(linkExisting, { name, finder, link: target.id }); target.link = linkExisting.id; }
        else {
          const p = keepPartner || { id: uid('dot'), world: target.world, picture: null };
          let ppic = p.picture;
          if (st.pfile) ppic = await uploadPicture(st.pfile, `${name}-${st.pdim}`);
          Object.assign(p, { name, dim: st.pdim, x: pc.x, y: pc.y, z: pc.z, type: 'portal', finder, picture: ppic, link: target.id });
          if (!keepPartner) { unlinkOld(); S.data.dots.push(p); }
          target.link = p.id;
        }
        m.close();
        app.refreshAll();
        app.goToDot(target.id);
        await save(`${dot ? 'Edit' : 'Add'} dot ${name}`);
      } catch (e) {
        okBtn.disabled = false; okBtn.textContent = dot ? 'Save changes' : 'Create dot';
        fail(`Could not upload the picture: ${e.message}`);
      }
    });
  }

  async function deleteDot(id) {
    const d = app.dotById(id);
    if (!d) return;
    const p = app.partnerOf(d);
    const extra = p ? ` Its linked portal ${app.displayName(p)} stays and becomes unlinked.` : '';
    if (!(await app.confirmDialog(`Delete "${app.displayName(d)}"? This cannot be undone.${extra}`))) return;
    S.data.dots = S.data.dots.filter((x) => x.id !== id);
    if (p) p.link = null;
    if (S.selectedId === id) { S.selectedId = p ? p.id : null; app.closeLeft(); if (p) app.selectDot(p.id); }
    app.refreshAll();
    await save(`Delete dot ${d.name}`);
  }

  // ---------- Generic list window (worlds, dimensions, players, transport) ----------
  function listWindow({ title, intro, render, onClick, onSubmit }) {
    const m = app.openModal(`<div class="head"><h2>${esc(title)}</h2><button class="btn close-btn" type="button" data-close aria-label="Close">X</button></div>
      ${intro ? `<p class="hint" style="margin:0">${intro}</p>` : ''}<div class="win-body"></div><div class="err" hidden></div>`);
    const body = m.root.querySelector('.win-body');
    const err = m.root.querySelector('.err');
    const ctx = {
      root: m.root, close: m.close,
      fail: (t) => { err.textContent = t; err.hidden = false; return false; },
      clear: () => { err.hidden = true; },
      rerender: () => { body.innerHTML = render(ctx); },
      editing: null,
    };
    m.root.addEventListener('click', (e) => onClick && onClick(e, ctx));
    m.root.addEventListener('submit', (e) => { e.preventDefault(); ctx.clear(); onSubmit(new FormData(e.target), ctx); });
    ctx.rerender();
    return ctx;
  }

  // ---------- Worlds ----------
  function openWorlds() {
    listWindow({
      title: 'Worlds',
      intro: 'A world is one Minecraft seed. Every world has its own dots.',
      render: (c) => {
        const w = c.editing ? S.data.worlds.find((x) => x.id === c.editing) : null;
        return `<table><tr><th>Name</th><th>Seed</th><th>Dots</th><th></th></tr>${S.data.worlds.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.seed || '-')}</td><td>${S.data.dots.filter((d) => d.world === x.id).length}</td>
          <td class="acts"><button class="btn small" type="button" data-wedit="${x.id}">Edit</button> <button class="btn small red" type="button" data-wdel="${x.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="hint">No worlds yet.</td></tr>'}</table>
          <form class="row" style="gap:8px"><span class="lbl" style="font-size:17px">${w ? `Edit ${esc(w.name)}` : 'Add a world'}</span>
          <div class="cols"><div class="row"><label for="w-name">Name</label><input id="w-name" name="name" class="field" placeholder="e.g. Oria Survival" value="${esc(w?.name || '')}"></div>
          <div class="row"><label for="w-seed">Seed (optional)</label><input id="w-seed" name="seed" class="field" placeholder="e.g. -4172144997902289642" value="${esc(w?.seed || '')}"></div></div>
          <div class="foot">${w ? '<button class="btn" type="button" data-wcancel>Cancel edit</button>' : ''}<button class="btn green" type="submit">${w ? 'Save world' : 'Create world'}</button></div></form>`;
      },
      onClick: async (e, c) => {
        const b = e.target.closest('[data-wedit],[data-wdel],[data-wcancel]');
        if (!b) return;
        if (b.dataset.wedit) { c.editing = b.dataset.wedit; return c.rerender(); }
        if (b.dataset.wcancel !== undefined) { c.editing = null; return c.rerender(); }
        const w = S.data.worlds.find((x) => x.id === b.dataset.wdel);
        const n = S.data.dots.filter((d) => d.world === w.id).length;
        c.close();
        if (!(await app.confirmDialog(`Delete the world "${w.name}"${n ? ` and its ${n} dot${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`))) return openWorlds();
        S.data.worlds = S.data.worlds.filter((x) => x.id !== w.id);
        S.data.dots = S.data.dots.filter((d) => d.world !== w.id);
        if (S.worldId === w.id) app.setWorld(S.data.worlds[0]?.id || null); else app.refreshAll();
        await save(`Delete world ${w.name}`);
        openWorlds();
      },
      onSubmit: async (fd, c) => {
        const name = String(fd.get('name') || '').trim();
        const seed = String(fd.get('seed') || '').trim();
        if (!name) return c.fail('Give the world a name.');
        if (S.data.worlds.some((x) => x.id !== c.editing && x.name.toLowerCase() === name.toLowerCase())) return c.fail(`There is already a world called "${name}".`);
        let w;
        if (c.editing) { w = S.data.worlds.find((x) => x.id === c.editing); Object.assign(w, { name, seed }); }
        else { w = { id: uid('world'), name, seed }; S.data.worlds.push(w); }
        const first = !S.worldId;
        c.editing = null;
        c.rerender();
        if (first) app.setWorld(w.id); else app.refreshAll();
        await save(`Save world ${name}`);
      },
    });
  }

  // ---------- Dimensions ----------
  function openDimensions() {
    listWindow({
      title: 'Dimensions',
      intro: 'Dimensions are shared by every world. The ratio says how much faster you travel horizontally (Nether: 8).',
      render: (c) => {
        const d = c.editing ? app.dimById(c.editing) : null;
        return `<table><tr><th>Name</th><th>Ratio</th><th>Y range</th><th></th></tr>${app.dims().map((x) => `<tr><td><span class="swatch" style="background:${esc(x.color)}"></span>${esc(x.name)}</td><td>1:${x.ratio}</td><td>${x.minY} to ${x.maxY}</td>
          <td class="acts"><button class="btn small" type="button" data-dedit="${x.id}">Edit</button> <button class="btn small red" type="button" data-ddel="${x.id}">Delete</button></td></tr>`).join('')}</table>
          <form class="row" style="gap:8px"><span class="lbl" style="font-size:17px">${d ? `Edit ${esc(d.name)}` : 'Add a dimension'}</span>
          <div class="cols"><div class="row"><label for="d-name">Name</label><input id="d-name" name="name" class="field" placeholder="e.g. Aether" value="${esc(d?.name || '')}"></div>
          <div class="row"><label for="d-ratio">Horizontal ratio</label><input id="d-ratio" name="ratio" class="field" placeholder="e.g. 1" value="${d?.ratio ?? ''}"></div>
          <div class="row"><label for="d-min">Lowest Y</label><input id="d-min" name="minY" class="field" placeholder="e.g. 0" value="${d?.minY ?? ''}"></div>
          <div class="row"><label for="d-max">Highest Y</label><input id="d-max" name="maxY" class="field" placeholder="e.g. 256" value="${d?.maxY ?? ''}"></div>
          <div class="row"><label for="d-color">Colour</label><input id="d-color" name="color" type="color" value="${esc(d?.color || '#ffaa00')}" style="width:80px;height:36px"></div>
          <div class="row"><label for="d-note">Note (optional)</label><input id="d-note" name="note" class="field" placeholder="e.g. 1st layer: Y 0 to 125" value="${esc(d?.note || '')}"></div></div>
          <div class="foot">${d ? '<button class="btn" type="button" data-dcancel>Cancel edit</button>' : ''}<button class="btn green" type="submit">${d ? 'Save dimension' : 'Create dimension'}</button></div></form>`;
      },
      onClick: async (e, c) => {
        const b = e.target.closest('[data-dedit],[data-ddel],[data-dcancel]');
        if (!b) return;
        if (b.dataset.dedit) { c.editing = b.dataset.dedit; return c.rerender(); }
        if (b.dataset.dcancel !== undefined) { c.editing = null; return c.rerender(); }
        const d = app.dimById(b.dataset.ddel);
        const n = S.data.dots.filter((x) => x.dim === d.id).length;
        if (n) return c.fail(`${n} dot${n === 1 ? ' is' : 's are'} in ${d.name}. Move or delete ${n === 1 ? 'it' : 'them'} first.`);
        if (app.dims().length === 1) return c.fail('The map needs at least one dimension.');
        c.close();
        if (!(await app.confirmDialog(`Delete the dimension "${d.name}"?`))) return openDimensions();
        S.data.dimensions = S.data.dimensions.filter((x) => x.id !== d.id);
        S.visibleDims.delete(d.id);
        app.refreshAll();
        await save(`Delete dimension ${d.name}`);
        openDimensions();
      },
      onSubmit: async (fd, c) => {
        const name = String(fd.get('name') || '').trim();
        const ratio = Number(fd.get('ratio'));
        const minY = Number(fd.get('minY')), maxY = Number(fd.get('maxY'));
        if (!name) return c.fail('Give the dimension a name.');
        if (!(ratio > 0)) return c.fail('The ratio must be a number above 0, e.g. 1 or 8.');
        if (!Number.isInteger(minY) || !Number.isInteger(maxY) || minY >= maxY) return c.fail('Lowest and highest Y must be whole numbers, lowest below highest.');
        if (app.dims().some((x) => x.id !== c.editing && x.name.toLowerCase() === name.toLowerCase())) return c.fail(`There is already a dimension called "${name}".`);
        if (c.editing) {
          const outside = S.data.dots.filter((x) => x.dim === c.editing && (x.y < minY || x.y > maxY)).length;
          if (outside) return c.fail(`${outside} dot${outside === 1 ? ' is' : 's are'} outside Y ${minY} to ${maxY}. Change ${outside === 1 ? 'it' : 'them'} first.`);
          Object.assign(app.dimById(c.editing), { name, ratio, minY, maxY, color: fd.get('color'), note: String(fd.get('note') || '').trim() });
        } else {
          let id = slugify(name);
          while (app.dimById(id)) id += '-2';
          S.data.dimensions.push({ id, name, ratio, minY, maxY, color: fd.get('color'), icon: '', note: String(fd.get('note') || '').trim() });
        }
        c.editing = null;
        c.rerender();
        app.refreshAll();
        await save(`Save dimension ${name}`);
      },
    });
  }

  // ---------- Players ----------
  function openPlayers() {
    listWindow({
      title: 'Players',
      intro: 'Java Edition usernames. Faces are loaded automatically from the username.',
      render: () => `<table><tr><th></th><th>Username</th><th>Dots</th><th></th></tr>${S.data.players.map((p) => `<tr><td style="width:40px"><div class="slot" style="width:32px;height:32px">${app.faceImg(p.name)}</div></td><td>${esc(p.name)}</td><td>${S.data.dots.filter((d) => d.finder === p.name).length}</td>
          <td class="acts"><button class="btn small red" type="button" data-pdel="${esc(p.name)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="hint">No players yet.</td></tr>'}</table>
          <form class="row" style="gap:8px"><label for="p-name">Add a player</label><div style="display:flex;gap:8px"><input id="p-name" name="name" class="field" placeholder="e.g. Oriamx"><button class="btn green" type="submit">Add</button></div></form>`,
      onClick: async (e, c) => {
        const b = e.target.closest('[data-pdel]');
        if (!b) return;
        const name = b.dataset.pdel;
        c.close();
        if (!(await app.confirmDialog(`Remove ${name} from the Players list? Their dots keep showing their name.`, 'Remove'))) return openPlayers();
        S.data.players = S.data.players.filter((p) => p.name !== name);
        app.refreshAll();
        await save(`Remove player ${name}`);
        openPlayers();
      },
      onSubmit: async (fd, c) => {
        const name = String(fd.get('name') || '').trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return c.fail('A Java username has 3 to 16 letters, numbers or underscores.');
        if (S.data.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return c.fail(`${name} is already on the list.`);
        S.data.players.push({ name });
        c.rerender();
        app.refreshAll();
        await save(`Add player ${name}`);
      },
    });
  }

  // ---------- Transport methods ----------
  function openTransports() {
    listWindow({
      title: 'Transport methods',
      intro: 'Average speeds used for the route time. Blocks are 1 metre, so m/s = blocks per second.',
      render: (c) => {
        const t = c.editing ? S.data.transports.find((x) => x.id === c.editing) : null;
        return `<table><tr><th>Method</th><th>Condition</th><th>m/s</th><th></th></tr>${S.data.transports.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.condition)}</td><td>${x.speed}</td>
          <td class="acts"><button class="btn small" type="button" data-tedit="${x.id}">Edit</button> <button class="btn small red" type="button" data-tdel="${x.id}">Delete</button></td></tr>`).join('')}</table>
          <form class="row" style="gap:8px"><span class="lbl" style="font-size:17px">${t ? `Edit ${esc(t.name)}` : 'Add a method'}</span>
          <div class="cols"><div class="row"><label for="t-name">Method</label><input id="t-name" name="name" class="field" placeholder="e.g. Pig" value="${esc(t?.name || '')}"></div>
          <div class="row"><label for="t-cond">Condition</label><input id="t-cond" name="condition" class="field" placeholder="e.g. Flat terrain" value="${esc(t?.condition || '')}"></div>
          <div class="row"><label for="t-speed">Average speed (m/s)</label><input id="t-speed" name="speed" class="field" placeholder="e.g. 2.5" value="${t?.speed ?? ''}"></div></div>
          <div class="foot">${t ? '<button class="btn" type="button" data-tcancel>Cancel edit</button>' : ''}<button class="btn green" type="submit">${t ? 'Save method' : 'Add method'}</button></div></form>`;
      },
      onClick: async (e, c) => {
        const b = e.target.closest('[data-tedit],[data-tdel],[data-tcancel]');
        if (!b) return;
        if (b.dataset.tedit) { c.editing = b.dataset.tedit; return c.rerender(); }
        if (b.dataset.tcancel !== undefined) { c.editing = null; return c.rerender(); }
        if (S.data.transports.length === 1) return c.fail('Keep at least one transport method.');
        const t = S.data.transports.find((x) => x.id === b.dataset.tdel);
        c.close();
        if (!(await app.confirmDialog(`Delete "${t.name} (${t.condition})"?`))) return openTransports();
        S.data.transports = S.data.transports.filter((x) => x.id !== t.id);
        app.refreshAll();
        await save(`Delete transport ${t.name}`);
        openTransports();
      },
      onSubmit: async (fd, c) => {
        const name = String(fd.get('name') || '').trim();
        const condition = String(fd.get('condition') || '').trim();
        const speed = Number(String(fd.get('speed') || '').replace(',', '.'));
        if (!name) return c.fail('Give the method a name.');
        if (!(speed > 0)) return c.fail('The speed must be a number above 0, e.g. 4.317.');
        if (c.editing) Object.assign(S.data.transports.find((x) => x.id === c.editing), { name, condition, speed });
        else {
          let id = slugify(`${name}-${condition}`);
          while (S.data.transports.some((x) => x.id === id)) id += '-2';
          S.data.transports.push({ id, name, condition, speed });
        }
        c.editing = null;
        c.rerender();
        app.refreshAll();
        await save(`Save transport ${name}`);
      },
    });
  }

  return { editDot, deleteDot };
}
