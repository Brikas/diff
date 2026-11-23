import { Change, diff } from '@codemirror/merge';
import { diffArrays, diffWordsWithSpace } from 'diff';

export type Granularity = 'smart' | 'word' | 'char';

// Above this many changed characters the full diff gives up and falls back to a faster, coarser one.
const LIMITS = { scanLimit: 2000, timeout: 400 };
const PAIR_SIMILARITY = 0.2;     // wikidiff2 change_threshold: below it, two lines are a delete plus an insert
const MOVE_SIMILARITY = 0.4;     // wikidiff2 moved_line_threshold
const MOVE_MIN_ALNUM = 12;       // git uses 20 (COLOR_MOVED_MIN_ALNUM_COUNT) for code; bullet lines are shorter
const MAX_HUNK_PAIRING = 60;     // lines per side above which a hunk is paired by position instead of by similarity
const MAX_MOVE_CANDIDATES = 100; // wikidiff2 moved_paragraph_detection_cutoff
const BLANK_PAIR = 0.01;         // under any real pair's score, so blank lines never steer the alignment
const RESTRUCTURE_SIMILARITY = 0.5; // a hunk keeping at least half its words is diffed as one text
const INLINE_SIMILARITY = 0.5;      // a paired line keeping at least half its words shows its edits in place
const SURVIVING_WORDS = 0.6;        // an unpaired line with this share of its words elsewhere in the hunk was restructured

const visible = (s: string) => s.replace(/\s+/g, '').length;
const alnumCount = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

/**
 * wikidiff2 `charSimilarity`: visible characters kept ÷ all visible characters of a word diff.
 * A removed run next to an added run counts once, sized by the longer side. Whitespace does not count.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return a.trim() ? 1 : 0;
  let copied = 0;
  let total = 0;
  let removed = 0;
  let added = 0;
  const flush = () => { total += Math.max(removed, added); removed = 0; added = 0; };
  for (const part of diffWordsWithSpace(a, b)) {
    const n = visible(part.value);
    if (part.removed) removed += n;
    else if (part.added) added += n;
    else { flush(); copied += n; total += n; }
  }
  flush();
  return total === 0 ? 0 : copied / total;
}

/**
 * diff-match-patch `cleanupSemantic`: an unchanged run shorter than the edits on both sides of it,
 * and inside one line, folds into one change. Stops "word soup" where only `the` and `a` survive.
 */
function mergeShortGaps(changes: readonly Change[], a: string, b: string): Change[] {
  const out: Change[] = [];
  for (const c of changes) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = a.slice(prev.toA, c.fromA);
      const prevSize = Math.max(prev.toA - prev.fromA, prev.toB - prev.fromB);
      const nextSize = Math.max(c.toA - c.fromA, c.toB - c.fromB);
      // A gap that opens a line (a list number, a bullet) is structure and always stays visible.
      const opensLine = a[prev.toA - 1] === '\n' || b[prev.toB - 1] === '\n';
      if (!gap.includes('\n') && !opensLine && gap.length <= Math.min(prevSize, nextSize)) {
        out[out.length - 1] = new Change(prev.fromA, c.toA, prev.fromB, c.toB);
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/** Whole words with their punctuation, and the whitespace between them, as separate tokens. */
const spaceTokens = (s: string) => s.match(/\s+|\S+/g) ?? [];

/** Token diff turned into CodeMirror's offset-based changes. Defaults to jsdiff's word tokens. */
function wordChanges(a: string, b: string, tokens?: (s: string) => string[]): Change[] {
  const out: Change[] = [];
  let posA = 0;
  let posB = 0;
  let open: Change | null = null;
  const parts = tokens
    ? diffArrays(tokens(a), tokens(b)).map((p) => ({ ...p, value: p.value.join('') }))
    : diffWordsWithSpace(a, b);
  for (const part of parts) {
    const len = part.value.length;
    if (!part.added && !part.removed) {
      if (open) { out.push(open); open = null; }
      posA += len;
      posB += len;
      continue;
    }
    open ??= new Change(posA, posA, posB, posB);
    if (part.removed) { posA += len; open = new Change(open.fromA, posA, open.fromB, open.toB); }
    else { posB += len; open = new Change(open.fromA, open.toA, open.fromB, posB); }
  }
  if (open) out.push(open);
  return out;
}

/** Letters and digits only: two runs with the same skeleton differ in punctuation or quotes alone. */
const skeleton = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

/**
 * Last passes over smart changes:
 * - whitespace holding a line break at either edge of a change becomes its own change, so "added words"
 *   and "added a blank line" read as two edits instead of one run with a break inside;
 * - a run whose letters did not change (straight to curly quotes, a comma) is narrowed to the characters that did.
 */
function refine(changes: readonly Change[], a: string, b: string): Change[] {
  const out: Change[] = [];
  const push = (c: Change) => { if (c.toA > c.fromA || c.toB > c.fromB) out.push(c); };
  for (const c of changes) {
    const remA = a.slice(c.fromA, c.toA);
    const remB = b.slice(c.fromB, c.toB);
    const headA = /^\s*/.exec(remA)![0];
    const headB = /^\s*/.exec(remB)![0];
    const tailA = remA.length > headA.length ? /\s*$/.exec(remA)![0] : '';
    const tailB = remB.length > headB.length ? /\s*$/.exec(remB)![0] : '';
    const pieces: Change[] = [];
    const breakAtEdge = (x: string, y: string) => (x.includes('\n') || y.includes('\n')) && x !== y;
    let fa = c.fromA, ta = c.toA, fb = c.fromB, tb = c.toB;
    // Text removed where only whitespace was added (or the reverse): the text change sits where the text was,
    // and the whitespace edit follows it, so a deleted sentence is never drawn at the start of the next line.
    const oneSideBlank = (remA.trim() === '') !== (remB.trim() === '');
    if (oneSideBlank && (remA + remB).includes('\n')) {
      let lead = 0;
      while (lead < remA.length && lead < remB.length && remA[lead] === remB[lead] && /\s/.test(remA[lead])) lead++;
      // Only whitespace holding a line break splits off; a plain space stays with its words.
      const tA = tailA.includes('\n') ? tailA.length : 0;
      const hA = headA.includes('\n') ? headA.length : 0;
      const hB = headB.includes('\n') ? headB.length : 0;
      const tB = tailB.includes('\n') ? tailB.length : 0;
      if (remB.trim() === '' && hA && !lead) {
        // Lines joined: the removed break comes first, then the words removed after it (a bullet marker).
        pieces.push(new Change(fa, fa + hA, fb, tb), new Change(fa + hA, ta, tb, tb));
      } else if (remB.trim() === '') {
        pieces.push(new Change(fa + lead, ta - tA, fb + lead, fb + lead), new Change(ta - tA, ta, fb + lead, tb));
      } else if (hB) {
        // A new paragraph: the break comes first, then the words that start after it.
        pieces.push(new Change(fa, ta, fb, fb + hB), new Change(ta, ta, fb + hB, tb));
      } else {
        pieces.push(new Change(fa + lead, fa + lead, fb + lead, tb - tB), new Change(fa + lead, ta, tb - tB, tb));
      }
      for (const p of pieces) if (a.slice(p.fromA, p.toA) !== b.slice(p.fromB, p.toB)) push(p);
      continue;
    }
    if (breakAtEdge(headA, headB) && (remA.trim() || remB.trim())) {
      pieces.push(new Change(fa, fa + headA.length, fb, fb + headB.length));
      fa += headA.length; fb += headB.length;
    }
    let tail: Change | null = null;
    if (breakAtEdge(tailA, tailB) && (remA.trim() || remB.trim()) && ta - tailA.length >= fa && tb - tailB.length >= fb) {
      tail = new Change(ta - tailA.length, ta, tb - tailB.length, tb);
      ta -= tailA.length; tb -= tailB.length;
    }
    pieces.push(new Change(fa, ta, fb, tb));
    if (tail) pieces.push(tail);
    for (const p of pieces) {
      const x = a.slice(p.fromA, p.toA);
      const y = b.slice(p.fromB, p.toB);
      if (x && y && skeleton(x) && skeleton(x) === skeleton(y)) {
        for (const d of diff(x, y)) push(new Change(p.fromA + d.fromA, p.fromA + d.toA, p.fromB + d.fromB, p.fromB + d.toB));
      } else push(p);
    }
  }
  return out;
}

/**
 * The exact words that changed inside one smart change, for the two-level (Layered) marking: the change is the
 * phrase, these are the strong parts of it. Unchanged words inside the phrase are left out. After VS Code's two
 * layers, "lines that got removed" and "text that got removed".
 */
function wordsWithin(c: Change, a: string, b: string): Change[] {
  const x = a.slice(c.fromA, c.toA);
  const y = b.slice(c.fromB, c.toB);
  if (!x || !y) return [c];
  return refine(wordChanges(x, y, spaceTokens), x, y).map((d) => new Change(c.fromA + d.fromA, c.fromA + d.toA, c.fromB + d.fromB, c.fromB + d.toB));
}

const inline: Record<Granularity, (a: string, b: string) => readonly Change[]> = {
  // Prose: a changed word is marked whole, punctuation included, and short unchanged gaps fold in.
  smart: (a, b) => {
    // Repeat until stable, as diff-match-patch does: merging small edits makes the next gap fold in too.
    let changes = wordChanges(a, b, spaceTokens);
    for (let n = -1; n !== changes.length;) { n = changes.length; changes = mergeShortGaps(changes, a, b); }
    return refine(changes, a, b);
  },
  word: (a, b) => wordChanges(a, b),
  char: (a, b) => diff(a, b, LIMITS),
};

type Line = { text: string; from: number; to: number }; // `to` includes the line break

function splitLines(s: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  while (from < s.length) {
    const nl = s.indexOf('\n', from);
    const to = nl < 0 ? s.length : nl + 1;
    out.push({ text: s.slice(from, nl < 0 ? s.length : nl), from, to });
    from = to;
  }
  return out;
}

/**
 * Aligns the removed and added lines of one hunk, keeping order, to maximise total similarity.
 * Pairs under PAIR_SIMILARITY are never made. Returns [removedIndex, addedIndex] pairs.
 */
function alignHunk(removed: Line[], added: Line[]): [number, number][] {
  const n = removed.length;
  const m = added.length;
  if (n === 0 || m === 0) return [];
  if (n > MAX_HUNK_PAIRING || m > MAX_HUNK_PAIRING) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < Math.min(n, m); i++) {
      if (similarity(removed[i].text, added[i].text) >= PAIR_SIMILARITY) pairs.push([i, i]);
    }
    return pairs;
  }
  const sim = removed.map((r) => added.map((a) => {
    // Two blank lines pair with a token score, so they stay unchanged without outweighing any real pair.
    if (!r.text.trim() && !a.text.trim()) return BLANK_PAIR;
    const s = similarity(r.text, a.text);
    return s >= PAIR_SIMILARITY ? s : 0;
  }));
  // score[i][j] = best total similarity aligning removed[i..] with added[j..]
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = sim[i][j] > 0 ? sim[i][j] + score[i + 1][j + 1] : -1;
      score[i][j] = Math.max(pair, score[i + 1][j], score[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (sim[i][j] > 0 && score[i][j] === sim[i][j] + score[i + 1][j + 1]) { pairs.push([i, j]); i++; j++; }
    else if (score[i][j] === score[i + 1][j]) i++;
    else j++;
  }
  return pairs;
}

/** `whole`: an entire line (paragraph); otherwise a run of text cut out of, or put into, an edited line. */
export type Span = { from: number; to: number; text: string; whole: boolean };
export type Move = { a: Span; b: Span; similarity: number };
/**
 * A changed region and how a single-column view should show it: `inline` reads best as the new text with
 * the removed words struck in place; otherwise the old lines go above the new ones as a block.
 */
export type Region = { fromA: number; toA: number; fromB: number; toB: number; inline: boolean };
/** `changes`: what changed, phrase by phrase. `words`: the exact words that changed inside those phrases. */
export type Analysis = { changes: Change[]; words: Change[]; moves: Move[]; regions: Region[] };
/** `home` names where a span was edited; two spans with the same home are an edit in place, never a move. */
type Candidate = Span & { home: string };

/** The removed or added run of an inner change, without its surrounding whitespace. */
function fragment(doc: string, from: number, to: number, home: string): Candidate | null {
  const raw = doc.slice(from, to);
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  return text ? { from: from + lead, to: from + lead + text.length, text, whole: false, home } : null;
}

/**
 * Prose-first diff, after wikidiff2: diff whole lines (paragraphs) first, pair the changed ones by
 * similarity, and diff inside paired lines only. Unpaired lines are whole deletions or insertions.
 * Moves are matched between unpaired lines and the runs removed from or added to paired lines, so a
 * sentence cut out of one paragraph and pasted into another counts as moved too.
 */
export function analyze(a: string, b: string, gran: Granularity): Analysis {
  const linesA = splitLines(a);
  const linesB = splitLines(b);
  const changes: Change[] = [];
  const words: Change[] = [];
  const regions: Region[] = [];
  const lonelyA: Candidate[] = [];
  const lonelyB: Candidate[] = [];
  let iA = 0;
  let iB = 0;
  let hunk = 0;
  // Lines compare by text alone: a last line without its line break still matches itself, so moving
  // something below it does not pull it into the change. The final line break is settled at the end.
  const parts = diffArrays(linesA.map((l) => l.text), linesB.map((l) => l.text));
  const changed = (q: number) => parts[q] && (parts[q].added || parts[q].removed);
  // An unchanged run of blank lines between two changes carries no content, so it must not split them
  // into separate hunks (diff-match-patch semantic cleanup, at line level).
  const blankBridge = (q: number) => !changed(q) && changed(q - 1) && changed(q + 1) && parts[q].value.every((l) => !l.trim());
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    if (!part.added && !part.removed) { iA += part.count ?? part.value.length; iB += part.count ?? part.value.length; continue; }
    // A hunk is a run of removed and added parts between two unchanged runs.
    const removed: Line[] = [];
    const added: Line[] = [];
    for (; p < parts.length && (changed(p) || blankBridge(p)); p++) {
      const count = parts[p].count ?? parts[p].value.length;
      if (!changed(p)) {
        removed.push(...linesA.slice(iA, iA + count)); iA += count;
        added.push(...linesB.slice(iB, iB + count)); iB += count;
      } else if (parts[p].removed) { removed.push(...linesA.slice(iA, iA + count)); iA += count; }
      else { added.push(...linesB.slice(iB, iB + count)); iB += count; }
    }
    p--;
    let startA = removed[0]?.from ?? (linesA[iA]?.from ?? a.length);
    let startB = added[0]?.from ?? (linesB[iB]?.from ?? b.length);
    // Lines added after a last line that has no line break also add the break before them; likewise for removal.
    if (!removed.length && a.length && startA === a.length && !a.endsWith('\n')) startB--;
    if (!added.length && b.length && startB === b.length && !b.endsWith('\n')) startA--;
    const endA = removed.at(-1)?.to ?? startA;
    const endB = added.at(-1)?.to ?? startB;
    /** Word-level changes over one stretch of both texts; each change is its own home for moves. */
    const diffInside = (fromA: number, toA: number, fromB: number, toB: number) => {
      for (const c of inline[gran](a.slice(fromA, toA), b.slice(fromB, toB))) {
        const ch = new Change(fromA + c.fromA, fromA + c.toA, fromB + c.fromB, fromB + c.toB);
        changes.push(ch);
        words.push(...(gran === 'smart' ? wordsWithin(ch, a, b) : [ch]));
        const home = `${ch.fromA}:${ch.fromB}`;
        const fa = fragment(a, ch.fromA, ch.toA, home);
        const fb = fragment(b, ch.fromB, ch.toB, home);
        if (fa) lonelyA.push(fa);
        if (fb) lonelyB.push(fb);
      }
    };
    const pairs = alignHunk(removed, added);
    // A restructure: a line left without a partner whose words live on in the other side's lines
    // (a paragraph split or merged, bullets turned into prose). Diffing the hunk as one text marks only
    // the words and breaks that changed. A line whose words are gone is a real deletion and stays one.
    const textA = a.slice(startA, endA);
    const textB = b.slice(startB, endB);
    const pairedR = new Set(pairs.map((p) => p[0]));
    const pairedD = new Set(pairs.map((p) => p[1]));
    const survives = (line: string, other: string) => {
      const words = skeleton(line).split(' ').filter(Boolean);
      const there = new Set(skeleton(other).split(' '));
      return words.length > 0 && words.filter((w) => there.has(w)).length / words.length >= SURVIVING_WORDS;
    };
    const restructured = removed.length > 0 && added.length > 0
      && (removed.some((l, i) => !pairedR.has(i) && survives(l.text, textB)) || added.some((l, i) => !pairedD.has(i) && survives(l.text, textA)))
      && similarity(textA, textB) >= RESTRUCTURE_SIMILARITY;
    if (restructured) {
      diffInside(startA, endA, startB, endB);
      regions.push({ fromA: startA, toA: endA, fromB: startB, toB: endB, inline: true });
      hunk++;
      continue;
    }
    let r = 0;
    let d = 0;
    let posA = startA;
    let posB = startB;
    const emit = (until: [number, number] | null) => {
      const stopR = until ? until[0] : removed.length;
      const stopD = until ? until[1] : added.length;
      const fromA = posA;
      const fromB = posB;
      // Unpaired lines can move even within their hunk: alignment keeps order, so a reordered line stays unpaired.
      for (; r < stopR; r++) { lonelyA.push({ ...removed[r], whole: true, home: `a${removed[r].from}` }); posA = removed[r].to; }
      for (; d < stopD; d++) { lonelyB.push({ ...added[d], whole: true, home: `b${added[d].from}` }); posB = added[d].to; }
      if (posA > fromA || posB > fromB) {
        // Whole lines removed or added: every word in them changed, so the phrase is the word level too.
        const ch = new Change(fromA, posA, fromB, posB);
        changes.push(ch);
        words.push(ch);
        regions.push({ fromA, toA: posA, fromB, toB: posB, inline: false });
      }
    };
    for (const pair of pairs) {
      emit(pair);
      const la = removed[pair[0]];
      const lb = added[pair[1]];
      // Two identical lines (blank lines paired across a hunk) are no change at all.
      if (a.slice(la.from, la.to) !== b.slice(lb.from, lb.to)) {
        diffInside(la.from, la.to, lb.from, lb.to);
        // A line mostly rewritten reads better as old above new than as struck and inserted words interleaved.
        regions.push({ fromA: la.from, toA: la.to, fromB: lb.from, toB: lb.to, inline: similarity(la.text, lb.text) >= INLINE_SIMILARITY });
      }
      r = pair[0] + 1;
      d = pair[1] + 1;
      posA = la.to;
      posB = lb.to;
    }
    emit(null);
    hunk++;
  }
  // Only the final line break differs, after lines that otherwise match.
  const nlA = a.endsWith('\n');
  const nlB = b.endsWith('\n');
  const last = parts.at(-1);
  if (nlA !== nlB && last && !last.added && !last.removed) {
    const ch = new Change(nlA ? a.length - 1 : a.length, a.length, nlB ? b.length - 1 : b.length, b.length);
    changes.push(ch);
    words.push(ch);
    regions.push({ ...ch, inline: true });
  }
  return { changes, words, moves: extendBlocks(findMoves(lonelyA, lonelyB), lonelyA, lonelyB), regions };
}

/**
 * git's moved blocks: a line next to a moved line, whose counterpart sits next to the moved copy, moved with it,
 * even when it is too short to count as a move alone (a bullet heading carried along with its children).
 */
function extendBlocks(moves: Move[], linesA: Candidate[], linesB: Candidate[]): Move[] {
  const used = new Set(moves.flatMap((m) => [`a${m.a.from}`, `b${m.b.from}`]));
  const at = (list: Candidate[], pos: number, side: 'from' | 'to') => list.find((l) => l.whole && l[side] === pos && l.text.trim());
  const out = [...moves];
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (!m.a.whole || !m.b.whole) continue;
    // A whole line's span ends after its line break, so neighbours start at `to` and end at `from`.
    for (const [nextA, nextB] of [
      [at(linesA, m.a.to, 'from'), at(linesB, m.b.to, 'from')],
      [at(linesA, m.a.from, 'to'), at(linesB, m.b.from, 'to')],
    ]) {
      if (!nextA || !nextB || used.has(`a${nextA.from}`) || used.has(`b${nextB.from}`)) continue;
      const s = similarity(nextA.text, nextB.text);
      if (s <= MOVE_SIMILARITY) continue;
      used.add(`a${nextA.from}`);
      used.add(`b${nextB.from}`);
      out.push({ a: strip(nextA), b: strip(nextB), similarity: s }); // its own neighbours get checked in turn
    }
  }
  return out;
}

/** Moved text: removed and added spans from different homes, similar enough and long enough. One move per span. */
function findMoves(from: Candidate[], to: Candidate[]): Move[] {
  const fa = from.filter((p) => alnumCount(p.text) >= MOVE_MIN_ALNUM);
  const tb = to.filter((p) => alnumCount(p.text) >= MOVE_MIN_ALNUM);
  if (fa.length > MAX_MOVE_CANDIDATES || tb.length > MAX_MOVE_CANDIDATES) return [];
  const candidates: Move[] = [];
  for (const x of fa) {
    for (const y of tb) {
      if (x.home === y.home) continue;
      const short = Math.min(visible(x.text), visible(y.text));
      const long = Math.max(visible(x.text), visible(y.text));
      if (short / long <= MOVE_SIMILARITY) continue; // cannot reach the threshold; skip the word diff
      const s = similarity(x.text, y.text);
      if (s > MOVE_SIMILARITY) candidates.push({ a: strip(x), b: strip(y), similarity: s });
    }
  }
  candidates.sort((p, q) => q.similarity - p.similarity);
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  return candidates.filter((m) => {
    const ka = `${m.a.from}:${m.a.to}`;
    const kb = `${m.b.from}:${m.b.to}`;
    if (usedA.has(ka) || usedB.has(kb)) return false;
    usedA.add(ka);
    usedB.add(kb);
    return true;
  });
}

const strip = ({ from, to, text, whole }: Candidate): Span => ({ from, to, text, whole });

/** Changes inside one pair of lines, e.g. a moved paragraph against where it came from. */
export const innerChanges = (a: string, b: string, gran: Granularity): readonly Change[] => inline[gran](a, b);

/** Override for CodeMirror's merge views. */
export const diffFor = (gran: Granularity) => (a: string, b: string): readonly Change[] => analyze(a, b, gran).changes;
