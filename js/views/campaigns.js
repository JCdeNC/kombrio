// v142 (lot H, décisions de JC 25/11) : CAMPAGNES À OBJECTIF créées et payées par l'établissement.
//   - Gérant (#/p/<G->/campanhas) : créer « 20 clientes = R$ 100 », voir le total avec les 5 % de frais Kombrio avant de lancer,
//     suivre le classement, annuler tant qu'aucune prime n'est gagnée.
//   - Guide (#/campanhas) : campagnes en cours de sa ville, sa progression « 12 / 20 », le top 5.
// La prime gagnée arrive d'elle-même dans les commissions à payer (Pix unique) ; le guide touche 100 %.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents, fmtDay, notify, todayIn, addDays, parseCents } from '../util.js';
import * as store from '../store.js';

const bar = (n, target) => {
  const p = Math.max(0, Math.min(100, Math.round((n / Math.max(1, target)) * 100)));
  return `<div style="height:10px;border-radius:6px;background:var(--line, #E3E8EA);overflow:hidden;margin:6px 0"><div style="height:100%;width:${p}%;background:#1E7F4F"></div></div>`;
};
const boardHtml = (board) => (board && board.length ? `<ol class="list" style="padding-left:18px">${board.map((b) => `<li class="spread"><span>${b.me ? `<b>${esc(b.name)}</b>` : esc(b.name)}${b.won ? ' 🏆' : ''}</span><span>${b.clients}</span></li>`).join('')}</ol>` : '');

export async function partnerCampaignsView(space, ctx) {
  const { city, key } = space;
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const list = await store.partnerCampaigns(key);
  if (list === null) return { html: `<a class="ios-back" href="#/p/${encodeURIComponent(key)}/comissao"><span aria-hidden="true">‹</span> ${t('pd.tab.comissao')}</a><div class="notice warn">${t('camp.unavailable')}</div>` };
  const today = todayIn(city.timezone);
  const feeRate = 0.05;
  const html = `<a class="ios-back no-print" href="#/p/${encodeURIComponent(key)}/comissao"><span aria-hidden="true">‹</span> ${t('pd.tab.comissao')}</a>
    <div class="card"><h1>${t('camp.title')}</h1><p class="hint">${t('camp.intro')}</p></div>
    <form class="card" id="camp-new"><h2>${t('camp.new')}</h2>
      <label for="cp-t">${t('camp.f.title')}</label><input id="cp-t" maxlength="80" placeholder="${esc(tRaw('camp.f.title.ph'))}" required>
      <div class="row" style="gap:8px"><div style="flex:1"><label for="cp-s">${t('camp.f.start')}</label><input id="cp-s" type="date" value="${today}"></div>
        <div style="flex:1"><label for="cp-e">${t('camp.f.end')}</label><input id="cp-e" type="date" value="${addDays(today, 30)}"></div></div>
      <div class="row" style="gap:8px"><div style="flex:1"><label for="cp-n">${t('camp.f.target')}</label><input id="cp-n" type="number" min="1" max="1000" value="20"></div>
        <div style="flex:1"><label for="cp-b">${t('camp.f.bonus')}</label><input id="cp-b" inputmode="decimal" value="100,00"></div></div>
      <p class="notice" id="cp-total"></p>
      <button class="btn block">${t('camp.create')}</button></form>
    ${list.length ? list.map((x) => `<div class="card"><div class="spread"><h2 style="margin:0">${esc(x.title)}</h2>
        <span class="badge ${x.status === 'cancelled' ? '' : x.end < today ? '' : 'ok'}">${t(x.status === 'cancelled' ? 'camp.st.cancelled' : x.end < today ? 'camp.st.done' : 'camp.st.active')}</span></div>
        <p class="hint">${t('camp.line', { start: fmtDay(x.start, lang), end: fmtDay(x.end, lang), n: x.target, bonus: c(x.bonus_cents) })} · ${t('camp.awards', { n: x.awards })}</p>
        ${boardHtml(x.board)}
        ${x.status === 'active' && !x.awards ? `<button type="button" class="btn ghost small" data-cancel="${esc(x.id)}">${t('camp.cancel')}</button>` : ''}</div>`).join('') : ''}`;
  return {
    html,
    mount(root) {
      const f = root.querySelector('#camp-new');
      const total = () => {
        const b = parseCents(f.querySelector('#cp-b').value) || 0;
        const fee = Math.round(b * feeRate);
        f.querySelector('#cp-total').innerHTML = t('camp.total', { bonus: c(b), fee: c(fee), total: c(b + fee), n: f.querySelector('#cp-n').value || '?' });
      };
      f.querySelectorAll('input').forEach((i) => { i.addEventListener('input', total); });
      total();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const r = await store.campaignCreate(key, { title: f.querySelector('#cp-t').value, start: f.querySelector('#cp-s').value, end: f.querySelector('#cp-e').value,
            target: Number(f.querySelector('#cp-n').value), bonusCents: parseCents(f.querySelector('#cp-b').value) });
          if (!r || !r.ok) { btn.disabled = false; notify(tRaw(`camp.err.${(r && r.reason) || 'x'}`)); return; }
          ctx.refresh(tRaw('camp.created'));
        } catch { btn.disabled = false; notify(tRaw('err.generic')); }
      };
      root.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = async () => {
        if (!window.confirm(tRaw('camp.cancel.confirm'))) return;
        b.disabled = true;
        try { const r = await store.campaignCancel(key, b.dataset.cancel); ctx.refresh(tRaw(r && r.ok ? 'camp.cancelled' : 'camp.err.awarded')); } catch { b.disabled = false; notify(tRaw('err.generic')); }
      }; });
    },
  };
}

export async function guideCampaignsView(city) {
  const lang = getLang();
  const c = (n) => cents(n, (city && city.currency) || 'BRL', lang);
  const list = await store.guideCampaigns();
  return {
    html: `<a class="ios-back no-print" href="#/"><span aria-hidden="true">‹</span> ${t('ios.back.home')}</a>
      <div class="card"><h1>${t('gcamp.title')}</h1><p class="hint">${t('gcamp.intro')}</p></div>
      ${list.length ? list.map((x) => `<div class="card"><div class="spread"><h2 style="margin:0">${esc(x.partner)}</h2>${x.won ? `<span class="badge ok">🏆 ${t('gcamp.won')}</span>` : ''}</div>
        <p style="margin:4px 0"><b>${esc(x.title)}</b> · ${t('gcamp.line', { n: x.target, bonus: c(x.bonus_cents) })}</p>
        <p class="hint" style="margin:0">${t('gcamp.dates', { start: fmtDay(x.start, lang), end: fmtDay(x.end, lang) })}${x.area ? ` · ${esc(x.area)}` : ''}</p>
        ${bar(x.mine, x.target)}<p style="margin:0"><b>${t('gcamp.mine', { n: x.mine, target: x.target })}</b></p>
        ${x.board && x.board.length ? `<p class="hint" style="margin:10px 0 0">${t('gcamp.top')}</p>${boardHtml(x.board)}` : ''}</div>`).join('')
        : `<p class="hint card">${t('gcamp.none')}</p>`}`,
  };
}

// Petite carte de l'accueil du guide (rien s'il n'y a pas de campagne en cours).
export async function guideCampaignsCard() {
  const list = await store.guideCampaigns().catch(() => []);
  if (!list.length) return '';
  return `<a class="card ios-row" href="#/campanhas" style="text-decoration:none;color:inherit"><span style="flex:1;min-width:0"><b>🎯 ${t('gcamp.card', { n: list.length })}</b><br><small class="hint">${esc(list.map((x) => x.partner).slice(0, 3).join(' · '))}</small></span><span class="ios-chev" aria-hidden="true">›</span></a>`;
}
