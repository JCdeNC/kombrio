// Morceaux d'écran communs à plusieurs pages.
import { t, tRaw } from '../i18n.js';
import { esc, initials, fmtDay, money, cents, notify, mapsLink } from '../util.js';
import * as store from '../store.js';


export function guideCard(guide, city) {
  const photo = guide.photo ? `<img src="${esc(guide.photo)}" alt="">` : esc(initials(guide.name));
  return `
    <div class="person">
      <div class="avatar">${photo}</div>
      <div>
        <h2 style="margin:0">${esc(guide.name)}</h2>
        <div class="hint">${t('common.guide')} · ${esc(city.licenseLabel)} ${esc(guide.license || '')}</div>
        ${guide.status === 'validated' ? `<span class="badge ok">${t('common.verified')}</span>` : ''}
      </div>
    </div>`;
}

export function validity(stay, valid, lang) {
  return valid
    ? `<span class="badge ok">${t('stay.valid.until', { day: fmtDay(stay.end, lang) })}</span>`
    : `<span class="badge bad">${t('stay.expired', { day: fmtDay(stay.end, lang) })}</span>`;
}

const STATUS_CLASS = {
  visited: '', zero: '', declared: 'warn', verifying: 'warn', received: 'ok', payout_pending: 'ok', paid: 'ok', disputed: 'bad', cancelled: 'bad',
};
// Le partenaire ne voit pas le reversement au guide : pour lui, tout ce qui est encaissé est « payé ».
const PARTNER_STATUS = { received: 'paid', payout_pending: 'paid' };

export function statusBadge(visit, audience = 'all') {
  const st = audience === 'partner' ? (PARTNER_STATUS[visit.status] || visit.status) : visit.status;
  const key = audience === 'partner' ? `pstatus.${st}` : `status.${st}`;
  return `<span class="badge ${STATUS_CLASS[visit.status] ?? ''}">${t(key)}</span>`;
}

// Ligne de montants vue par le guide : jamais « gagné » tant que Kombrio n'a pas encaissé.
export function guideAmounts(visit, city, lang) {
  const c = (n) => cents(n, city.currency, lang);
  if (visit.status === 'zero') return t('visit.g.zero');
  if (visit.declaredCents == null) return '';
  if (['received', 'payout_pending', 'paid'].includes(visit.status)) {
    return t('visit.g.received', { declared: c(visit.declaredCents), share: c(visit.guideCents) });
  }
  return t('visit.g.expected', { declared: c(visit.declaredCents) });
}

export function notFound(key = 'err.notfound') {
  return { html: `<div class="notice bad">${t(key)}</div><a class="btn ghost" href="#/">${t('common.home')}</a>` };
}

// Lien « mot de passe oublié » sous un formulaire de connexion (il réutilise l'e-mail saisi).
export function forgotLink() {
  return `<p class="hint" style="margin-top:10px"><a href="#" class="forgot">${t('auth.forgot')}</a></p>`;
}
export function mountForgot(form) {
  form.querySelector('.forgot').onclick = async (e) => {
    e.preventDefault();
    const email = form.querySelector('input[type=email]').value.trim();
    if (!email) { notify(tRaw('auth.forgot.need')); return; }
    try { await store.sendPasswordReset(email); } catch { /* même message : on ne dit pas si le compte existe */ }
    notify(tRaw('auth.forgot.sent'));
  };
}

// Écran affiché après le lien « nouveau mot de passe » reçu par e-mail.
export function resetView() {
  return {
    html: `
      <form class="card" id="reset">
        <h2>${t('auth.reset.title')}</h2>
        <div class="field"><label for="r-pass">${t('auth.password.new')}</label><input id="r-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="field"><label for="r-pass2">${t('auth.password.confirm')}</label><input id="r-pass2" name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
        <button class="btn block">${t('auth.reset.submit')}</button>
      </form>`,
    mount(root, ctx) {
      root.querySelector('#reset').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.password !== f.password2) { notify(tRaw('auth.err.mismatch')); return; }
        try { await store.setNewPassword(f.password); ctx.go('', tRaw('auth.reset.done')); } catch { notify(tRaw('auth.reset.err')); }
      };
    },
  };
}

// Vitrine des partenaires (page du client) : fiches avec photo, offre, itinéraire, et filtres par type.
const TYPE_ICON = {
  restaurant: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3c-2 2-3 5-3 8h3v10"/></svg>',
  shop: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
};
export function partnerShowcase(partners, city) {
  const list = [...partners].sort((a, b) => (b.offer ? 1 : 0) - (a.offer ? 1 : 0) || a.name.localeCompare(b.name));
  const types = [...new Set(list.map((p) => p.type))];
  const chips = types.length > 1
    ? `<div class="chips">${['all', ...types].map((k, i) => `<button type="button" class="chip${i ? '' : ' on'}" data-f="${esc(k)}">${k === 'all' ? t('client.filter.all') : t(`ptype.${k}.many`)}</button>`).join('')}</div>`
    : '';
  const photo = (p) => (p.photo && p.photo.startsWith('data:image/') ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : TYPE_ICON[p.type] || '');
  return `${chips}<div class="pcards">${list.map((p) => `<article class="pcard" data-type="${esc(p.type)}">
      <div class="pphoto">${photo(p)}</div>
      <div class="pbody">
        <h3>${esc(p.name)}</h3>
        <div class="hint">${t(`ptype.${p.type}`)}${p.area ? ` · ${esc(p.area)}` : ''}</div>
        ${p.offer ? `<div class="offer"><b>${t('client.offer')}</b> ${esc(p.offer)}</div>` : ''}
        <a class="btn ghost small" target="_blank" rel="noopener" href="${esc(mapsLink(p, city.name))}">${t('client.directions')}</a>
      </div>
    </article>`).join('')}</div>`;
}
export function mountShowcase(root) {
  root.querySelectorAll('.chip').forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
      root.querySelectorAll('.pcard').forEach((c) => { c.hidden = b.dataset.f !== 'all' && c.dataset.type !== b.dataset.f; });
    };
  });
}
