import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Link tokens: 22 base62 characters ≈ 131 bits from the CSPRNG. */
export const TOKEN_LENGTH = 22;
const TOKEN_RE = new RegExp(`^[A-Za-z0-9]{${TOKEN_LENGTH}}$`);

/** Uniform base62 string; rejection sampling keeps every character equally likely. */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += ALPHABET[byte % 62]; // 248 = 4 * 62, so no modulo bias
      if (out.length === length) break;
    }
  }
  return out;
}

export const newToken = (): string => randomBase62(TOKEN_LENGTH);
export const isToken = (s: string): boolean => TOKEN_RE.test(s);

// Nouns for anonymous names: living things only (animals, plants, fungi), each with an icon of the same name.
const NOUNS = Object.keys(JSON.parse(readFileSync(new URL('./anon-icons.json', import.meta.url), 'utf8')));

export const randomAnonName = (): string => `Anonymous ${NOUNS[randomInt(NOUNS.length)]}`;
/** The name a user id has until it is renamed: fixed by the id, so it needs no row in the database. */
export function anonNameFor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return `Anonymous ${NOUNS[(h >>> 0) % NOUNS.length]}`;
}
/**
 * The current form of a generated name: "Anon X" becomes "Anonymous X", and a noun that left the list
 * gets a new random one. People never type these forms, so rewriting them is safe. Other names pass through.
 */
export const currentAnonName = (name: string): string => {
  const m = /^Anon(?:ymous)? ([A-Za-z-]+)$/.exec(name);
  if (!m) return name;
  return NOUNS.includes(m[1]) ? `Anonymous ${m[1]}` : randomAnonName();
};
export const newAnonId = (): string => randomBase62(22);
/** User ids have the same shape as link tokens; they tell people apart and grant nothing. */
export const isUserId = (s: string): boolean => TOKEN_RE.test(s);

/**
 * A user's secret: `<user id>.<signature>`, the signature an HMAC of the id under the server's key. It is the only
 * credential for writing as that user, and carries the id, so one paste logs a person in anywhere.
 * Signed, so nothing per user is stored to check it and nobody can make one for an id without the key.
 */
export const userSecret = (id: string, key: string): string =>
  `${id}.${createHmac('sha256', key).update(id).digest('base64url').slice(0, 32)}`;

/** The user id inside a valid secret, or null for anything forged, truncated or malformed. */
export function idFromSecret(secret: string, key: string): string | null {
  const dot = secret.indexOf('.');
  const id = secret.slice(0, dot);
  if (dot < 0 || !isUserId(id)) return null;
  const given = Buffer.from(secret);
  const expected = Buffer.from(userSecret(id, key));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}
