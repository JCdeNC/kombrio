// v146 (refonte « Bento ») : icônes au trait, style Lucide (licence ISC), intégrées ici pour ne rien charger depuis Internet.
// ic('qr') → <svg class="ic">…</svg>, couleur = couleur du texte (currentColor).
const P = {
  qr: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  chart: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  badge: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 8h2"/><path d="M15 12h2"/><path d="M7 16h6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  list: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
};
export const ic = (name, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;

// Grille « Bento » : une grande tuile d'action (verte), des petites tuiles (icône + libellé), une ligne ambre en option.
//   bento({ main: { href, icon, label, sub }, tiles: [{ href, icon, label }], row: { href, icon, label, sub } })
// Les éléments vides sont ignorés ; tous sont des liens (aucun script).
export function bento({ main, tiles = [], row } = {}) {
  const tl = tiles.filter(Boolean);
  return `<div class="bento no-print">
    ${main ? `<a class="bt-main" href="${main.href}">${ic(main.icon)}<span class="bt-main-l"><b>${main.label}</b>${main.sub ? `<small>${main.sub}</small>` : ''}</span>${ic('chev', 'bt-go')}</a>` : ''}
    ${tl.length ? `<div class="bt-tiles${tl.length % 2 ? ' odd' : ''}">${tl.map((x) => `<a class="bt-tile" href="${x.href}"${x.ext ? ' target="_blank" rel="noopener"' : ''}>${ic(x.icon)}<b>${x.label}</b>${x.n ? `<span class="bt-n">${x.n}</span>` : ''}</a>`).join('')}</div>` : ''}
    ${row ? `<a class="bt-row" href="${row.href}">${ic(row.icon)}<span class="bt-row-l"><b>${row.label}</b>${row.sub ? `<small>${row.sub}</small>` : ''}</span>${ic('chev', 'bt-go')}</a>` : ''}
  </div>`;
}
