import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, AMEND_WINDOW_MS } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { currentAnonName, isToken, newToken, randomAnonName } from '../server/ids.ts';

const A = { id: 'A'.repeat(22), name: 'Anon Otter' };
const B = { id: 'B'.repeat(22), name: 'Anon Heron' };
const yes = () => true;

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'diff-test-'));
  return { store: new Store(path.join(dir, 'diff.db')), dir };
}

test('anonymous names are living things; old generated names are brought current, chosen names never', () => {
  for (let i = 0; i < 200; i++) { const n = randomAnonName(); assert.equal(currentAnonName(n), n); }
  assert.match(currentAnonName('Anon Castle'), /^Anonymous (?!Castle)/);
  assert.equal(currentAnonName('Anon Otter'), 'Anonymous Otter');
  assert.equal(currentAnonName('Brikas'), 'Brikas');
});

test('tokens are 22 base62 characters and unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const t = newToken();
    assert.ok(isToken(t), t);
    seen.add(t);
  }
  assert.equal(seen.size, 2000);
});

test('same person within 30 minutes amends; after 30 minutes mints', () => {
  const { store, dir } = freshStore();
  const t0 = 1_000_000;
  const { diffId } = store.create('a', 'b', A, t0);
  let r = store.save(diffId, 'a', 'b2', 1, false, A, t0 + 60_000, yes);
  assert.equal(r.kind, 'saved');
  assert.equal(r.kind === 'saved' && r.minted, false);
  assert.equal(store.head(diffId).n, 1);
  r = store.save(diffId, 'a', 'b3', 2, false, A, t0 + AMEND_WINDOW_MS, yes);
  assert.equal(r.kind === 'saved' && r.minted, true);
  assert.equal(store.head(diffId).n, 2);
  rmSync(dir, { recursive: true });
});

test('another person mints a new version even seconds later', () => {
  const { store, dir } = freshStore();
  const { diffId } = store.create('a', 'b', A, 0);
  const r = store.save(diffId, 'a', 'b by B', 1, false, B, 30_000, yes);
  assert.equal(r.kind === 'saved' && r.minted, true);
  assert.equal(store.head(diffId).n, 2);
  assert.deepEqual(store.versions(diffId, B.id).map((v) => v.authors), [['Anon Heron'], ['Anon Otter']]);
  rmSync(dir, { recursive: true });
});

test('versioning off: every save amends and keeps every author', () => {
  const { store, dir } = freshStore();
  const { diffId } = store.create('a', 'b', A, 0);
  store.setVersioning(diffId, false);
  store.save(diffId, 'a', 'b by B', 1, false, B, 10, yes);
  store.save(diffId, 'a', 'b by A', 2, false, A, AMEND_WINDOW_MS * 3, yes);
  assert.equal(store.head(diffId).n, 1);
  assert.deepEqual(store.versions(diffId, A.id)[0].authors, ['Anon Otter', 'Anon Heron']);
  rmSync(dir, { recursive: true });
});

test('unchanged content writes nothing; stale base is a conflict; force mints', () => {
  const { store, dir } = freshStore();
  const { diffId } = store.create('a', 'b', A, 0);
  assert.equal(store.save(diffId, 'a', 'b', 1, false, A, 5, yes).kind, 'unchanged');
  store.save(diffId, 'a', 'b by B', 1, false, B, 10, yes); // rev 2
  assert.equal(store.save(diffId, 'a', 'b by A', 1, false, A, 20, yes).kind, 'conflict');
  const forced = store.save(diffId, 'a', 'b by A', 1, true, A, 20, yes);
  assert.equal(forced.kind === 'saved' && forced.minted, true);
  assert.equal(store.head(diffId).n, 3);
  rmSync(dir, { recursive: true });
});

test('naming closes a version; restore appends a copy', () => {
  const { store, dir } = freshStore();
  const { diffId } = store.create('a', 'one', A, 0);
  store.name(diffId, 1, 'Draft');
  const r = store.save(diffId, 'a', 'two', 1, false, A, 10, yes);
  assert.equal(r.kind === 'saved' && r.minted, true);
  const back = store.restore(diffId, 1, A, 20, yes);
  assert.equal(back?.kind, 'saved');
  const head = store.head(diffId);
  assert.equal(head.n, 3);
  assert.equal(head.right_text, 'one');
  assert.equal(head.restored_from, 1);
  rmSync(dir, { recursive: true });
});

test('a mint is refused when the quota says no, and nothing is written', () => {
  const { store, dir } = freshStore();
  const { diffId } = store.create('a', 'b', A, 0);
  const r = store.save(diffId, 'a', 'changed', 1, false, B, 10, () => false);
  assert.equal(r.kind, 'limited');
  assert.equal(store.head(diffId).right_text, 'b');
  rmSync(dir, { recursive: true });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────
let server: http.Server;
let base = '';
let appStore: Store;
let dir = '';

before(async () => {
  const fresh = freshStore();
  appStore = fresh.store;
  dir = fresh.dir;
  const handle = createApp(fresh.store, {
    publicDir: path.resolve('dist/public'),
    mintsPerIpPerDay: 3, mintsPerDay: 1000, savesPerIpPerMinute: 1000, readsPerIpPerMinute: 1000,
    maxDiffKb: 2, maxDbBytes: 1024 ** 3, secureCookies: false,
  });
  server = http.createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true }); });

async function req(method: string, url: string, body?: unknown, cookie = '', ip = '203.0.113.1') {
  const res = await fetch(base + url, {
    method,
    headers: {
      'X-Diff': '1', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers, cookie: setCookie.split(';')[0] };
}

test('http: create, view link is read-only, edit link saves, headers block indexing', async () => {
  const me = await req('GET', '/api/me');
  assert.match(me.json.name, /^Anonymous \S+$/);
  const cookie = me.cookie;
  const created = await req('POST', '/api/diffs', { left: 'Hello world', right: 'Hello there world' }, cookie);
  assert.equal(created.status, 201);
  assert.ok(isToken(created.json.edit) && isToken(created.json.view));
  assert.equal(created.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive, nosnippet');
  assert.equal(created.headers.get('referrer-policy'), 'no-referrer');

  const viewer = await req('GET', `/api/d/${created.json.view}`);
  assert.equal(viewer.json.role, 'view');
  assert.equal(viewer.json.links.edit, undefined);
  const denied = await req('PUT', `/api/d/${created.json.view}`, { left: 'x', right: 'y', base: 1 });
  assert.equal(denied.status, 403);

  const saved = await req('PUT', `/api/d/${created.json.edit}`, { left: 'Hello world', right: 'Hi world', base: 1 }, cookie);
  assert.equal(saved.json.kind, 'saved');
  assert.equal(saved.json.minted, false);

  const page = await req('GET', `/${created.json.edit}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<div id="editor"/);
  const robots = await req('GET', '/robots.txt');
  assert.match(robots.text, /Disallow: \//);
});

test('http agent flow: one call makes a named user, a diff and its links; its secret acts as that user', async () => {
  const ip = '203.0.113.50';
  const created = await req('POST', '/api/diffs', { before: 'Easy to use.', after: 'Simple to use.', name: "John's agent" }, '', ip);
  assert.equal(created.status, 201);
  const { you, urls, edit } = created.json;
  assert.equal(you.name, "John's agent");
  assert.match(you.id, /^[A-Za-z0-9]{22}$/);
  assert.ok(you.secret.startsWith(`${you.id}.`), 'the secret carries the id');
  assert.equal(urls.edit, `${base}/${edit}`);
  assert.deepEqual(created.json.head.authors, ["John's agent"]);

  // A later call with the bearer secret and no cookie: same user, name remembered; no base means a new version.
  const bearer = { Authorization: `Bearer ${you.secret}` };
  const res = await fetch(`${base}/api/d/${edit}`, {
    method: 'PUT', body: JSON.stringify({ before: 'Easy to use.', after: 'Very simple to use.' }),
    headers: { 'X-Diff': '1', ...bearer, 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  });
  const saved = await res.json();
  assert.equal(saved.kind, 'saved');
  assert.equal(saved.minted, true);
  assert.equal(res.headers.get('set-cookie'), null);
  const me = await fetch(`${base}/api/me`, { headers: bearer }).then((r) => r.json());
  assert.deepEqual(me, you);

  // Reading a diff never returns a secret, not even the reader's own.
  const read = await fetch(`${base}/api/d/${edit}`, { headers: bearer }).then((r) => r.text());
  assert.ok(!read.includes(you.secret.split('.')[1]));

  // The id alone, a forged signature or a cut-off secret are all refused.
  for (const auth of [`Bearer ${you.id}`, `Bearer ${you.id}.${'A'.repeat(32)}`, `Bearer ${you.secret.slice(0, -1)}`]) {
    assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: auth } })).status, 401, auth);
  }
  const docs = await req('GET', '/api');
  assert.match(docs.headers.get('content-type') ?? '', /markdown/);
  assert.ok(docs.text.includes(`POST ${base}/api/diffs`));
  const spec = await req('GET', '/openapi.json');
  assert.equal(spec.json.servers[0].url, base);
});

test('http: reads never write to the database, however many new visitors arrive', async () => {
  const users = () => (appStore.db.prepare('SELECT count(*) AS c FROM users').get() as { c: number }).c;
  const before = users();
  for (let i = 0; i < 20; i++) await req('GET', '/api/me', undefined, '', `198.51.100.${i}`);
  assert.equal(users(), before);
});

test('http: a backed-up secret restores the login in another browser; old id-only cookies are upgraded', async () => {
  const first = await req('PUT', '/api/me', { name: 'Desk' }, '', '198.51.100.90');
  const { secret, id } = first.json;
  const other = await req('POST', '/api/me/login', { secret }, '', '198.51.100.91');
  assert.equal(other.status, 200);
  assert.deepEqual(other.json, { id, name: 'Desk', secret });
  assert.ok(other.cookie.startsWith(`anon=${secret}~`), 'the new browser now holds the secret');
  assert.equal((await req('POST', '/api/me/login', { secret: `${id}.nope` }, '', '198.51.100.92')).status, 401);

  const legacy = await req('GET', '/api/me', undefined, `anon=${id}~${Buffer.from('Desk').toString('base64url')}`, '198.51.100.93');
  assert.equal(legacy.json.secret, secret);
  assert.ok(legacy.cookie.startsWith(`anon=${secret}~`));
});

test('http: writes need the X-Diff header', async () => {
  const res = await fetch(base + '/api/diffs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ left: 'a', right: 'b' }),
  });
  assert.equal(res.status, 403);
});

test('http: per-IP daily mint limit', async () => {
  const ip = '198.51.100.7';
  for (let i = 0; i < 3; i++) assert.equal((await req('POST', '/api/diffs', { left: 'a', right: String(i) }, '', ip)).status, 201);
  const fourth = await req('POST', '/api/diffs', { left: 'a', right: 'b' }, '', ip);
  assert.equal(fourth.status, 429);
  assert.equal((await req('POST', '/api/diffs', { left: 'a', right: 'b' }, '', '198.51.100.8')).status, 201);
});

test('http: a diff over the size cap is refused, counting both texts in bytes', async () => {
  const fits = await req('POST', '/api/diffs', { left: 'x'.repeat(1000), right: 'y'.repeat(1000) }, '', '192.0.2.50');
  assert.equal(fits.status, 201);
  const big = await req('POST', '/api/diffs', { left: 'x'.repeat(1100), right: 'y'.repeat(1100) }, '', '192.0.2.51');
  assert.equal(big.status, 413);
  assert.match(big.json.error, /2 KB/);
  const wide = await req('POST', '/api/diffs', { left: 'ø'.repeat(700), right: 'ø'.repeat(400) }, '', '192.0.2.52');
  assert.equal(wide.status, 413, 'ø is two bytes, so 1,100 of them pass 2 KB');
});
