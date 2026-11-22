// Writes, per eval case, the engine's changes as text markup and git's word diff for reference.
// Usage: node eval/dump.ts <out-dir> <cases.json>...
// e.g.   node eval/dump.ts eval/out/r1 eval/cases-a.json eval/cases-b.json
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../web/diffing.ts';

type Case = { id: string; before: string; after: string };
const [out, ...files] = process.argv.slice(2);
if (!out || !files.length) throw new Error('usage: node eval/dump.ts <out-dir> <cases.json>...');

/** Smart-mode changes as `[-removed-]{+added+}` over the Before text, then the moves found. */
function markup(a: string, b: string): string {
  const { changes, moves } = analyze(a, b, 'smart');
  let s = '';
  let pos = 0;
  for (const c of changes) {
    s += a.slice(pos, c.fromA);
    if (c.toA > c.fromA) s += `[-${a.slice(c.fromA, c.toA)}-]`;
    if (c.toB > c.fromB) s += `{+${b.slice(c.fromB, c.toB)}+}`;
    pos = c.toA;
  }
  s += a.slice(pos);
  const mv = moves.map((m) => `MOVED (${m.a.whole ? 'line' : 'fragment'} -> ${m.b.whole ? 'line' : 'fragment'}): ${JSON.stringify(m.a.text.slice(0, 80))}`);
  return `${s}\n\n=== ${changes.length} changes, ${moves.length} moves ===\n${mv.join('\n')}\n`;
}

/** git's word diff of the same pair; exit code 1 just means "differs". */
function gitWordDiff(a: string, b: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffeval-'));
  writeFileSync(join(dir, 'before'), a);
  writeFileSync(join(dir, 'after'), b);
  try {
    execFileSync('git', ['diff', '--no-index', '--word-diff=plain', '--color-moved=no', '-U1000', 'before', 'after'], { cwd: dir, encoding: 'utf8' });
    return '(identical)\n';
  } catch (e: any) {
    if (e.status !== 1) throw e;
    return String(e.stdout).split('\n').slice(5).join('\n');
  }
}

let n = 0;
for (const f of files) {
  for (const c of JSON.parse(readFileSync(f, 'utf8')) as Case[]) {
    const dir = join(out, c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ours.txt'), markup(c.before, c.after));
    writeFileSync(join(dir, 'git.txt'), gitWordDiff(c.before, c.after));
    n++;
  }
}
console.log(`dumped ${n} cases into ${out}`);
