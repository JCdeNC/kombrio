// v113 : liste « Para começar » par profil (guide, Tour Company / agence, partenaire).
// Les étapes se cochent seules quand l'app peut le voir (Pix, CPF, premier client, offre, premier passage…) ;
// les autres se cochent au premier clic sur leur lien, ou à la main. Gardé sur l'appareil, disparaît une fois tout fait.
import { t, tRaw } from '../i18n.js';
import { esc } from '../util.js';
import { installEnv } from './install.js';

const KEY = (kind, id) => `kb-start-${kind}-${id}`;
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
const save = (k, o) => { try { localStorage.setItem(k, JSON.stringify(o)); } catch { /* rien */ } };

// L'étape « installer » n'a de sens que sur téléphone ; déjà faite dans l'app installée.
function installStep() {
  const env = installEnv();
  if (env.os !== 'ios' && env.os !== 'android') return null;
  let done = env.standalone;
  try { done = done || !!localStorage.getItem('kombrio-installed'); } catch { /* rien */ }
  return { id: 'install', label: 'st.install', hint: 'st.install.hint', href: '#/instalar', done };
}

// Étapes du guide (actorKind « guide ») ou d'une Tour Company / agence (« tc », « agency »).
export function guideSteps({ me, stays, pixOk }) {
  const company = me.actorKind && me.actorKind !== 'guide';
  const firstGroup = stays.find((s) => !s.direct);
  const s = [installStep(),
    { id: 'pix', label: 'st.g.pix', hint: 'st.g.pix.hint', href: '#/conta', tuto: 'pix', done: !!me.pixKey && pixOk },
    company ? { id: 'cnpj', label: 'st.c.cnpj', hint: 'st.c.cnpj.hint', href: '#/conta', done: !!me.cnpj }
      : { id: 'cpf', label: 'st.g.cpf', hint: 'st.g.cpf.hint', href: '#/conta', done: !!me.cpf },
    { id: 'client', label: company ? 'st.c.group' : 'st.g.client', hint: company ? 'st.c.group.hint' : 'st.g.client.hint', href: '#/clientes', tuto: 'client', done: !!firstGroup },
    company ? { id: 'link', label: me.actorKind === 'agency' ? 'st.c.link.agency' : 'st.c.link.tc', hint: 'st.c.link.hint',
      href: firstGroup ? `#/sejour/${encodeURIComponent(firstGroup.id)}` : '#/clientes', manual: true }
      : { id: 'badge', label: 'st.g.badge', hint: 'st.g.badge.hint', href: '#/cracha', manual: true },
    { id: 'offers', label: 'st.g.offers', hint: 'st.g.offers.hint', href: '#/clientes', manual: true },
  ];
  return s.filter(Boolean);
}

// Étapes du gérant d'un partenaire.
export function partnerSteps({ partner, visits, base }) {
  return [installStep(),
    { id: 'offer', label: 'st.p.offer', hint: 'st.p.offer.hint', href: `${base}/config`, done: !!(partner.offer || partner.offerPromoCents) },
    { id: 'rate', label: 'st.p.rate', hint: 'st.p.rate.hint', href: `${base}/regras`, tuto: 'rules', manual: true },
    { id: 'qr', label: 'st.p.qr', hint: 'st.p.qr.hint', href: `${base}/config`, manual: true },
    { id: 'team', label: 'st.p.team', hint: 'st.p.team.hint', href: `${base}/equipe`, tuto: 'team', manual: true },
    { id: 'scan', label: 'st.p.scan', hint: 'st.p.scan.hint', href: `${base}/conta`, tuto: 'scan', done: visits.length > 0 },
  ].filter(Boolean);
}

// La carte. Renvoie '' si tout est fait ou si la personne l'a masquée.
// v127 : opts.collapsed = une seule ligne « Para começar · 1 de 6 › » qui s'ouvre au toucher (accueil « Hoje » du gérant).
export function startCard(kind, id, steps, opts = {}) {
  const st = read(KEY(kind, id));
  if (st.hidden) return '';
  const list = steps.map((x) => ({ ...x, done: !!x.done || (x.manual && !!(st.done || {})[x.id]) }));
  const n = list.filter((x) => x.done).length;
  if (n === list.length) return '';
  const pct = Math.round((n / list.length) * 100);
  const tag = opts.collapsed ? 'details' : 'div';
  const headRow = `<div class="spread"><h2 style="margin:0">${t('st.title')}</h2><span class="hint">${t('st.count', { n, total: list.length })}</span></div>`;
  return `<${tag} class="card st-card no-print${opts.collapsed ? ' st-fold' : ''}" data-st-card="${esc(kind)}" data-st-id="${esc(id)}">
      ${opts.collapsed ? `<summary>${headRow}</summary>` : headRow}
      <div class="st-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      <ol class="st-list">${list.map((x) => `<li class="${x.done ? 'st-ok' : ''}">
        ${x.manual ? `<button type="button" class="st-tick" data-st-tick="${esc(x.id)}" aria-pressed="${x.done}" aria-label="${esc(tRaw('st.mark'))}"></button>` : '<span class="st-tick" aria-hidden="true"></span>'}
        <a href="${esc(x.href)}"${x.manual ? ` data-st-go="${esc(x.id)}"` : ''}><b>${t(x.label)}</b><small>${t(x.hint)}</small></a>${x.tuto && !x.done ? `<a class="st-tuto" href="#/tuto/${esc(x.tuto)}"><span class="tu-play" aria-hidden="true"></span>${t('tu.see')}</a>` : ''}</li>`).join('')}</ol>
      <p style="margin:6px 0 0;text-align:right"><button type="button" class="btn ghost small" data-st-hide>${t('st.hide')}</button></p></${tag}>`;
}

export function mountStartCard(root) {
  const card = root.querySelector('[data-st-card]');
  if (!card) return;
  const k = KEY(card.dataset.stCard, card.dataset.stId);
  const mark = (stepId, on) => { const o = read(k); o.done = { ...(o.done || {}), [stepId]: on }; save(k, o); };
  card.querySelectorAll('[data-st-go]').forEach((a) => { a.addEventListener('click', () => mark(a.dataset.stGo, true)); });
  card.querySelectorAll('[data-st-tick]').forEach((b) => { b.onclick = () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    mark(b.dataset.stTick, on);
    b.setAttribute('aria-pressed', String(on)); b.closest('li').classList.toggle('st-ok', on);
    const all = card.querySelectorAll('.st-list li'); const n = card.querySelectorAll('.st-list li.st-ok').length;
    if (n === all.length) { card.remove(); return; }
    card.querySelector('.st-bar i').style.width = `${Math.round((n / all.length) * 100)}%`;
    card.querySelector('.spread .hint').textContent = tRaw('st.count', { n, total: all.length });
  }; });
  const h = card.querySelector('[data-st-hide]');
  if (h) h.onclick = () => { const o = read(k); o.hidden = true; save(k, o); card.remove(); };
}
