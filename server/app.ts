import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Store, type Author, type SaveResult } from './store.ts';
import { Limiter, type LimitConfig } from './limits.ts';
import { randomBytes } from 'node:crypto';
import { anonNameFor, currentAnonName, idFromSecret, isToken, isUserId, newAnonId, userSecret } from './ids.ts';

export type Config = LimitConfig & {
  publicDir: string;
  maxDiffKb: number;        // Before and After together, in UTF-8 kilobytes
  maxDbBytes: number;       // writes are refused above this
  secureCookies: boolean;
};
const COOKIE = 'anon';
const YEAR_S = 365 * 24 * 3600;

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // CodeMirror injects its theme as style elements
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',                 // secret links never leak through the Referer header
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

type Asset = { body: Buffer; gz: Buffer; br: Buffer; type: string; immutable: boolean };

/** The caller: a user, and whether they came with a bearer secret (an agent) or the browser cookie. */
type Me = Author & { viaBearer: boolean };

/** Public paths of the agent docs → the built file behind each. */
const DOCS: Record<string, string> = { '/api': '/api.md', '/api.md': '/api.md', '/llms.txt': '/api.md', '/openapi.json': '/openapi.json' };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

/** Loads the built frontend into memory once, pre-compressed. */
function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = '/' + path.relative(dir, full).split(path.sep).join('/');
      const body = readFileSync(full);
      const type = TYPES[path.extname(name)] ?? 'application/octet-stream';
      const compressible = !type.startsWith('font/');
      assets.set(rel, {
        body, type, immutable: rel.startsWith('/assets/'),
        gz: compressible ? zlib.gzipSync(body, { level: 9 }) : body,
        br: compressible ? zlib.brotliCompressSync(body) : body,
      });
    }
  };
  walk(dir);
  if (!assets.has('/index.html')) throw new Error(`index.html missing in ${dir}; run the frontend build first`);
  return assets;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createApp(store: Store, cfg: Config) {
  const assets = loadAssets(cfg.publicDir);
  const limiter = new Limiter(store, cfg);
  // JSON escaping can double text (every line break is two bytes), plus room for the other fields.
  const maxBodyBytes = cfg.maxDiffKb * 1024 * 2 + 64 * 1024;

  function send(res: http.ServerResponse, status: number, body: Buffer | string, headers: Record<string, string> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  function json(res: http.ServerResponse, status: number, data: unknown) {
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  function sendAsset(req: http.IncomingMessage, res: http.ServerResponse, asset: Asset, status = 200) {
    const accept = String(req.headers['accept-encoding'] ?? '');
    const headers: Record<string, string> = {
      'Content-Type': asset.type, Vary: 'Accept-Encoding',
      'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    };
    let body = asset.body;
    if (asset.br !== asset.body && /\bbr\b/.test(accept)) { body = asset.br; headers['Content-Encoding'] = 'br'; }
    else if (asset.gz !== asset.body && /\bgzip\b/.test(accept)) { body = asset.gz; headers['Content-Encoding'] = 'gzip'; }
    send(res, status, req.method === 'HEAD' ? '' : body, headers);
  }

  /** Traefik appends the real client address as the last X-Forwarded-For entry. */
  function clientIp(req: http.IncomingMessage): string {
    const xff = String(req.headers['x-forwarded-for'] ?? '');
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    return last || req.socket.remoteAddress || 'unknown';
  }

  // Signs user secrets; created once and kept in the database, so secrets survive restarts.
  const userKey = store.metaValue('user_key', () => randomBytes(32).toString('base64url'));
  const nameOf = (id: string) => store.userName(id) ?? anonNameFor(id);

  /**
   * Who is calling. `Authorization: Bearer <user secret>` (agents, scripts) or the browser cookie, which holds
   * the same secret; otherwise a new anonymous user is minted. Bearer callers never get a cookie set.
   * Reading never writes to the database: a name is stored only when its user writes (see `remember`),
   * so a flood of reads cannot grow the users table.
   */
  function identity(req: http.IncomingMessage, res: http.ServerResponse): Me {
    const auth = String(req.headers.authorization ?? '');
    if (auth) {
      const id = idFromSecret(/^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? '', userKey);
      if (!id) throw new HttpError(401, 'Authorization must be "Bearer <user secret>" with a valid secret');
      return { id, name: nameOf(id), viaBearer: true };
    }
    const raw = String(req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
    if (raw) {
      const [cred, enc] = raw.slice(COOKIE.length + 1).split('~');
      let name = '';
      try { name = Buffer.from(enc ?? '', 'base64url').toString('utf8'); } catch { /* malformed cookie: replaced below */ }
      // A cookie from before secrets holds a bare user id: it is upgraded to that id's secret once.
      const id = cred.includes('.') ? idFromSecret(cred, userKey) : isUserId(cred) ? cred : null;
      if (id && name && name.length <= 40) {
        const current = currentAnonName(name); // same person, name brought to the current form
        if (current !== name || !cred.includes('.')) setIdentity(res, { id, name: current });
        return { id, name: current, viaBearer: false };
      }
    }
    const id = newAnonId();
    const author = { id, name: anonNameFor(id) };
    setIdentity(res, author);
    return { ...author, viaBearer: false };
  }

  /** Stores the caller's name, so the same user on another device or an agent sees it. Writes only. */
  function remember(me: Author) {
    if (store.userName(me.id) !== me.name) store.setUserName(me.id, me.name, Date.now());
  }

  function setIdentity(res: http.ServerResponse, author: Author) {
    const value = `${userSecret(author.id, userKey)}~${Buffer.from(author.name, 'utf8').toString('base64url')}`;
    const parts = [`${COOKIE}=${value}`, 'Path=/', `Max-Age=${YEAR_S}`, 'HttpOnly', 'SameSite=Lax'];
    if (cfg.secureCookies) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  /** Renames the caller everywhere their name lives: the users table, and the cookie for a browser. */
  function rename(res: http.ServerResponse, me: Me, raw: unknown) {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) throw new HttpError(400, 'Name must be 1–40 characters');
    remember({ id: me.id, name });
    if (!me.viaBearer) setIdentity(res, { id: me.id, name });
    me.name = name;
  }

  /** The public origin, for absolute links in responses (Traefik terminates TLS and says so). */
  function origin(req: http.IncomingMessage): string {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
    return `${proto}://${req.headers.host ?? 'localhost'}`;
  }

  async function readJson(req: http.IncomingMessage): Promise<any> {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) throw new HttpError(413, `A diff is limited to ${cfg.maxDiffKb.toLocaleString('en')} KB of text`);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'Bad JSON'); }
  }

  /** The two texts of a request; `before`/`after` and `left`/`right` are the same fields. */
  function panes(body: any): { left: string; right: string } {
    const left = body?.before ?? body?.left;
    const right = body?.after ?? body?.right;
    if (typeof left !== 'string' || typeof right !== 'string') throw new HttpError(400, 'before and after must be strings');
    const kb = (Buffer.byteLength(left, 'utf8') + Buffer.byteLength(right, 'utf8')) / 1024;
    if (kb > cfg.maxDiffKb) {
      throw new HttpError(413, `A diff is limited to ${cfg.maxDiffKb.toLocaleString('en')} KB of text, Before and After together; this one is ${Math.ceil(kb).toLocaleString('en')} KB`);
    }
    return { left, right };
  }

  function writable() {
    if (store.bytes() > cfg.maxDbBytes) throw new HttpError(507, 'Storage is full');
  }

  function saveResponse(res: http.ServerResponse, result: SaveResult) {
    if (result.kind === 'limited') throw new HttpError(429, 'Daily limit of new versions reached. Try again tomorrow.');
    if (result.kind === 'conflict') return json(res, 409, { error: 'conflict', rev: result.rev });
    json(res, 200, result);
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, me: Me, ipHash: string) {
    const method = req.method ?? 'GET';
    const now = Date.now();
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const write = method !== 'GET' && method !== 'HEAD';

    // Custom header: a cross-site form or fetch cannot send it without a CORS preflight, which is never granted.
    if (write && req.headers['x-diff'] !== '1') throw new HttpError(403, 'Missing X-Diff header');
    if (!limiter.perMinute(write ? 'save' : 'read', ipHash, now)) throw new HttpError(429, 'Too many requests. Slow down.');
    if (write) remember(me); // writes are rate limited, so the users table grows only as fast as they allow
    const mintAllowed = () => limiter.tryMint(ipHash, now);

    // The caller's own identity. The secret goes only to its owner, and only from /api/me and diff creation.
    const you = () => ({ id: me.id, name: me.name });
    const youWithSecret = () => ({ ...you(), secret: userSecret(me.id, userKey) });

    if (parts[1] === 'me' && parts.length === 2) {
      if (method === 'GET') return json(res, 200, youWithSecret());
      if (method === 'PUT') { rename(res, me, (await readJson(req))?.name); return json(res, 200, youWithSecret()); }
    }
    // Restore a login from a backed-up secret: this browser becomes that user.
    if (parts[1] === 'me' && parts[2] === 'login' && parts.length === 3 && method === 'POST') {
      const id = idFromSecret(String((await readJson(req))?.secret ?? '').trim(), userKey);
      if (!id) throw new HttpError(401, 'That key is not valid');
      const user = { id, name: nameOf(id) };
      setIdentity(res, user);
      Object.assign(me, user);
      return json(res, 200, youWithSecret());
    }

    // One call for agents: who you are (new unless a bearer secret is sent), your name, the diff, and both links.
    if (parts[1] === 'diffs' && parts.length === 2 && method === 'POST') {
      writable();
      const body = await readJson(req);
      const { left, right } = panes(body);
      if (body.name !== undefined) rename(res, me, body.name);
      if (!mintAllowed()) throw new HttpError(429, 'Daily limit of new diffs reached. Try again tomorrow.');
      const created = store.create(left, right, me, now);
      const head = store.head(created.diffId);
      const base = origin(req);
      return json(res, 201, {
        edit: created.editToken, view: created.viewToken, rev: 1, head: store.out(head, me.id),
        urls: { edit: `${base}/${created.editToken}`, view: `${base}/${created.viewToken}` },
        you: youWithSecret(),
      });
    }

    if (parts[1] === 'd' && parts[2] && isToken(parts[2])) {
      const found = store.find(parts[2]);
      if (!found) throw new HttpError(404, 'Not found');
      const { diff, role } = found;
      const canEdit = role === 'edit';
      const rest = parts.slice(3);
      if (write && !canEdit) throw new HttpError(403, 'This link is view-only');

      if (rest.length === 0 && method === 'GET') {
        const head = store.head(diff.id);
        const base = origin(req);
        return json(res, 200, {
          role, rev: diff.rev, versioning: diff.versioning === 1, me: me.name, you: you(),
          links: canEdit ? { edit: diff.edit_token, view: diff.view_token } : { view: diff.view_token },
          urls: canEdit ? { edit: `${base}/${diff.edit_token}`, view: `${base}/${diff.view_token}` } : { view: `${base}/${diff.view_token}` },
          head: { ...store.out(head, me.id), left: head.left_text, right: head.right_text },
          versions: store.versions(diff.id, me.id),
        });
      }
      if (rest.length === 1 && rest[0] === 'rev' && method === 'GET') return json(res, 200, { rev: diff.rev });
      if (rest.length === 0 && method === 'PUT') {
        writable();
        const body = await readJson(req);
        const { left, right } = panes(body);
        if (body.name !== undefined) rename(res, me, body.name);
        // Without `base` the save cannot conflict; it lands as a new version so nobody's work is overwritten.
        const blind = body.base === undefined;
        const base = blind ? diff.rev : Number(body.base);
        if (!Number.isInteger(base)) throw new HttpError(400, 'base must be an integer');
        return saveResponse(res, store.save(diff.id, left, right, base, blind || body.force === true, me, now, mintAllowed));
      }
      if (rest.length === 1 && rest[0] === 'settings' && method === 'PUT') {
        const body = await readJson(req);
        if (typeof body.versioning !== 'boolean') throw new HttpError(400, 'versioning must be a boolean');
        store.setVersioning(diff.id, body.versioning);
        return json(res, 200, { versioning: body.versioning });
      }
      if (rest[0] === 'v' && rest[1] && /^\d{1,9}$/.test(rest[1])) {
        const n = Number(rest[1]);
        if (rest.length === 2 && method === 'GET') {
          const row = store.versionRow(diff.id, n);
          if (!row) throw new HttpError(404, 'No such version');
          return json(res, 200, { ...store.out(row, me.id), left: row.left_text, right: row.right_text });
        }
        if (rest.length === 3 && rest[2] === 'name' && method === 'PUT') {
          const raw = (await readJson(req))?.name;
          const name = raw === null ? null : String(raw ?? '').trim().slice(0, 80) || null;
          if (!store.name(diff.id, n, name)) throw new HttpError(404, 'No such version');
          return json(res, 200, { versions: store.versions(diff.id, me.id) });
        }
        if (rest.length === 3 && rest[2] === 'restore' && method === 'POST') {
          writable();
          const result = store.restore(diff.id, n, me, now, mintAllowed);
          if (!result) throw new HttpError(404, 'No such version');
          return saveResponse(res, result);
        }
      }
    }
    throw new HttpError(404, 'Not found');
  }

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      if (url.pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain' });
      // Agent docs: served with this server's own origin filled in, so examples work as copied.
      const doc = DOCS[url.pathname];
      if (doc) {
        const asset = assets.get(doc)!;
        return send(res, 200, asset.body.toString('utf8').replaceAll('{{origin}}', origin(req)), { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
      }
      if (url.pathname.startsWith('/api/')) {
        const me = identity(req, res);
        return await api(req, res, url, me, limiter.hash(clientIp(req)));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const asset = assets.get(url.pathname);
      if (asset && url.pathname !== '/index.html') return sendAsset(req, res, asset);
      const token = url.pathname.slice(1);
      if (url.pathname === '/' || isToken(token)) {
        identity(req, res);
        return sendAsset(req, res, assets.get('/index.html')!);
      }
      return sendAsset(req, res, assets.get('/index.html')!, 404);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(new Date().toISOString(), 'request failed', req.method, url.pathname.replace(/[A-Za-z0-9]{22}/g, '<token>'), err);
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
      else res.destroy();
    }
  };
}
