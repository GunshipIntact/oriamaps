// OriaMaps – saving the owner's changes straight into the GitHub repository.
// The owner pastes a fine-grained GitHub token once; it is kept only in that browser.
// Everyone else can only look and route: without the token nothing can be changed.

export const REPO = { owner: 'GunshipIntact', repo: 'oriamaps', branch: 'main' };

const API = 'https://api.github.com';
const TOKEN_KEY = 'oriamaps.ownerToken';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

async function gh(path, opts = {}, token = getToken()) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let message = `GitHub answered ${res.status}`;
    try { const j = await res.json(); if (j.message) message = j.message; } catch { /* no body */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const contentsPath = (path) => `/repos/${REPO.owner}/${REPO.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

// Checks that the key may really change files. GitHub reports the account's rights on the repository,
// not the key's, so a harmless test write is tried: it names a wrong file version on purpose, which GitHub
// refuses with 409 (allowed, nothing changed) or 403 (key lacks "Contents: Read and write").
export async function verifyToken(token) {
  const info = await gh(`/repos/${REPO.owner}/${REPO.repo}`, {}, token);
  if (!(info.permissions && info.permissions.push)) return { ok: false, reason: 'account' };
  try {
    await gh(contentsPath('data/oriamaps.json'), {
      method: 'PUT',
      body: JSON.stringify({ message: 'OriaMaps access check (never saved)', content: btoa('check'), sha: '0'.repeat(40), branch: REPO.branch }),
    }, token);
    return { ok: true }; // not expected, the wrong version is always refused
  } catch (e) {
    if (e.status === 409 || e.status === 422) return { ok: true };
    if (e.status === 403 || e.status === 404) return { ok: false, reason: 'contents' };
    throw e;
  }
}

export const NO_WRITE_HELP = 'This GitHub key is not allowed to change files. On GitHub, edit the key: under Permissions → Repositories, add "Contents" and set it to "Read and write". Then sign in again.';

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function readFile(path) {
  const f = await gh(`${contentsPath(path)}?ref=${REPO.branch}&t=${Date.now()}`);
  return { sha: f.sha, text: base64ToUtf8(f.content) };
}

// Creates or replaces a file. content must already be base64.
export async function writeFile(path, base64, message) {
  let sha;
  try {
    sha = (await gh(`${contentsPath(path)}?ref=${REPO.branch}&t=${Date.now()}`)).sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return gh(contentsPath(path), {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, branch: REPO.branch, ...(sha ? { sha } : {}) }),
  });
}

export async function deleteFile(path, message) {
  const sha = (await gh(`${contentsPath(path)}?ref=${REPO.branch}&t=${Date.now()}`)).sha;
  return gh(contentsPath(path), { method: 'DELETE', body: JSON.stringify({ message, sha, branch: REPO.branch }) });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Shrinks a picture to at most 1280 px wide/high before uploading, so the site stays fast.
export function shrinkPicture(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the picture.'))), 'image/jpeg', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture this browser can read.')); };
    img.src = url;
  });
}
