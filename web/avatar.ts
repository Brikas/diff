// A person's badge: a coloured circle with their animal or plant icon, or their initial for a chosen name.
import icons from '../server/anon-icons.json' with { type: 'json' };

// Mid-tone colours that keep a white icon readable in both themes. Red and green stay out: they mean removed and added.
const COLOURS = ['#d9480f', '#c2255c', '#9c36b5', '#6741d9', '#3b5bdb', '#1971c2', '#0c8599', '#0b7285', '#5c940d', '#a35200'];

/** FNV-1a: a stable small hash, so a name keeps its colour on every device. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function avatar(name: string, size: 'sm' | 'md' = 'md'): HTMLElement {
  const el = document.createElement('span');
  el.className = `avatar avatar-${size}`;
  el.style.setProperty('--c', COLOURS[hash(name) % COLOURS.length]);
  el.setAttribute('aria-hidden', 'true');
  const noun = /^Anonymous ([A-Za-z-]+)$/.exec(name)?.[1];
  if (noun && noun in icons) {
    const icon = el.appendChild(document.createElement('span'));
    icon.className = 'avatar-icon';
    icon.style.setProperty('--icon', `url(/anon/${noun}.svg)`);
  } else {
    el.textContent = (name.trim()[0] ?? '?').toUpperCase();
  }
  return el;
}
