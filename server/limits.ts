import { createHash, randomBytes } from 'node:crypto';
import type { Store } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type LimitConfig = {
  mintsPerIpPerDay: number;   // new diffs + new versions per client IP, rolling 24 h
  mintsPerDay: number;        // same, all clients together: a ceiling if many IPs are used
  savesPerIpPerMinute: number;
  readsPerIpPerMinute: number;
};

/**
 * Rate limits for a public, login-free app. Daily mint counts live in SQLite so a restart does not reset them;
 * per-minute counters are in memory. IPs are stored only as salted hashes.
 */
export class Limiter {
  private minute = new Map<string, { start: number; count: number }>();
  private salt: string;
  private store: Store;
  private cfg: LimitConfig;

  constructor(store: Store, cfg: LimitConfig) {
    this.store = store;
    this.cfg = cfg;
    this.salt = store.metaValue('ip_salt', () => randomBytes(32).toString('hex'));
  }

  hash(ip: string): string {
    return createHash('sha256').update(this.salt).update(ip).digest('base64url').slice(0, 22);
  }

  /** Fixed one-minute window per (kind, ip). Returns false when the request should be refused. */
  perMinute(kind: 'save' | 'read', ipHash: string, now: number): boolean {
    const max = kind === 'save' ? this.cfg.savesPerIpPerMinute : this.cfg.readsPerIpPerMinute;
    const key = `${kind}:${ipHash}`;
    const slot = this.minute.get(key);
    if (!slot || now - slot.start >= MINUTE_MS) {
      this.minute.set(key, { start: now, count: 1 });
      if (this.minute.size > 50_000) this.sweep(now);
      return true;
    }
    slot.count += 1;
    return slot.count <= max;
  }

  private sweep(now: number) {
    for (const [key, slot] of this.minute) if (now - slot.start >= MINUTE_MS) this.minute.delete(key);
  }

  /** Spends one mint if both the per-IP and the global daily budget allow it. */
  tryMint(ipHash: string, now: number): boolean {
    const counts = this.store.mintCounts(ipHash, now - DAY_MS);
    if (counts.ip >= this.cfg.mintsPerIpPerDay || counts.all >= this.cfg.mintsPerDay) return false;
    this.store.recordMint(ipHash, now, now - DAY_MS);
    return true;
  }
}
