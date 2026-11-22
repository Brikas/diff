import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, similarity, type Granularity } from '../web/diffing.ts';

const BEFORE = `Our webinar platform helps marketing teams turn every session into pipeline. It is easy to set up and works with your CRM.

We moved this paragraph about pricing because it is important to show it at the end of the page for all customers.

Book a demo today.`;
const AFTER = `We moved this paragraph about pricing because it is important to show it at the end of the page for all customers.

Our webinar platform helps B2B marketing teams turn every session into qualified pipeline. It is simple to set up and syncs with your CRM.

Book a demo today and see it live.`;
const MODES: Granularity[] = ['smart', 'word', 'char'];

/** Applying the changes to `a` must give `b`; otherwise the merge view would render nonsense. */
function apply(a: string, b: string, changes: { fromA: number; toA: number; fromB: number; toB: number }[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    assert.ok(c.fromA >= pos, 'changes must be ordered and not overlap');
    out += a.slice(pos, c.fromA) + b.slice(c.fromB, c.toB);
    pos = c.toA;
  }
  return out + a.slice(pos);
}

test('similarity ignores whitespace: identical 1, unrelated 0, light edit high', () => {
  assert.equal(similarity('same words here', 'same words here'), 1);
  assert.equal(similarity('alpha beta', 'gamma delta'), 0);
  assert.ok(similarity('It is easy to set up and works with your CRM.', 'It is simple to set up and syncs with your CRM.') > 0.6);
});

test('changes reproduce the edited text in every mode', () => {
  const cases: [string, string][] = [
    [BEFORE, AFTER], ['', 'new'], ['old', ''], ['a\nb\nc', 'a\nc'], ['no newline', 'no newline\n'],
    ['one two three', 'one 2 three'], ['line\n\n\nline', 'line\nline'],
    ['x', 'x\ny'], ['x\ny', 'x'], ['x\ny\n', 'x'], ['x', 'x\ny\n'], ['x\ny', 'x\ny\n'], ['a\nb', 'b\na'],
    ['First para one. Second sentence here.', 'First para one.\n\nSecond sentence here.'],
    ['- one\n- two\n- three', '- one\n  - two\n- three'],
  ];
  for (const mode of MODES) for (const [a, b] of cases) assert.equal(apply(a, b, analyze(a, b, mode).changes), b, `${mode}: ${JSON.stringify([a, b])}`);
});

test('reordered paragraphs are reported as moved in every mode', () => {
  for (const mode of MODES) {
    const { moves } = analyze(BEFORE, AFTER, mode);
    const texts = moves.map((m) => m.a.text.slice(0, 20)).sort();
    assert.ok(texts.includes('Our webinar platform'), `${mode}: ${JSON.stringify(texts)}`);
  }
});

test('an edit in place is not a move; an unrelated rewrite is a delete plus insert', () => {
  const edited = analyze('The quick brown fox jumps over the lazy dog today.', 'The quick red fox jumps over the lazy dog today.', 'smart');
  assert.equal(edited.moves.length, 0);
  assert.equal(edited.changes.length, 1);
  const rewritten = analyze('Completely different sentence about invoices and taxes.', 'A new line on webinars, pipeline and the CRM.', 'smart');
  assert.deepEqual(rewritten.changes.map((c) => [c.fromA, c.toA, c.fromB, c.toB]), [[0, 55, 0, 45]]);
});

test('a sentence cut out of an edited paragraph into its own line is moved in every mode', () => {
  const a = 'We are concerned about retention. The points about the information sheet we would like to address are:\n1. Assuming it is necessary to mention retention.\n2. Can we add an option to withdraw?\n\n\nBest, Elias.';
  const b = 'We are concerned about retention.\n1. Test it is necessary to mention retention.\n2. Can we add an option to withdraw?\n\nThe points about the information sheet we would like to address are:\n\nBest, Elias.';
  for (const mode of MODES) {
    const { moves, changes } = analyze(a, b, mode);
    assert.equal(apply(a, b, changes), b, mode);
    const m = moves.find((x) => x.a.text.startsWith('The points'));
    assert.ok(m, `${mode}: ${JSON.stringify(moves)}`);
    assert.equal(m.a.whole, false);
    assert.equal(m.b.whole, true);
    assert.equal(a.slice(m.a.from, m.a.to), 'The points about the information sheet we would like to address are:');
    assert.ok(!moves.some((x) => x.a.text.startsWith('Assuming')), `${mode}: a word swapped in place is not a move`);
  }
});

test('a blank line left unchanged between edits does not split them, so edited lines still pair', () => {
  const a = 'Intro paragraph about the webinar series. Closing sentence moved later.\n1. Assuming the first point is right.\n2. The second point stays mostly.\n\nThanks.';
  const b = 'Intro paragraph about the webinar series.\n\n1. Test the first point is right.\n2. The second point stays mostly.\n\nClosing sentence moved later.\n\nThanks.';
  for (const mode of MODES) {
    const { changes } = analyze(a, b, mode);
    assert.equal(apply(a, b, changes), b, mode);
    const removed = changes.map((c) => a.slice(c.fromA, c.toA)).filter(Boolean);
    assert.ok(removed.every((t) => !t.includes('first point')), `${mode}: ${JSON.stringify(removed)}`);
  }
});

test('a moved bullet subtree moves as a block, its short heading included', () => {
  const a = '- Project\n  - Training\n    - Record walkthrough video\n    - Schedule live session\n  - Handover\n- Renewals\n  - Review usage data';
  const b = '- Project\n  - Handover\n- Renewals\n  - Review usage data\n  - Training\n    - Record walkthrough video\n    - Schedule live session';
  const moved = analyze(a, b, 'smart').moves.map((m) => m.a.text.trim()).sort();
  assert.deepEqual(moved, ['- Record walkthrough video', '- Schedule live session', '- Training']);
});

test('a deleted parent stays a deleted line; its promoted children only change indent', () => {
  const a = '- Website\n  - Content updates\n    - Replace hero image\n    - Update team page\n  - SEO';
  const b = '- Website\n  - Replace hero image\n  - Update team page\n  - SEO';
  const { changes } = analyze(a, b, 'smart');
  const removed = changes.map((c) => a.slice(c.fromA, c.toA));
  assert.ok(removed.includes('  - Content updates\n'), JSON.stringify(removed));
  for (const c of changes) assert.equal(b.slice(c.fromB, c.toB).trim(), '', 'nothing but whitespace is added');
});

test('smart marks only the quote characters when letters stay the same, and splits a new blank line off added words', () => {
  const quotes = analyze('She said "we can\'t".', 'She said “we can’t”.', 'smart').changes;
  assert.ok(quotes.every((c) => c.toA - c.fromA <= 1 && c.toB - c.fromB <= 1), JSON.stringify(quotes));
  const a = '- Book the van\n- Forward the mail';
  const b = '- Book the van for Saturday\n\n- Forward the mail';
  const parts = analyze(a, b, 'smart').changes.map((c) => b.slice(c.fromB, c.toB));
  assert.ok(parts.includes(' for Saturday'), JSON.stringify(parts));
});

test('lines under 12 letters are never reported as moved', () => {
  const { moves } = analyze('Hello there.\nMiddle paragraph stays the same here.\nEnd.', 'End.\nMiddle paragraph stays the same here.\nHello there.', 'smart');
  for (const m of moves) assert.ok((m.a.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 12, m.a.text);
});
