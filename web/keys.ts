// Keyboard shortcuts that work the same on macOS and Windows/Linux.
// App actions use Alt+Shift (⌥⇧ on a Mac): browsers leave it free, and it never types into the editor
// because matching goes by physical key (`code`), which Option does not change. Mod is ⌘ on a Mac, Ctrl elsewhere.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type Combo = { mod?: boolean; alt?: boolean; shift?: boolean; code: string };
export type Shortcut = { combo: Combo; label: string; group: string; run?: () => void; button?: HTMLElement | null };

/** A key's printed name, from its physical code: KeyS → S, Digit1 → 1. */
const keyName = (code: string) => ({
  ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Slash: '/', Enter: 'Enter',
} as Record<string, string>)[code] ?? code.replace(/^Key|^Digit/, '');

/** "⌥⇧S" on a Mac, "Alt+Shift+S" elsewhere. */
export function formatCombo(c: Combo): string {
  if (isMac) return `${c.mod ? '⌘' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${keyName(c.code)}`;
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', keyName(c.code)].filter(Boolean).join('+');
}

function matches(e: KeyboardEvent, c: Combo): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  return e.code === c.code && !!c.mod === mod && !!c.alt === e.altKey && !!c.shift === e.shiftKey;
}

/** Wires the shortcuts and writes each one into its button's tooltip. */
export function installShortcuts(list: Shortcut[]) {
  for (const s of list) {
    if (!s.button) continue;
    const base = s.button.dataset.tip ?? s.button.title ?? s.label;
    s.button.dataset.tip = base || s.label;
    s.button.title = `${base || s.label} (${formatCombo(s.combo)})`;
  }
  document.addEventListener('keydown', (e) => {
    const s = list.find((x) => x.run && matches(e, x.combo));
    if (!s) return;
    e.preventDefault();
    s.run!();
  });
}

/** The read-only list in the shortcuts popover, grouped. */
export function renderShortcutList(pop: HTMLElement, list: Shortcut[]) {
  pop.innerHTML = '<h2 class="pop-title">Keyboard shortcuts</h2>';
  const groups = [...new Set(list.map((s) => s.group))];
  for (const g of groups) {
    const h = pop.appendChild(document.createElement('h3'));
    h.className = 'keys-group';
    h.textContent = g;
    const dl = pop.appendChild(document.createElement('dl'));
    dl.className = 'keys';
    for (const s of list.filter((x) => x.group === g)) {
      const dt = dl.appendChild(document.createElement('dt'));
      dt.textContent = s.label;
      const dd = dl.appendChild(document.createElement('dd'));
      const kbd = dd.appendChild(document.createElement('kbd'));
      kbd.textContent = formatCombo(s.combo);
    }
  }
}
