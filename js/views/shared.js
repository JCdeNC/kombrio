// Morceaux d'écran communs à plusieurs pages.
import { blackoutLines } from './blackouts.js';
import { t, tRaw, getLang } from '../i18n.js';
import { esc, initials, fmtDay, money, cents, notify, mapsLink, locale, appLink, weekdayList } from '../util.js';
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

// v74 : écran d'acceptation obligatoire d'une nouvelle version des conditions (guide ou gérant du partenaire).
// accept() renvoie true quand la base a enregistré l'acceptation (version, date, empreinte du texte).
export async function termsGateView({ kind, version, title, accept, signOut }) {
  const tx = await store.termsText(kind, version).catch(() => null);
  return {
    html: `<article class="card terms">
      <h1>${esc(title)}</h1>
      <div class="notice">${t('terms.gate.intro')}</div>
      <p class="hint">${t('terms.gate.version', { v: version })}</p>
      ${tx && tx.body ? tx.body : `<div class="notice bad">${t('err.generic')}</div>`}
      <p class="hint" style="margin-top:16px"><a href="${appLink('client', 'privacidade')}" target="_blank" rel="noopener">${t('privacy.link')}</a></p>
      ${tx && tx.sha256 ? `<p class="hint" style="word-break:break-all">${t('terms.sha', { sha: tx.sha256 })}</p>` : ''}
      ${tx && tx.body ? `<form id="tg" style="margin-top:16px">
        <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px">
          <input type="checkbox" name="ok" required style="width:auto;margin-top:4px"><span>${t('terms.gate.check')}</span></label>
        <button class="btn block">${t('terms.gate.accept')}</button>
        <p class="hint tg-err" style="display:none;color:var(--bad)">${t('err.generic')}</p>
      </form>` : ''}
      ${signOut ? `<button type="button" class="btn block secondary" id="tg-out" style="margin-top:12px">${t('terms.gate.out')}</button>` : ''}
    </article>`,
    mount(root, ctx) {
      const f = root.querySelector('#tg');
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const b = f.querySelector('button');
        b.disabled = true;
        const ok = await accept().catch(() => false);
        if (ok) return ctx.refresh();
        b.disabled = false;
        f.querySelector('.tg-err').style.display = '';
      };
      const o = root.querySelector('#tg-out');
      if (o && signOut) o.onclick = async () => { await signOut(); ctx.refresh(); };
    },
  };
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
  const list = [...partners].sort((a, b) => (b.offer || b.offerPromoCents ? 1 : 0) - (a.offer || a.offerPromoCents ? 1 : 0) || a.name.localeCompare(b.name));
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
        ${p.offerPromoCents ? `<div class="offer"><b>${t('client.price')}</b> ${esc(cents(p.offerPromoCents, city.currency, getLang()))} <s class="hint">${esc(cents(p.offerPriceCents, city.currency, getLang()))}</s></div>` : ''}
        ${p.offer ? `<div class="offer"><b>${t('client.offer')}</b> ${esc(p.offer)}</div>` : ''}
        ${p.offerDays && p.offerDays.length && (p.offer || p.offerPromoCents) ? `<div class="hint"><b>${t('client.offer.days', { days: weekdayList(p.offerDays, getLang()) })}</b></div>` : ''}
        ${p.offerEnd && (p.offer || p.offerPromoCents) ? `<div class="hint">${t('client.offer.until', { day: fmtDay(p.offerEnd, getLang()) })}</div>` : ''}
        ${blackoutLines(p, 3)}
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

/* ---------- v58 : tableaux de bord (mois et petit graphique en barres, sans bibliothèque) ---------- */
// Mois « AAAA-MM » d'une date, dans le fuseau de la ville.
export const monthKeyOf = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date(iso));
// Les n derniers mois, du plus ancien au plus récent (le mois en cours est le dernier).
export function lastMonths(n, tz) {
  const [y, m] = monthKeyOf(new Date().toISOString(), tz).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) { const d = new Date(Date.UTC(y, m - 1 - i, 15)); out.push(d.toISOString().slice(0, 7)); }
  return out;
}
export const shortMonth = (m, lang) => new Intl.DateTimeFormat(locale(lang), { month: 'short', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`));
// Variation par rapport au mois précédent : « +20 % », « −5 % » ou « nouveau ».
export function delta(now, before) {
  if (!before) return now ? `<span class="kb-delta up">${t('dash.new')}</span>` : '';
  const p = Math.round(((now - before) / before) * 100);
  return `<span class="kb-delta ${p > 0 ? 'up' : p < 0 ? 'down' : ''}">${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)} %</span>`;
}
// rows = [{ label, value, text }] : une barre horizontale par ligne, proportionnelle à la plus grande valeur.
export function barChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  return `<div class="kb-bars">${rows.map((r) => `<div class="kb-bar"><span class="kb-bar-l">${esc(r.label)}</span>
      <span class="kb-bar-t"><span class="kb-bar-f" style="width:${Math.round(((r.value || 0) / max) * 100)}%"></span></span>
      <span class="kb-bar-v">${r.text}</span></div>`).join('')}</div>`;
}

/* ---------- v87 : barre d'onglets des apps Guide et Partenaire ---------- */
// Ordinateur : les pastilles habituelles. Téléphone : barre fixée en bas (icône + mot court), à portée du pouce,
// toujours visible pendant le défilement. Les icônes sont dessinées au trait, en currentColor (thème clair ou sombre).
const ICON_PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.8 14.2c2.4.1 4.1 1.7 4.7 4.3"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.2"/>',
  gift: '<rect x="3.5" y="9" width="17" height="11" rx="1.5"/><path d="M3.5 13h17M12 9v11"/><path d="M12 9c-1.5-3.5-5.5-3.5-5.5-1 0 1.5 2.5 1 5.5 1zM12 9c1.5-3.5 5.5-3.5 5.5-1 0 1.5-2.5 1-5.5 1z"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-4 3.8-6.2 7.5-6.2s6.6 2.2 7.5 6.2"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="m3.5 6.5 1.3 1.3L7 5.5M3.5 12l1.3 1.3L7 11M3.5 17.5l1.3 1.3L7 16.5"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  team: '<circle cx="12" cy="7.5" r="3"/><path d="M6.5 19c.5-3.3 2.7-5.3 5.5-5.3s5 2 5.5 5.3"/><circle cx="5" cy="10" r="2"/><circle cx="19" cy="10" r="2"/>',
  percent: '<circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/><path d="M18.5 5.5l-13 13"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  // design v2 : bouton central (QR du guide, scanner du partenaire).
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2M16 16h2v2"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.6-2.4 2.1-2.4 3.6"/><path d="M12 17h.01"/>',
  today: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="m9 14.5 2 2 4-4"/>',
};
// items : [{ href, label, short, icon, on, count, center, desk, attrs }] (attrs : attributs en plus, ex. data-help-open)
// design v2 : center = gros bouton rond au milieu de la barre (comme « Pagar » des apps de transport) pour l'action QR.
// v129 : retour façon iOS, en haut à gauche (« ‹ Clientes »).
export const iosBack = (href, key) => `<a class="ios-back no-print" href="${href}"><span aria-hidden="true">‹</span> ${t(key)}</a>`;
export function appTabs(items) {
  return `<nav class="tabs apptabs no-print">${items.map((x) => `<a href="${x.href}" class="${x.on ? 'on' : ''}${x.center ? ' at-center' : ''}${x.desk ? ' at-desk' : ''}"${x.on ? ' aria-current="page"' : ''}${x.attrs ? ` ${x.attrs}` : ''}>
    ${x.center ? `<span class="atc"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[x.icon] || ''}</svg></span>` : `<svg class="ati" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[x.icon] || ''}</svg>`}<span class="atl">${x.label}</span><span class="ats">${x.short || x.label}</span>${x.count ? `<span class="todo">${x.count}</span>` : ''}</a>`).join('')}</nav>`;
}
