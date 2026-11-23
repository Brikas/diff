// One-column view of a diff, drawn from the engine's regions instead of CodeMirror's chunks.
// The editor holds the After text. Small edits show the removed words struck in place, git word-diff style;
// rewritten or deleted lines show above the new ones as a block. Moves and whitespace edits get markers.
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField, type Range } from '@codemirror/state';
import type { Change } from '@codemirror/merge';
import type { Analysis, Move, Span } from './diffing.ts';

export const setUnified = StateEffect.define<DecorationSet>();
export const unifiedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    for (const e of tr.effects) if (e.is(setUnified)) return e.value;
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const isBlank = (s: string) => !s.trim();
const within = (c: { from: number; to: number }, s: Span) => c.from < s.to && c.to > s.from;

/** Removed text, with line breaks drawn as ¶ so a joined paragraph is visible. */
function fillDeleted(parent: HTMLElement, text: string) {
  const parts = text.split('\n');
  parts.forEach((p, i) => {
    if (p) parent.append(p);
    if (i < parts.length - 1) parent.append(glyphNode('¶', 'Line break removed'));
  });
}

function glyphNode(symbol: string, title: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'cm-wsGlyph';
  s.textContent = symbol;
  s.title = title;
  return s;
}

const breaks = (s: string) => (s.match(/\n/g) ?? []).length;
/** Whether a whitespace-only change adds or removes line breaks, the edit the reader cannot otherwise see. */
export const changesBreaks = (removed: string, added: string) => breaks(removed) !== breaks(added);

/** Which marker a whitespace-only change gets, and what it says. */
export function whitespaceGlyph(removed: string, added: string, atLineStart: boolean): [string, string] {
  const diff = breaks(added) - breaks(removed);
  if (diff > 0) return ['¶', diff === 1 ? 'Line break added' : `${diff} line breaks added`];
  if (diff < 0) return ['¶', diff === -1 ? 'Line break removed' : `${-diff} line breaks removed`];
  // Same breaks: what differs is the indent of the next line, or spacing inside or at the end of a line.
  const indentA = /\n([ \t]*)$/.exec(removed)?.[1];
  const indentB = /\n([ \t]*)$/.exec(added)?.[1];
  if (indentA !== undefined && indentB !== undefined && indentA !== indentB) return ['⇥', indentB.length > indentA.length ? 'Indented' : 'Outdented'];
  if (atLineStart && !removed.includes('\n')) return ['⇥', added.length > removed.length ? 'Indented' : 'Outdented'];
  return ['␣', 'Spacing changed'];
}

class Glyph extends WidgetType {
  readonly symbol: string;
  readonly title: string;
  constructor(symbol: string, title: string) { super(); this.symbol = symbol; this.title = title; }
  eq(o: Glyph) { return o.symbol === this.symbol && o.title === this.title; }
  toDOM() { return glyphNode(this.symbol, this.title); }
}
export const glyph = (symbol: string, title: string) => Decoration.widget({ widget: new Glyph(symbol, title), side: -1 });

const SOURCE_PREVIEW = 48; // characters of moved text kept at its old place; the full text is at the new one
const preview = (t: string) => { const s = t.trim().replace(/\s+/g, ' '); return s.length > SOURCE_PREVIEW ? `${s.slice(0, SOURCE_PREVIEW - 1).trimEnd()}…` : s; };

/** Where moved text used to be: a tag pointing at its new place and a short dim preview, so it is read once. */
function movedSource(text: string, arrow: string, tag = true): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'cm-movedFrom';
  wrap.title = `Moved ${arrow === '↓' ? 'down' : 'up'} from here`;
  if (tag) wrap.append(badge(`moved ${arrow}`));
  wrap.append(Object.assign(document.createElement('span'), { className: 'cm-movedPreview', textContent: preview(text) }));
  return wrap;
}

class InlineDel extends WidgetType {
  readonly text: string;
  readonly arrow: string; // '' when the text was removed, '↓' or '↑' when it moved
  readonly words: [number, number][] | null; // Layered: the removed words, strong; the rest of the phrase light
  constructor(text: string, arrow: string, words: [number, number][] | null = null) { super(); this.text = text; this.arrow = arrow; this.words = words; }
  eq(o: InlineDel) { return o.text === this.text && o.arrow === this.arrow && JSON.stringify(o.words) === JSON.stringify(this.words); }
  toDOM() {
    if (this.arrow) return movedSource(this.text, this.arrow);
    const el = document.createElement('del');
    if (!this.words) {
      el.className = 'cm-deletedText';
      fillDeleted(el, this.text);
      return el;
    }
    el.className = 'cm-deletedSoft';
    let at = 0;
    for (const [f, t] of this.words) {
      if (f > at) fillDeleted(el, this.text.slice(at, f));
      const hit = el.appendChild(document.createElement('span'));
      hit.className = 'cm-deletedHit';
      fillDeleted(hit, this.text.slice(f, t));
      at = t;
    }
    if (at < this.text.length) fillDeleted(el, this.text.slice(at));
    return el;
  }
}

/** Old lines shown above their replacement. `marks` are the removed runs inside them, struck harder; `moved` maps a line to its arrow. */
class DeletedBlock extends WidgetType {
  readonly text: string;
  readonly marks: [number, number][];
  readonly moved: Map<number, string>;
  constructor(text: string, marks: [number, number][], moved: Map<number, string>) { super(); this.text = text; this.marks = marks; this.moved = moved; }
  eq(o: DeletedBlock) {
    return o.text === this.text && JSON.stringify(o.marks) === JSON.stringify(this.marks) && JSON.stringify([...o.moved]) === JSON.stringify([...this.moved]);
  }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-deletedChunk';
    let pos = 0;
    this.text.replace(/\n$/, '').split('\n').forEach((line, i) => {
      const row = box.appendChild(document.createElement('div'));
      row.className = 'cm-deletedLine';
      const arrow = this.moved.get(i);
      if (arrow) {
        row.classList.add('cm-movedRow');
        // One tag per moved block: a row continuing the block above shows its preview only.
        row.append(movedSource(line, arrow, this.moved.get(i - 1) !== arrow));
        pos += line.length + 1;
        return;
      }
      const del = row.appendChild(document.createElement('del'));
      let at = pos;
      const end = pos + line.length;
      for (const [f, t] of this.marks) {
        const from = Math.max(f, at);
        const to = Math.min(t, end);
        if (from >= to) continue;
        if (from > at) del.append(this.text.slice(at, from));
        const hit = del.appendChild(document.createElement('span'));
        hit.className = 'cm-deletedText';
        hit.textContent = this.text.slice(from, to);
        at = to;
      }
      if (end > at) del.append(this.text.slice(at, end));
      if (!line) del.appendChild(document.createElement('br'));
      pos = end + 1;
    });
    return box;
  }
  get estimatedHeight() { return 28 * this.text.split('\n').length; }
}

function badge(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'cm-movedBadge';
  s.textContent = text;
  return s;
}

/**
 * Decorations for the After text against `a`, from an analysis of the two. `movedMarks` draws the new place of
 * a move; `lostWords` gives the words a moved text lost on the way, struck at its new place.
 */
export function unifiedDecorations(
  a: string, b: string, { changes, words, moves, regions }: Analysis,
  movedMarks: (m: Move) => Range<Decoration>[], lostWords: (m: Move) => { at: number; text: string }[], layered: boolean,
): DecorationSet {
  const out: Range<Decoration>[] = [];
  const movedB = moves.map((m) => m.b);
  const added = Decoration.mark({ class: 'cm-changedText' });
  const addedSoft = Decoration.mark({ class: 'cm-changedSoft' });
  const wordsIn = (c: { fromA: number; toA: number; fromB: number; toB: number }) =>
    words.filter((w) => w.fromA >= c.fromA && w.toA <= c.toA && w.fromB >= c.fromB && w.toB <= c.toB);
  const addedLine = Decoration.line({ class: 'cm-insertedLine' });
  const lineStart = (pos: number) => b.lastIndexOf('\n', pos - 1) + 1;
  const inRegion = (c: Change, r: { fromA: number; toA: number; fromB: number; toB: number }) =>
    c.fromA >= r.fromA && c.toA <= r.toA && c.fromB >= r.fromB && c.toB <= r.toB;
  /** The arrow from a spot in After toward where the text at `from..to` in Before moved, or '' if it did not. */
  const arrowFor = (from: number, to: number, here: number) => {
    const m = moves.find((x) => within({ from, to }, x.a));
    return m ? (m.b.from >= here ? '↓' : '↑') : '';
  };

  for (const r of regions) {
    const inner = changes.filter((c) => inRegion(c, r));
    if (r.inline) {
      for (const c of inner) {
        const del = a.slice(c.fromA, c.toA);
        const ins = b.slice(c.fromB, c.toB);
        if (isBlank(del) && isBlank(ins)) {
          const [s, t] = whitespaceGlyph(del, ins, c.fromB === lineStart(c.fromB));
          out.push(glyph(s, t).range(c.fromB));
          continue;
        }
        // Layered: the phrase light, the words that changed inside it strong. Solid: the phrase strong.
        const inner = layered ? wordsIn(c) : [];
        if (del) {
          const hits = layered ? inner.filter((w) => w.toA > w.fromA).map((w): [number, number] => [w.fromA - c.fromA, w.toA - c.fromA]) : null;
          out.push(Decoration.widget({ widget: new InlineDel(del, arrowFor(c.fromA, c.toA, c.fromB), hits), side: -1 }).range(c.fromB));
        }
        if (c.toB > c.fromB && !movedB.some((s) => within({ from: c.fromB, to: c.toB }, s))) {
          if (!layered) { out.push(added.range(c.fromB, c.toB)); continue; }
          out.push(addedSoft.range(c.fromB, c.toB));
          for (const w of inner) if (w.toB > w.fromB && b.slice(w.fromB, w.toB).trim()) out.push(added.range(w.fromB, w.toB));
        }
      }
      continue;
    }
    // Only blank lines came or went: a marker, not an empty tinted band.
    const textA = a.slice(r.fromA, r.toA);
    const textB = b.slice(r.fromB, r.toB);
    if (isBlank(textA) && isBlank(textB)) {
      const [s, t] = whitespaceGlyph(textA, textB, true);
      out.push(glyph(s, t).range(lineStart(Math.min(r.fromB, b.length))));
      continue;
    }
    // Block: old lines above, new lines tinted.
    if (r.toA > r.fromA) {
      const moved = new Map<number, string>();
      textA.replace(/\n$/, '').split('\n').reduce((pos, line, i) => {
        const arrow = line.trim() ? arrowFor(r.fromA + pos, r.fromA + pos + line.length, r.fromB) : '';
        if (arrow) moved.set(i, arrow);
        return pos + line.length + 1;
      }, 0);
      const marks = (layered ? wordsIn(r) : inner).filter((c) => c.toA > c.fromA && (c.fromA > r.fromA || c.toA < r.toA))
        .map((c): [number, number] => [c.fromA - r.fromA, c.toA - r.fromA]);
      // Lines removed after the last line, when that line has no break, hang below it instead of above.
      const below = !!b && r.fromB >= b.length && !b.endsWith('\n');
      const widget = new DeletedBlock(textA, marks, moved);
      out.push(Decoration.widget({ widget, block: true, side: below ? 1 : -1 }).range(below ? b.length : lineStart(r.fromB)));
    }
    if (r.toB > r.fromB) {
      for (let pos = r.fromB; pos < r.toB;) {
        const end = b.indexOf('\n', pos);
        if (!movedB.some((s) => s.whole && s.from === pos)) out.push(addedLine.range(pos));
        pos = end < 0 ? r.toB : end + 1;
      }
      for (const c of layered ? wordsIn(r) : inner) {
        // Only edits inside a kept line are marked; a wholly new line is already tinted.
        if (c.toB > c.fromB && (c.fromB > r.fromB || c.toB < r.toB)) out.push(added.range(c.fromB, c.toB));
      }
    }
  }
  for (const m of moves) {
    out.push(...movedMarks(m));
    for (const l of lostWords(m)) out.push(Decoration.widget({ widget: new InlineDel(l.text, ''), side: -1 }).range(l.at));
  }
  return Decoration.set(out, true);
}
