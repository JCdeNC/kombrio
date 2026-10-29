// Morceaux d'écran communs à plusieurs pages.
import { t } from '../i18n.js';
import { esc, initials, fmtDay, money } from '../util.js';
import { guideShare } from '../store.js';

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
