import { EditorView, keymap, placeholder, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { EditorState, Compartment, StateEffect, StateField, Annotation, type Extension } from '@codemirror/state';
import { defaultKeymap, history as undoHistory, historyKeymap } from '@codemirror/commands';
import { MergeView } from '@codemirror/merge';
import { api, ApiError, type VersionMeta, type VersionFull, type SaveResult } from './api.ts';
import { analyze, diffFor, innerChanges, type Analysis, type Granularity, type Move, type Span } from './diffing.ts';
import { changesBreaks, glyph, setUnified, unifiedDecorations, unifiedField, whitespaceGlyph } from './unified.ts';
import { avatar } from './avatar.ts';
import { renderAgentPop } from './agent.ts';
import { formatCombo, installShortcuts, renderShortcutList, type Shortcut } from './keys.ts';

// ── DOM ──────────────────────────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  editor: $('editor'), status: $('status'), banner: $('banner'), bannerText: $('bannerText'), bannerActions: $('bannerActions'),
  historyBtn: $<HTMLButtonElement>('historyBtn'), shareBtn: $<HTMLButtonElement>('shareBtn'), meBtn: $<HTMLButtonElement>('meBtn'),
  history: $('history'), historyClose: $('historyClose'), versionList: $('versionList'), namedOnly: $<HTMLInputElement>('namedOnly'),
  nameForm: $<HTMLFormElement>('nameForm'), nameInput: $<HTMLInputElement>('nameInput'),
  versioningRow: $('versioningRow'), versioningToggle: $<HTMLInputElement>('versioningToggle'),
  sharePop: $('sharePop'), shareLink: $<HTMLInputElement>('shareLink'), copyBtn: $<HTMLButtonElement>('copyBtn'), shareNote: $('shareNote'),
  mePop: $('mePop'), meForm: $<HTMLFormElement>('meForm'), meInput: $<HTMLInputElement>('meInput'),
  labelA: $('labelA'), headB: $('headB'), delCount: $('delCount'), addCount: $('addCount'),
  copyEditBtn: $<HTMLButtonElement>('copyEditBtn'), accessBtn: $<HTMLButtonElement>('accessBtn'), accessPop: $('accessPop'),
  accessText: $('accessText'), ownerBadge: $('ownerBadge'),
  backupLink: $<HTMLButtonElement>('backupLink'), restoreLink: $<HTMLButtonElement>('restoreLink'), backupBox: $('backupBox'),
  secretField: $<HTMLInputElement>('secretField'), secretCopy: $<HTMLButtonElement>('secretCopy'),
  restoreBox: $<HTMLFormElement>('restoreBox'), restoreField: $<HTMLInputElement>('restoreField'),
  agentBtn: $<HTMLButtonElement>('agentBtn'), agentPop: $('agentPop'), keysBtn: $<HTMLButtonElement>('keysBtn'), keysPop: $('keysPop'),
};

// ── State ────────────────────────────────────────────────────────────────────────────────────────
type Layout = 'split' | 'unified';
const prefs = {
  layout: (localStorage.getItem('layout') as Layout) || 'split',
  gran: (localStorage.getItem('gran') as Granularity) || 'smart',
  // Layered: the changed phrase light, the words that changed strong. Solid: the whole phrase strong.
  marks: (localStorage.getItem('marks') as 'layered' | 'solid') || 'layered',
};
const state = {
  token: location.pathname.slice(1) || null as string | null,
  role: 'edit' as 'edit' | 'view',
  rev: 0,
  versioning: true,
  links: null as { edit?: string; view: string } | null,
  versions: [] as VersionMeta[],
  left: '',
  right: '',
  viewing: null as VersionFull | null, // an old version, shown read-only
  dirty: false,
  saving: false,
  blocked: false,                      // a conflict or limit is waiting for the user
  access: 'edit' as 'edit' | 'view',   // which link the share popover shows
};
const canEdit = () => state.role === 'edit' && !state.viewing && !state.blocked;

// ── Editors ──────────────────────────────────────────────────────────────────────────────────────
const external = Annotation.define<boolean>(); // marks programmatic document swaps so they do not autosave
const editable = new Compartment();
const setMoves = StateEffect.define<DecorationSet>();
const movesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    for (const e of tr.effects) if (e.is(setMoves)) return e.value;
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The "moved" tag after a sentence that moved; whole moved lines get it from CSS instead. */
class MovedBadge extends WidgetType {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-movedBadge';
    s.textContent = 'moved';
    return s;
  }
  eq() { return true; }
}
const movedBadge = new MovedBadge();

let merge: MergeView | null = null;
let unified: EditorView | null = null;

function editorExtensions(hint: string): Extension[] {
  return [
    undoHistory(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
    placeholder(hint),
    editable.of(editableExt()),
    movesField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) onEdit();
      // The merge view announces new chunks through effects; our own decoration effects must not loop back here.
      const foreign = u.transactions.some((t) => t.effects.some((e) => !e.is(setMoves) && !e.is(setUnified)));
      if (u.docChanged || foreign) scheduleMeta();
    }),
  ];
}

const editableExt = () => [EditorView.editable.of(canEdit()), EditorState.readOnly.of(!canEdit())];

function currentDocs(): { left: string; right: string } {
  if (merge) return { left: merge.a.state.doc.toString(), right: merge.b.state.doc.toString() };
  if (unified) return { left: state.left, right: unified.state.doc.toString() };
  return { left: state.left, right: state.right };
}

/** (Re)creates the editors for the current layout and granularity, keeping text and scroll. */
function mount() {
  const docs = state.viewing ? { left: state.viewing.left, right: state.viewing.right } : currentDocs();
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  merge?.destroy();
  unified?.destroy();
  merge = null;
  unified = null;
  el.editor.textContent = '';
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  const layout: Layout = narrow ? 'unified' : prefs.layout;
  const diffConfig = { override: diffFor(prefs.gran) };
  document.body.dataset.layout = layout;
  el.labelA.textContent = layout === 'unified' ? 'Changes' : 'Before';
  if (layout === 'split') {
    merge = new MergeView({
      a: { doc: docs.left, extensions: editorExtensions('Paste the original text') },
      b: { doc: docs.right, extensions: editorExtensions('Paste the edited text') },
      parent: el.editor, gutter: false, highlightChanges: true, diffConfig,
    });
  } else {
    state.left = docs.left;
    unified = new EditorView({
      doc: docs.right,
      parent: el.editor,
      extensions: [editorExtensions('Paste the edited text. Switch to Split to edit the original.'), unifiedField],
    });
  }
  document.scrollingElement?.scrollTo({ top: scroll });
  updateMeta();
}

/** Replaces both documents without triggering an autosave. */
function setDocs(left: string, right: string) {
  state.left = left;
  state.right = right;
  if (merge) {
    for (const [view, doc] of [[merge.a, left], [merge.b, right]] as const) {
      if (view.state.doc.toString() !== doc) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, annotations: external.of(true) });
      }
    }
  } else {
    // The unified view's original text is fixed at creation, so rebuild it; drop the old view first,
    // or mount() would read the old After text back out of it.
    unified?.destroy();
    unified = null;
    mount();
  }
}

function refreshEditable() {
  const views = merge ? [merge.a, merge.b] : unified ? [unified] : [];
  for (const v of views) v.dispatch({ effects: editable.reconfigure(editableExt()) });
  document.body.classList.toggle('readonly', !canEdit());
}

// ── Counts and moved paragraphs ──────────────────────────────────────────────────────────────────
let metaTimer = 0;
function scheduleMeta() {
  clearTimeout(metaTimer);
  metaTimer = window.setTimeout(updateMeta, 150);
}

// Moved text is blue; the words it lost or gained on the way are marked against its source (wikidiff2).
// A whole paragraph tints its line; a sentence cut out of or pasted into a paragraph tints its own run.
// `cont`: the line right above moved too, in the same block, so this one needs no tag of its own.
const movedDeco = (p: Span, title: string, cont = false) => p.whole
  ? [Decoration.line({ class: cont ? 'cm-moved cm-movedCont' : 'cm-moved', attributes: { title } }).range(p.from)]
  : [Decoration.mark({ class: 'cm-movedText', attributes: { title } }).range(p.from, p.to),
     Decoration.widget({ widget: movedBadge, side: 1 }).range(p.to)];
const lost = Decoration.mark({ class: 'cm-movedDel' });
const gained = Decoration.mark({ class: 'cm-movedAdd' });
const wordDel = Decoration.mark({ class: 'cm-wordDel' });
const wordAdd = Decoration.mark({ class: 'cm-wordAdd' });

/** Line starts that directly follow a moved whole line, on each side: those lines continue a moved block. */
let blockEnds = { a: new Set<number>(), b: new Set<number>() };

/** The After side of a move: its tint and tag, plus the words it gained on the way. */
function movedInB(m: Move) {
  const out = movedDeco(m.b, 'Moved here from another place in Before', blockEnds.b.has(m.b.from));
  for (const c of innerChanges(m.a.text, m.b.text, prefs.gran)) if (c.toB > c.fromB) out.push(gained.range(m.b.from + c.fromB, m.b.from + c.toB));
  return out;
}

let lastAnalysis: Analysis | null = null; // for jumping between changes
/** Recomputes counts, moves and whitespace markers for both layouts and hands them to the editors. */
function updateMeta() {
  if (!merge && !unified) return;
  const { left, right } = currentDocs();
  const analysis = analyze(left, right, prefs.gran);
  lastAnalysis = analysis;
  const whole = analysis.moves.filter((m) => m.a.whole && m.b.whole);
  blockEnds = { a: new Set(whole.map((m) => m.a.to)), b: new Set(whole.map((m) => m.b.to)) };
  let del = 0;
  let add = 0;
  for (const c of analysis.changes) { del += c.toA - c.fromA; add += c.toB - c.fromB; }
  el.delCount.textContent = del ? `−${del.toLocaleString('en')}` : '';
  el.addCount.textContent = add ? `+${add.toLocaleString('en')}` : '';
  if (unified) {
    const lostWords = (m: Move) => innerChanges(m.a.text, m.b.text, prefs.gran)
      .filter((c) => c.toA > c.fromA)
      .map((c) => ({ at: m.b.from + c.fromB, text: m.a.text.slice(c.fromA, c.toA) }));
    unified.dispatch({ effects: setUnified.of(unifiedDecorations(left, right, analysis, movedInB, lostWords, prefs.marks === 'layered')) });
    return;
  }
  const rangesA = [];
  const rangesB = [];
  for (const m of analysis.moves) {
    rangesA.push(...movedDeco(m.a, 'Moved to another place in After', blockEnds.a.has(m.a.from)));
    for (const c of innerChanges(m.a.text, m.b.text, prefs.gran)) if (c.toA > c.fromA) rangesA.push(lost.range(m.a.from + c.fromA, m.a.from + c.toA));
    rangesB.push(...movedInB(m));
  }
  // Layered: the merge view marks each changed phrase (styled light); the words that changed inside it go strong.
  if (prefs.marks === 'layered') {
    const inMove = (from: number, to: number, side: 'a' | 'b') => analysis.moves.some((m) => from < m[side].to && to > m[side].from);
    for (const w of analysis.words) {
      if (w.toA > w.fromA && !inMove(w.fromA, w.toA, 'a') && left.slice(w.fromA, w.toA).trim()) rangesA.push(wordDel.range(w.fromA, w.toA));
      if (w.toB > w.fromB && !inMove(w.fromB, w.toB, 'b') && right.slice(w.fromB, w.toB).trim()) rangesB.push(wordAdd.range(w.fromB, w.toB));
    }
  }
  // A changed line break draws nothing visible on its own, so it gets a small marker on the side that has it.
  // Changed indents and spaces already show as tinted blocks here.
  for (const c of analysis.changes) {
    const removed = left.slice(c.fromA, c.toA);
    const inserted = right.slice(c.fromB, c.toB);
    if (removed.trim() || inserted.trim() || !changesBreaks(removed, inserted)) continue;
    const [s, t] = whitespaceGlyph(removed, inserted, c.fromB === 0 || right[c.fromB - 1] === '\n');
    // On the side that has the extra breaks only.
    if (t.includes('added')) rangesB.push(glyph(s, t).range(c.fromB));
    else rangesA.push(glyph(s, t).range(c.fromA));
  }
  merge!.a.dispatch({ effects: setMoves.of(Decoration.set(rangesA, true)) });
  merge!.b.dispatch({ effects: setMoves.of(Decoration.set(rangesB, true)) });
}

// ── Saving ───────────────────────────────────────────────────────────────────────────────────────
let saveTimer = 0;
function onEdit() {
  if (!canEdit()) return;
  state.dirty = true;
  setStatus('Editing…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 700);
}

async function save(force = false, keepalive = false) {
  if (state.saving) { saveTimer = window.setTimeout(save, 300); return; }
  if (!state.dirty && !force) return;
  const { left, right } = currentDocs();
  state.saving = true;
  state.dirty = false;
  setStatus('Saving…');
  try {
    if (!state.token) {
      if (!left && !right) { setStatus(''); return; }
      const created = await api.create(left, right);
      state.token = created.edit;
      state.links = { edit: created.edit, view: created.view };
      state.rev = created.rev;
      state.versions = [created.head];
      history.replaceState(null, '', `/${created.edit}`);
      showChrome();
    } else {
      const res: SaveResult = await api.save(state.token, left, right, state.rev, force, keepalive);
      state.rev = res.rev;
      mergeHead(res.head);
    }
    state.left = left;
    state.right = right;
    hideBanner();
    setStatus(savedLabel());
  } catch (err) {
    state.dirty = true;
    handleSaveError(err);
  } finally {
    state.saving = false;
  }
}

function mergeHead(head: VersionMeta) {
  const i = state.versions.findIndex((v) => v.n === head.n);
  if (i >= 0) state.versions[i] = head;
  else state.versions.unshift(head);
  renderVersions();
}

function handleSaveError(err: unknown) {
  if (err instanceof ApiError && err.status === 409) {
    state.blocked = true;
    refreshEditable();
    setStatus('Not saved');
    showBanner('Someone else changed this diff while you were editing.', [
      ['Load theirs', async () => { state.blocked = false; state.dirty = false; await reload(); }],
      ['Save mine as a new version', () => { state.blocked = false; refreshEditable(); state.dirty = true; save(true); }],
    ]);
    return;
  }
  if (err instanceof ApiError && (err.status === 429 || err.status === 413 || err.status === 507)) {
    setStatus('Not saved');
    showBanner(err.message, [['Retry', () => save()]]);
    return;
  }
  setStatus('Offline · not saved');
  saveTimer = window.setTimeout(() => save(), 5000);
}

const savedLabel = () => (state.versions[0] ? `Saved · v${state.versions[0].n}` : 'Saved');
function setStatus(text: string) { el.status.textContent = text; }

// Flush the last keystrokes when the tab goes away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.dirty && state.token && canEdit()) {
    clearTimeout(saveTimer);
    save(false, true);
  }
});
window.addEventListener('beforeunload', (e) => { if (state.dirty || state.saving) e.preventDefault(); });

// ── Loading and live refresh ─────────────────────────────────────────────────────────────────────
async function reload() {
  if (!state.token) return;
  const d = await api.load(state.token);
  state.role = d.role;
  state.rev = d.rev;
  state.versioning = d.versioning;
  state.links = d.links;
  state.versions = d.versions;
  showMe(d.you);
  if (!state.viewing) setDocs(d.head.left, d.head.right);
  refreshEditable();
  hideBanner();
  showChrome();
  setStatus(d.role === 'view' ? '' : savedLabel());
  renderVersions();
}

// Pull other people's saves while this tab is idle and visible.
setInterval(async () => {
  if (!state.token || state.dirty || state.saving || state.blocked || document.visibilityState !== 'visible') return;
  try {
    const { rev } = await api.rev(state.token);
    if (rev !== state.rev && !state.dirty && !state.saving) await reload();
  } catch { /* the next tick retries */ }
}, 10_000);

// ── Old versions ─────────────────────────────────────────────────────────────────────────────────
async function openVersion(n: number) {
  if (!state.token) return;
  const latest = state.versions[0]?.n;
  if (n === latest) return closeVersion();
  if (state.dirty) await save();
  const v = await api.version(state.token, n);
  state.viewing = v;
  history.replaceState(null, '', `#v${n}`);
  setDocs(v.left, v.right);
  refreshEditable();
  const who = v.authors.join(', ');
  const actions: [string, () => void][] = [['Back to latest', closeVersion]];
  if (state.role === 'edit') actions.unshift(['Restore this version', () => restore(n)]);
  showBanner(`Viewing v${n}${v.name ? ` “${v.name}”` : ''} by ${who}, ${ago(v.updatedAt)}. Read-only.`, actions);
  renderVersions();
}

async function closeVersion() {
  state.viewing = null;
  history.replaceState(null, '', location.pathname);
  hideBanner();
  await reload();
}

async function restore(n: number) {
  if (!state.token) return;
  try {
    await api.restore(state.token, n);
    state.viewing = null;
    history.replaceState(null, '', location.pathname);
    await reload();
  } catch (err) {
    showBanner(err instanceof Error ? err.message : 'Restore failed', [['Back to latest', closeVersion]]);
  }
}

// ── Versions panel ───────────────────────────────────────────────────────────────────────────────
function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(t);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function renderVersions() {
  const list = el.namedOnly.checked ? state.versions.filter((v) => v.name) : state.versions;
  el.versionList.textContent = '';
  state.versions.forEach((v, i) => {
    if (!list.includes(v)) return;
    const prev = state.versions[i + 1];
    const delta = prev ? v.size - prev.size : v.size;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'version';
    if ((state.viewing?.n ?? state.versions[0]?.n) === v.n) btn.setAttribute('aria-current', 'true');
    btn.innerHTML = '<span class="v-n"></span><span class="v-avatars"></span><span class="v-main"><span class="v-name"></span><span class="v-who"></span></span><span class="v-delta"></span>';
    btn.querySelector('.v-n')!.textContent = `v${v.n}`;
    btn.querySelector('.v-avatars')!.append(...v.authors.slice(0, 3).map((a) => avatar(a, 'sm')));
    btn.querySelector('.v-name')!.textContent = v.name ?? v.authors.join(', ');
    btn.querySelector('.v-who')!.textContent = [
      i === 0 ? 'Latest' : '', v.name ? v.authors.join(', ') : '', ago(v.updatedAt), v.restoredFrom ? `restored v${v.restoredFrom}` : '',
    ].filter(Boolean).join(' · ');
    const d = btn.querySelector('.v-delta')!;
    d.textContent = delta === 0 ? '±0' : delta > 0 ? `+${delta.toLocaleString('en')}` : `−${(-delta).toLocaleString('en')}`;
    d.className = `v-delta ${delta > 0 ? 'add' : delta < 0 ? 'del' : ''}`;
    btn.addEventListener('click', () => openVersion(v.n));
    li.append(btn);
    el.versionList.append(li);
  });
  const edit = state.role === 'edit';
  el.nameForm.hidden = !edit || !state.versions.length;
  el.versioningRow.hidden = !edit;
  el.versioningToggle.checked = state.versioning;
}

el.namedOnly.addEventListener('change', renderVersions);
el.nameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.nameInput.value.trim();
  const n = state.viewing?.n ?? state.versions[0]?.n;
  if (!state.token || !name || !n) return;
  if (state.dirty) await save();
  const res = await api.name(state.token, n, name);
  state.versions = res.versions;
  el.nameInput.value = '';
  renderVersions();
});
el.versioningToggle.addEventListener('change', async () => {
  if (!state.token) return;
  const res = await api.settings(state.token, el.versioningToggle.checked);
  state.versioning = res.versioning;
});

// ── Chrome: header buttons and popovers ──────────────────────────────────────────────────────────
const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
const UNLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.5"/></svg>';

function showChrome() {
  el.historyBtn.hidden = !state.token;
  el.shareBtn.hidden = !state.token;
  // What this link allows: a lock for view only, an open lock for edit. It opens the owner and "Edit a copy".
  el.accessBtn.hidden = !state.token;
  const view = state.role === 'view';
  el.accessBtn.innerHTML = `${view ? LOCK : UNLOCK}<span>${view ? 'View only' : 'Can edit'}</span>`;
  el.accessBtn.title = view ? 'This link is view only. Click for the owner or to edit a copy.' : 'This link can edit. Click for the owner.';
}

/** Who made the diff: the first author of version 1. */
const owner = () => state.versions.at(-1)?.authors[0] ?? '';

function openAccess() {
  const name = owner();
  el.accessText.textContent = state.role === 'view' ? 'View only. Owner:' : 'You can edit. Owner:';
  el.ownerBadge.replaceChildren(...(name ? [avatar(name, 'sm'), Object.assign(document.createElement('span'), { textContent: name })] : []));
  togglePop(el.accessPop, el.accessBtn);
}
el.accessBtn.addEventListener('click', openAccess);

/** A reader's way to edit without the edit link: a new diff with the texts on screen, opened on its own edit link. */
async function editACopy() {
  if (!state.token) return;
  const { left, right } = currentDocs();
  el.copyEditBtn.disabled = true;
  try {
    const created = await api.create(left, right);
    location.href = `/${created.edit}`;
  } catch (err) {
    el.copyEditBtn.disabled = false;
    showBanner(err instanceof Error ? err.message : 'Could not make a copy', []);
  }
}
el.copyEditBtn.addEventListener('click', editACopy);

function showBanner(text: string, actions: [string, () => void][]) {
  el.bannerText.textContent = text;
  el.bannerActions.textContent = '';
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = label;
    b.addEventListener('click', fn);
    el.bannerActions.append(b);
  }
  el.banner.hidden = false;
}
function hideBanner() { if (!state.viewing) el.banner.hidden = true; }

const pops = () => [[el.sharePop, el.shareBtn], [el.mePop, el.meBtn], [el.agentPop, el.agentBtn], [el.keysPop, el.keysBtn], [el.accessPop, el.accessBtn]] as const;
function togglePop(pop: HTMLElement, anchor: HTMLElement) {
  const open = pop.hidden;
  for (const [p] of pops()) p.hidden = true;
  if (!open) return;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  // Open toward the middle of the screen: left-aligned under a button on the left half, right-aligned otherwise.
  const onLeft = r.left + r.width / 2 < window.innerWidth / 2;
  pop.style.left = onLeft ? `${Math.max(12, r.left)}px` : 'auto';
  pop.style.right = onLeft ? 'auto' : `${Math.max(12, window.innerWidth - r.right)}px`;
}

document.addEventListener('click', (e) => {
  const t = e.target as Node;
  for (const [pop, anchor] of pops()) {
    if (!pop.hidden && !pop.contains(t) && !anchor.contains(t)) pop.hidden = true;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { for (const [p] of pops()) p.hidden = true; showHistory(false); }
});

function renderShare() {
  const links = state.links;
  if (!links) return;
  const access = links.edit ? state.access : 'view';
  el.shareLink.value = `${location.origin}/${access === 'edit' ? links.edit : links.view}`;
  el.shareNote.textContent = access === 'edit'
    ? 'Anyone with this link can read and edit. It is unlisted and hidden from search engines.'
    : 'Anyone with this link can read. It is unlisted and hidden from search engines.';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-access]')) {
    b.setAttribute('aria-pressed', String(b.dataset.access === access));
    b.disabled = !links.edit && b.dataset.access === 'edit';
  }
  el.copyBtn.textContent = 'Copy';
}

el.shareBtn.addEventListener('click', () => { renderShare(); togglePop(el.sharePop, el.shareBtn); el.shareLink.select(); });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-access]')) {
  b.addEventListener('click', () => { state.access = b.dataset.access as 'edit' | 'view'; renderShare(); });
}
el.copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.shareLink.value).catch(() => el.shareLink.select());
  el.copyBtn.textContent = 'Copied';
});

const me = { id: '', name: '', secret: '' };
/** The header's name button: badge plus name. */
function showMe(who: { id: string; name: string; secret?: string }) {
  Object.assign(me, who);
  el.meBtn.replaceChildren(avatar(who.name), Object.assign(document.createElement('span'), { textContent: who.name }));
}
function openMe() {
  el.meInput.value = me.name;
  el.backupBox.hidden = true;
  el.restoreBox.hidden = true;
  togglePop(el.mePop, el.meBtn);
  if (!el.mePop.hidden) el.meInput.focus();
}

// Back up: the login key, masked, with Copy. Restore: paste a key and this browser becomes that user.
el.backupLink.addEventListener('click', async () => {
  if (!me.secret) showMe(await api.me());
  el.secretField.value = me.secret;
  el.restoreBox.hidden = true;
  el.backupBox.hidden = !el.backupBox.hidden;
});
el.secretCopy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(me.secret).catch(() => undefined); // clipboard refused: Copy stays as is
  el.secretCopy.textContent = 'Copied';
  setTimeout(() => { el.secretCopy.textContent = 'Copy'; }, 1500);
});
el.restoreLink.addEventListener('click', () => {
  el.backupBox.hidden = true;
  el.restoreBox.hidden = !el.restoreBox.hidden;
  if (!el.restoreBox.hidden) el.restoreField.focus();
});
el.restoreBox.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api.login(el.restoreField.value.trim());
    location.reload(); // every "mine" mark and name on the page now belongs to the restored user
  } catch (err) {
    el.restoreField.setCustomValidity(err instanceof Error ? err.message : 'That key is not valid');
    el.restoreField.reportValidity();
    el.restoreField.addEventListener('input', () => el.restoreField.setCustomValidity(''), { once: true });
  }
});
el.meBtn.addEventListener('click', openMe);
el.meForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.meInput.value.trim();
  if (!name) return;
  showMe(await api.rename(name));
  el.mePop.hidden = true;
});

// Connect agent: the prompt names the edit link when there is one, so the agent can work on this diff.
let nameStored = false;
async function openAgent() {
  if (!me.secret) showMe(await api.me()); // the prompt carries the login key, which only /api/me returns
  renderAgentPop(el.agentPop, me, state.links?.edit ?? state.token);
  togglePop(el.agentPop, el.agentBtn);
  // The server stores names only on writes; store this one now so an agent using the key gets the same name.
  if (!nameStored && me.name) api.rename(me.name).then(() => { nameStored = true; }).catch(() => undefined); // retried on next open
}
el.agentBtn.addEventListener('click', openAgent);

function showHistory(open: boolean) {
  el.history.hidden = !open;
  document.body.classList.toggle('panel-open', open);
  el.historyBtn.setAttribute('aria-pressed', String(open));
  if (open) renderVersions();
}
el.historyBtn.addEventListener('click', () => showHistory(el.history.hidden === true));
el.historyClose.addEventListener('click', () => showHistory(false));

function pressed(attr: 'view', value: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`)) {
    b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  }
}
const granSelect = $<HTMLSelectElement>('granSelect');
/** Detail level of the marks: smart (whole words), word, or char. */
function setGran(g: Granularity) {
  prefs.gran = g;
  granSelect.value = g;
  localStorage.setItem('gran', g);
  mount();
}
granSelect.addEventListener('change', () => setGran(granSelect.value as Granularity));
const marksSelect = $<HTMLSelectElement>('marksSelect');
/** Marking style; see `prefs.marks`. */
function setMarks(m: 'layered' | 'solid') {
  prefs.marks = m;
  marksSelect.value = m;
  document.body.dataset.marks = m;
  localStorage.setItem('marks', m);
  updateMeta();
}
marksSelect.addEventListener('change', () => setMarks(marksSelect.value as 'layered' | 'solid'));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  b.addEventListener('click', () => {
    prefs.layout = b.dataset.view as Layout;
    localStorage.setItem('layout', prefs.layout);
    pressed('view', prefs.layout);
    mount();
  });
}
// Theme: follows the system until the reader picks one; theme.ts applies the pick before first paint.
type Theme = 'system' | 'light' | 'dark';
const THEMES: Theme[] = ['system', 'light', 'dark'];
const THEME_ICONS: Record<Theme, string> = {
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
};
const themeBtn = $<HTMLButtonElement>('themeBtn');
function showTheme(t: Theme) {
  themeBtn.innerHTML = THEME_ICONS[t];
  const label = `Theme: ${t}. Click for ${THEMES[(THEMES.indexOf(t) + 1) % 3]}.`;
  themeBtn.title = label;
  themeBtn.setAttribute('aria-label', label);
}
let theme = (localStorage.getItem('theme') as Theme) || 'system';
showTheme(theme);
themeBtn.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % 3];
  if (theme === 'system') { localStorage.removeItem('theme'); delete document.documentElement.dataset.theme; }
  else { localStorage.setItem('theme', theme); document.documentElement.dataset.theme = theme; }
  showTheme(theme);
});

let narrowNow = window.matchMedia('(max-width: 760px)').matches;
window.addEventListener('resize', () => {
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  if (narrow !== narrowNow) { narrowNow = narrow; mount(); }
});

// ── Boot ─────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  pressed('view', prefs.layout);
  granSelect.value = prefs.gran;
  marksSelect.value = prefs.marks;
  document.body.dataset.marks = prefs.marks;
  mount();
  if (!state.token) {
    showMe(await api.me());
    return;
  }
  try {
    await reload();
    const m = /^#v(\d+)$/.exec(location.hash);
    if (m) await openVersion(Number(m[1]));
  } catch (err) {
    state.role = 'view';
    refreshEditable();
    showBanner(err instanceof ApiError && err.status === 404 ? 'This link does not exist.' : 'Could not load this diff.', [
      ['Start a new diff', () => { location.href = '/'; }],
    ]);
    api.me().then(showMe).catch(() => {}); // the banner already says what failed
  }
}
// ── Keyboard shortcuts ───────────────────────────────────────────────────────────────────────────
/** Moves the cursor in the After text to the next (1) or previous (-1) changed line and scrolls to it. */
function jumpToChange(dir: 1 | -1) {
  const view = merge?.b ?? unified;
  if (!view || !lastAnalysis) return;
  const doc = view.state.doc;
  const here = doc.lineAt(view.state.selection.main.head).number;
  const lines = [...new Set(lastAnalysis.changes.map((c) => doc.lineAt(Math.min(c.fromB, doc.length)).number))].sort((x, y) => x - y);
  const target = dir === 1 ? lines.find((n) => n > here) : lines.reverse().find((n) => n < here);
  if (target === undefined) return;
  const pos = doc.line(target).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}
const visible = (b: HTMLElement) => !b.hidden;
const clickIf = (b: HTMLElement) => () => { if (visible(b)) b.click(); };
const viewBtn = (v: string) => document.querySelector<HTMLButtonElement>(`[data-view="${v}"]`);
const as = (code: string) => ({ alt: true, shift: true, code }); // the app's own chord: Alt+Shift / ⌥⇧

const SHORTCUTS: Shortcut[] = [
  { group: 'View', label: 'Split', combo: as('KeyS'), button: viewBtn('split'), run: () => viewBtn('split')?.click() },
  { group: 'View', label: 'Unified', combo: as('KeyU'), button: viewBtn('unified'), run: () => viewBtn('unified')?.click() },
  { group: 'View', label: 'Switch Split / Unified', combo: as('KeyV'), run: () => viewBtn(prefs.layout === 'split' ? 'unified' : 'split')?.click() },
  { group: 'View', label: 'Smart detail', combo: as('Digit1'), run: () => setGran('smart') },
  { group: 'View', label: 'Word detail', combo: as('Digit2'), run: () => setGran('word') },
  { group: 'View', label: 'Character detail', combo: as('Digit3'), run: () => setGran('char') },
  { group: 'View', label: 'Style: Layered / Solid', combo: as('KeyM'), run: () => setMarks(prefs.marks === 'layered' ? 'solid' : 'layered') },
  { group: 'View', label: 'Next change', combo: as('ArrowDown'), run: () => jumpToChange(1) },
  { group: 'View', label: 'Previous change', combo: as('ArrowUp'), run: () => jumpToChange(-1) },
  { group: 'View', label: 'Theme: system, light, dark', combo: as('KeyT'), button: themeBtn, run: () => themeBtn.click() },
  { group: 'Diff', label: 'Save now', combo: { mod: true, code: 'KeyS' }, run: () => { if (state.dirty) void save(); } },
  { group: 'Diff', label: 'Share', combo: as('KeyL'), button: el.shareBtn, run: clickIf(el.shareBtn) },
  { group: 'Diff', label: 'Copy edit link', combo: as('KeyC'), run: () => {
    const t = state.links?.edit ?? state.links?.view;
    if (t) void navigator.clipboard.writeText(`${location.origin}/${t}`).then(() => setStatus('Link copied'));
  } },
  { group: 'Diff', label: 'Versions', combo: as('KeyH'), button: el.historyBtn, run: clickIf(el.historyBtn) },
  { group: 'Diff', label: 'Name this version', combo: as('KeyN'), run: () => { if (!visible(el.historyBtn)) return; showHistory(true); el.nameInput.focus(); } },
  { group: 'Diff', label: 'New diff', combo: as('KeyD'), run: () => { location.href = '/'; } },
  { group: 'Diff', label: 'Access and owner', combo: as('KeyO'), button: el.accessBtn, run: clickIf(el.accessBtn) },
  { group: 'Diff', label: 'Edit a copy', combo: as('KeyE'), button: el.copyEditBtn, run: () => void editACopy() },
  { group: 'You', label: 'Your name', combo: as('KeyR'), button: el.meBtn, run: openMe },
  { group: 'You', label: 'Connect agent', combo: as('KeyA'), button: el.agentBtn, run: () => void openAgent() },
  { group: 'You', label: 'Keyboard shortcuts', combo: as('KeyK'), button: el.keysBtn, run: () => el.keysBtn.click() },
  { group: 'Editing', label: 'Undo', combo: { mod: true, code: 'KeyZ' } },
  { group: 'Editing', label: 'Redo', combo: { mod: true, shift: true, code: 'KeyZ' } },
  { group: 'Editing', label: 'Close a panel', combo: { code: 'Escape' } },
];
installShortcuts(SHORTCUTS);
marksSelect.title = `Style ${formatCombo(as('KeyM'))}: Layered marks the changed phrase light and its changed words strong; Solid marks the whole phrase strong`;
granSelect.title = `Detail: Smart ${formatCombo(as('Digit1'))}, Word ${formatCombo(as('Digit2'))}, Char ${formatCombo(as('Digit3'))}`;
el.keysBtn.addEventListener('click', () => { renderShortcutList(el.keysPop, SHORTCUTS); togglePop(el.keysPop, el.keysBtn); });

boot();
