// Morceaux d'écran communs à plusieurs pages.
import { t, tRaw } from '../i18n.js';
import { esc, initials, fmtDay, money, notify } from '../util.js';
import * as store from '../store.js';

const { guideShare } = store;

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

const STATUS_CLASS = { visited: 'warn', declared: '', received: 'ok', paid: 'ok' };

export function statusBadge(visit) {
  const key = visit.status === 'visited' && visit.rejected ? 'status.rejected' : `status.${visit.status}`;
  return `<span class="badge ${visit.rejected && visit.status === 'visited' ? 'bad' : STATUS_CLASS[visit.status]}">${t(key)}</span>`;
}

// Ligne de montant vue par le guide : ce que le partenaire a déclaré et ce qui lui revient.
export function guideAmounts(visit, city, lang) {
  if (visit.amount == null || visit.status === 'visited') return '';
  return t('visit.amounts', {
    amount: money(visit.amount, city.currency, lang),
    share: money(guideShare(visit.amount), city.currency, lang),
  });
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
