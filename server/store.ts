import { DatabaseSync } from 'node:sqlite';
import { newToken } from './ids.ts';

/** Same person keeps amending the head version for this long; then a new version is minted. */
export const AMEND_WINDOW_MS = 30 * 60 * 1000;

export type Author = { id: string; name: string };
export type Role = 'edit' | 'view';

type DiffRow = { id: number; edit_token: string; view_token: string; versioning: number; rev: number };
type VersionRow = {
  n: number; left_text: string; right_text: string; author_id: string; authors: string;
  created_at: number; updated_at: number; name: string | null; restored_from: number | null;
};

/** A version as the API returns it. Author ids stay on the server; `mine` tells the caller which are theirs. */
export type VersionOut = {
  n: number; authors: string[]; mine: boolean; createdAt: number; updatedAt: number;
  name: string | null; restoredFrom: number | null; size: number;
};

export type SaveResult =
  | { kind: 'saved'; minted: boolean; rev: number; head: VersionOut }
  | { kind: 'unchanged'; rev: number; head: VersionOut }
  | { kind: 'conflict'; rev: number }
  | { kind: 'limited' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diffs(
  id INTEGER PRIMARY KEY,
  edit_token TEXT NOT NULL UNIQUE,
  view_token TEXT NOT NULL UNIQUE,
  versioning INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 1,       -- bumps on every content write; clients send it back as their base
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY,
  diff_id INTEGER NOT NULL REFERENCES diffs(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  left_text TEXT NOT NULL,
  right_text TEXT NOT NULL,
  author_id TEXT NOT NULL,              -- who minted the version
  authors TEXT NOT NULL,                -- JSON [{id,name}], everyone who wrote to it, first writer first
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  name TEXT,                            -- a named version is closed: the next save mints a new one
  restored_from INTEGER,
  UNIQUE(diff_id, n)
);
CREATE TABLE IF NOT EXISTS mints(ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mints_ip_at ON mints(ip, at);
CREATE INDEX IF NOT EXISTS mints_at ON mints(at);
-- Display names by user id, so a caller without the browser cookie (an agent) keeps the name it set.
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  userName(id: string): string | null {
    const row = this.db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /** Records a user's display name; writes only when it changed. */
  setUserName(id: string, name: string, now: number) {
    this.db.prepare(
      'INSERT INTO users(id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at WHERE users.name IS NOT excluded.name',
    ).run(id, name, now);
  }

  /** A value that must survive restarts, created on first use (e.g. the IP hashing secret). */
  metaValue(key: string, create: () => string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return row.value;
    const value = create();
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(key, value);
    return value;
  }

  /** Runs fn inside one write transaction, so the read-decide-write of a save cannot interleave. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  find(token: string): { diff: DiffRow; role: Role } | null {
    const diff = this.db.prepare('SELECT * FROM diffs WHERE edit_token = ? OR view_token = ?').get(token, token) as DiffRow | undefined;
    if (!diff) return null;
    return { diff, role: diff.edit_token === token ? 'edit' : 'view' };
  }

  private headRow(diffId: number): VersionRow {
    return this.db.prepare('SELECT * FROM versions WHERE diff_id = ? ORDER BY n DESC LIMIT 1').get(diffId) as VersionRow;
  }

  versionRow(diffId: number, n: number): VersionRow | undefined {
    return this.db.prepare('SELECT * FROM versions WHERE diff_id = ? AND n = ?').get(diffId, n) as VersionRow | undefined;
  }

  out(row: VersionRow, me: string): VersionOut {
    const authors = JSON.parse(row.authors) as Author[];
    return {
      n: row.n, authors: authors.map((a) => a.name), mine: authors.some((a) => a.id === me),
      createdAt: row.created_at, updatedAt: row.updated_at, name: row.name, restoredFrom: row.restored_from,
      size: row.left_text.length + row.right_text.length,
    };
  }

  head(diffId: number) {
    return this.headRow(diffId);
  }

  /** Newest first; content stays out of the list. */
  versions(diffId: number, me: string): VersionOut[] {
    const rows = this.db.prepare(
      `SELECT n, '' AS left_text, '' AS right_text, author_id, authors, created_at, updated_at, name, restored_from,
              length(left_text) + length(right_text) AS size
       FROM versions WHERE diff_id = ? ORDER BY n DESC`,
    ).all(diffId) as (VersionRow & { size: number })[];
    return rows.map((r) => ({ ...this.out(r, me), size: r.size }));
  }

  create(left: string, right: string, author: Author, now: number) {
    return this.tx(() => {
      const editToken = newToken();
      const viewToken = newToken();
      const res = this.db.prepare('INSERT INTO diffs(edit_token, view_token, created_at) VALUES (?, ?, ?)').run(editToken, viewToken, now);
      const diffId = Number(res.lastInsertRowid);
      this.insertVersion(diffId, 1, left, right, author, now, null);
      return { editToken, viewToken, diffId };
    });
  }

  private insertVersion(diffId: number, n: number, left: string, right: string, author: Author, now: number, restoredFrom: number | null) {
    this.db.prepare(
      `INSERT INTO versions(diff_id, n, left_text, right_text, author_id, authors, created_at, updated_at, restored_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(diffId, n, left, right, author.id, JSON.stringify([author]), now, now, restoredFrom);
  }

  private amend(diffId: number, head: VersionRow, left: string, right: string, author: Author, now: number) {
    const authors = JSON.parse(head.authors) as Author[];
    const known = authors.find((a) => a.id === author.id);
    if (known) known.name = author.name;
    else authors.push(author);
    this.db.prepare('UPDATE versions SET left_text = ?, right_text = ?, authors = ?, updated_at = ? WHERE diff_id = ? AND n = ?')
      .run(left, right, JSON.stringify(authors), now, diffId, head.n);
  }

  private bumpRev(diffId: number): number {
    const row = this.db.prepare('UPDATE diffs SET rev = rev + 1 WHERE id = ? RETURNING rev').get(diffId) as { rev: number };
    return row.rev;
  }

  /**
   * Save both panes. Versioning rule:
   * - another person, a named (closed) head, a head older than the amend window, or `force` → mint a new version;
   * - otherwise amend the head. With versioning off every save amends the head.
   * `base` is the rev the client last saw; a different current rev is a conflict unless `force`.
   * `mintAllowed` is asked only when a mint is about to happen, so amends never spend the daily quota.
   */
  save(diffId: number, left: string, right: string, base: number, force: boolean, author: Author, now: number,
    mintAllowed: () => boolean): SaveResult {
    return this.tx(() => {
      const diff = this.db.prepare('SELECT * FROM diffs WHERE id = ?').get(diffId) as DiffRow;
      if (!force && base !== diff.rev) return { kind: 'conflict', rev: diff.rev };
      const head = this.headRow(diffId);
      if (head.left_text === left && head.right_text === right) {
        return { kind: 'unchanged', rev: diff.rev, head: this.out(head, author.id) };
      }
      const mint = diff.versioning === 1 && (
        force || head.author_id !== author.id || head.name !== null || now - head.created_at >= AMEND_WINDOW_MS
      );
      if (mint) {
        if (!mintAllowed()) return { kind: 'limited' };
        this.insertVersion(diffId, head.n + 1, left, right, author, now, null);
      } else {
        this.amend(diffId, head, left, right, author, now);
      }
      const rev = this.bumpRev(diffId);
      return { kind: 'saved', minted: mint, rev, head: this.out(this.headRow(diffId), author.id) };
    });
  }

  /** Bring an old version back as the newest one; history stays append-only. */
  restore(diffId: number, n: number, author: Author, now: number, mintAllowed: () => boolean): SaveResult | null {
    const old = this.versionRow(diffId, n);
    if (!old) return null;
    return this.tx(() => {
      const diff = this.db.prepare('SELECT * FROM diffs WHERE id = ?').get(diffId) as DiffRow;
      const head = this.headRow(diffId);
      if (diff.versioning === 1) {
        if (!mintAllowed()) return { kind: 'limited' };
        this.insertVersion(diffId, head.n + 1, old.left_text, old.right_text, author, now, n);
      } else {
        this.amend(diffId, head, old.left_text, old.right_text, author, now);
      }
      const rev = this.bumpRev(diffId);
      return { kind: 'saved', minted: diff.versioning === 1, rev, head: this.out(this.headRow(diffId), author.id) };
    });
  }

  /** Naming closes a version; a null name clears the label and reopens it. */
  name(diffId: number, n: number, name: string | null): boolean {
    const res = this.db.prepare('UPDATE versions SET name = ? WHERE diff_id = ? AND n = ?').run(name, diffId, n);
    return res.changes > 0;
  }

  setVersioning(diffId: number, on: boolean) {
    this.db.prepare('UPDATE diffs SET versioning = ? WHERE id = ?').run(on ? 1 : 0, diffId);
  }

  /** Mints (new diffs + new versions) by one hashed IP and by everyone since `since`. */
  mintCounts(ip: string, since: number): { ip: number; all: number } {
    const ipRow = this.db.prepare('SELECT count(*) AS c FROM mints WHERE ip = ? AND at >= ?').get(ip, since) as { c: number };
    const allRow = this.db.prepare('SELECT count(*) AS c FROM mints WHERE at >= ?').get(since) as { c: number };
    return { ip: ipRow.c, all: allRow.c };
  }

  recordMint(ip: string, now: number, pruneBefore: number) {
    this.db.prepare('INSERT INTO mints(ip, at) VALUES (?, ?)').run(ip, now);
    this.db.prepare('DELETE FROM mints WHERE at < ?').run(pruneBefore);
  }

  bytes(): number {
    const row = this.db.prepare('SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()').get() as { b: number };
    return row.b;
  }
}
