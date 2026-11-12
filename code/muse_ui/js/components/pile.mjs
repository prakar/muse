import { h, mount } from '../dom.mjs';
import { Button } from './button.mjs';
import { Tray } from './tray.mjs';
import { W } from '../words.mjs';

// The Collection as a side panel that opens over any page (address ?pile=1), so what you are collecting travels with you.
// It shares the note drawer's column: opening one closes the other.
export function PileDrawer({ host, shell, onClose }) {
  let open = false;
  return {
    open() {
      if (open) return; open = true; shell.dataset.drawer = 'open';
      mount(host, h('div', { class: 'drawer__head' }, h('h2', { id: 'drawer-title', text: W.collection }), Button({ ic: 'x', variant: 'ghost', title: `Close ${W.collection} (Esc)`, onClick: onClose })),
        h('div', { class: 'drawer__body' }, Tray()));
    },
    close() { if (!open) return; open = false; delete shell.dataset.drawer; mount(host); },
    isOpen: () => open
  };
}
