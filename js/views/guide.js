// Espace du guide : connexion, séjours, QR, suivi des passages et de ses gains.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, money, fmtDay, fmtMoment, todayIn, addDays, stayIsValid, qrSvg, appLink, notify, validCpf, onlyDigits } from '../util.js';
import * as store from '../store.js';
import { validity, statusBadge, guideAmounts, notFound, forgotLink, mountForgot, resetView } from './shared.js';
import { maskTaxId, qrCardBlob, shareOrDownload } from '../util.js';

export async function guideView(params, ctx) {
  const me = await store.currentGuide();
  if (me && store.inRecovery()) return resetView();
  if (!me) return loginView();
  if (me.status !== 'validated') return pendingView(me);
  const city = await store.getCity(me.cityId);
  if (params[0] === 'sejour') return stayView(me, city, params[1]);
  return dashboardView(me, city);
}

async function loginView() {
  const cities = await store.listCities();
  return {
    html: `
      <h1>${t('guide.login.title')}</h1>
      <form class="card" id="login">
        <h2>${t('auth.login')}</h2>
        <div class="field"><label for="l-email">${t('auth.email')}</label><input id="l-email" name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label for="l-pass">${t('auth.password')}</label><input id="l-pass" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn block">${t('auth.login')}</button>
        ${forgotLink()}
      </form>
      <form class="card" id="signup">
        <h2>${t('guide.signup.title')}</h2>
        <div class="field"><label for="g-name">${t('guide.signup.name')}</label><input id="g-name" name="name" required autocomplete="name"></div>
        <div class="grid2">
          <div class="field"><label for="g-phone">${t('guide.signup.phone')}</label><input id="g-phone" name="phone" type="tel" required autocomplete="tel"></div>
          <div class="field"><label for="g-city">${t('guide.signup.city')}</label>
            <select id="g-city" name="cityId">${cities.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="g-license">${t('guide.signup.license')}</label><input id="g-license" name="license" required inputmode="numeric" placeholder="000.000.000-00 / 00.000.000/0000-00"></div>
        <div class="grid2">
          <div class="field"><label for="g-cpf">${t('guide.signup.cpf')}</label><input id="g-cpf" name="cpf" required inputmode="numeric" placeholder="000.000.000-00"></div>
          <div class="field"><label for="g-pix">${t('guide.signup.pix')}</label><input id="g-pix" name="pixKey" required></div>
        </div>
        <p class="hint">${t('guide.signup.pix.hint')}</p>
        <div class="grid2">
          <div class="field"><label for="g-email">${t('auth.email')}</label><input id="g-email" name="email" type="email" required autocomplete="email"></div>
          <div class="field"><label for="g-pass">${t('auth.password.new')}</label><input id="g-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        </div>
        <div class="field"><label for="g-pass2">${t('auth.password.confirm')}</label><input id="g-pass2" name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
        <p class="hint">${t('guide.signup.hint')}</p>
        <button class="btn block">${t('guide.signup.submit')}</button>
      </form>`,
    mount(root, ctx) {
      mountForgot(root.querySelector('#login'));
      maskTaxId(root.querySelector('#g-cpf'), 'cpf');
      maskTaxId(root.querySelector('#g-license'));
      root.querySelector('#login').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await store.signIn(f.email.trim(), f.password); ctx.refresh(); } catch { notify(tRaw('auth.err.login')); }
      };
      root.querySelector('#signup').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.password !== f.password2) { notify(tRaw('auth.err.mismatch')); return; }
        if (!validCpf(f.cpf)) { notify(tRaw('guide.signup.err.cpf')); return; }
        try {
          const ready = await store.signUpGuide({
            email: f.email.trim(), password: f.password, name: f.name.trim(), phone: f.phone.trim(),
            license: f.license.trim(), cityId: f.cityId, cpf: onlyDigits(f.cpf), pixKey: f.pixKey.trim(),
          });
          ctx.refresh(tRaw(ready ? 'guide.signup.done' : 'auth.confirm'));
        } catch (err) { notify(tRaw(err.message === 'exists' ? 'auth.err.exists' : 'auth.err.signup')); }
      };
    },
  };
}

function logoutButton() {
  return `<button class="btn ghost small" id="logout">${t('common.logout')}</button>`;
}
function mountLogout(root, ctx) {
  root.querySelector('#logout').onclick = async () => { await store.signOut(); ctx.go(''); };
}

async function pendingView(me) {
  return {
    html: `
      <div class="spread"><h1>${t('guide.hello', { name: me.name })}</h1>${logoutButton()}</div>
      <div class="notice warn">${t(me.status === 'refused' ? 'guide.refused' : 'guide.pending')}</div>`,
    mount: mountLogout,
  };
}

async function dashboardView(me, city) {
  const lang = getLang();
  const [stays, sum] = await Promise.all([store.listStays(me.id), store.guideSummary(me.id)]);
  const visits = await store.listVisits({ guideId: me.id });
  const today = todayIn(city.timezone);
  const cur = (n) => money(n, city.currency, lang);

  const stayItem = (s) => {
    const count = visits.filter((v) => v.stayId === s.id).length;
    return `<li><a href="#/sejour/${encodeURIComponent(s.id)}">
      <div class="spread"><b>${esc(s.client)}</b>${validity(s, stayIsValid(s, city), lang)}</div>
      <div class="hint">${t('stay.people', { n: s.people })} · ${fmtDay(s.start, lang)} → ${fmtDay(s.end, lang)} · ${t('stay.visits', { n: count })}</div>
    </a></li>`;
  };

  return {
    html: `
      <div class="spread"><h1>${t('guide.hello', { name: me.name })}</h1>${logoutButton()}</div>
      <div class="stats">
        <div class="stat"><b>${cur(sum.due)}</b><span>${t('guide.sum.due')}</span></div>
        <div class="stat"><b>${cur(sum.checking)}</b><span>${t('guide.sum.checking')}</span></div>
        <div class="stat"><b>${cur(sum.paid)}</b><span>${t('guide.sum.paid')}</span></div>
      </div>
      ${sum.toDeclare ? `<div class="notice">${t('guide.sum.todeclare', { n: sum.toDeclare })}</div>` : ''}

      <form class="card" id="new-stay">
        <h2>${t('guide.stay.new')}</h2>
        <div class="grid2">
          <div class="field"><label for="s-client">${t('guide.stay.client')}</label><input id="s-client" name="client" required placeholder="${t('guide.stay.client.ph')}"></div>
          <div class="field"><label for="s-people">${t('guide.stay.people')}</label><input id="s-people" name="people" type="number" min="1" max="99" value="2" required></div>
          <div class="field"><label for="s-start">${t('guide.stay.start')}</label><input id="s-start" name="start" type="date" value="${today}" required></div>
          <div class="field"><label for="s-end">${t('guide.stay.end')}</label><input id="s-end" name="end" type="date" value="${addDays(today, 3)}" required></div>
        </div>
        <p class="hint">${t('guide.stay.hint')}</p>
        <button class="btn block">${t('guide.stay.create')}</button>
      </form>

      <div class="card">
        <h2>${t('guide.stays')}</h2>
        ${stays.length ? `<ul class="list">${stays.map(stayItem).join('')}</ul>` : `<p class="hint">${t('guide.stays.none')}</p>`}
      </div>`,
    mount(root, ctx) {
      mountLogout(root, ctx);
      root.querySelector('#new-stay').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.end < f.start) { notify(tRaw('guide.stay.err.dates')); return; }
        const s = await store.addStay(me.id, { client: f.client.trim(), people: Number(f.people), start: f.start, end: f.end });
        ctx.go(`sejour/${s.id}`, tRaw('guide.stay.created'));
      };
    },
  };
}

async function stayView(me, city, stayId) {
  const stay = await store.getStay(stayId);
  if (!stay || stay.guideId !== me.id) return notFound();
  const lang = getLang();
  const valid = stayIsValid(stay, city);
  const visits = await store.listVisits({ stayId: stay.id });
  const partners = await store.publicPartners(city.id);
  const partnerName = (id) => partners.find((p) => p.id === id)?.name || '?';
  const clientLink = appLink('client', `c/${stay.token}`);
  const scanLink = appLink('partner', `s/${stay.token}`);
  const share = tRaw('guide.share.text', { client: stay.client, guide: me.name, link: clientLink });

  const visitItem = (v) => `<li>
    <div class="spread"><b>${esc(partnerName(v.partnerId))}</b>${statusBadge(v)}</div>
    <div class="hint">${fmtMoment(v.at, lang, city.timezone)} · ${t('stay.people', { n: v.people })}</div>
    ${guideAmounts(v, city, lang) ? `<div>${guideAmounts(v, city, lang)}</div>` : ''}
  </li>`;

  return {
    html: `
      <p><a href="#/">← ${t('guide.back')}</a></p>
      <div class="card">
        <div class="spread"><h1>${esc(stay.client)}</h1>${validity(stay, valid, lang)}</div>
        <p class="hint">${t('stay.people', { n: stay.people })} · ${fmtDay(stay.start, lang)} → ${fmtDay(stay.end, lang)}</p>
        <div class="qr">${qrSvg(scanLink)}</div>
        <p class="hint" style="text-align:center">${t('guide.stay.qr.hint')}</p>
        <div class="row">
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(share)}">${t('guide.stay.whatsapp')}</a>
          <button type="button" class="btn secondary" id="sendqr">${t('guide.stay.sendqr')}</button>
          <button class="btn secondary" id="copy">${t('guide.stay.copy')}</button>
          <a class="btn ghost" target="_blank" rel="noopener" href="${esc(clientLink)}">${t('guide.stay.preview')}</a>
        </div>
      </div>
      <div class="card">
        <h2>${t('guide.stay.visits')}</h2>
        ${visits.length ? `<ul class="list">${visits.map(visitItem).join('')}</ul>` : `<p class="hint">${t('guide.stay.visits.none')}</p>`}
      </div>`,
    mount(root) {
      root.querySelector('#sendqr').onclick = async () => {
        const blob = await qrCardBlob(scanLink, {
          title: stay.client, line1: tRaw('client.valid.until', { end: fmtDay(stay.end, lang) }), line2: tRaw('guide.stay.qr.hint'),
        });
        await shareOrDownload(blob, 'kombrio-qr.png', share);
      };
      root.querySelector('#copy').onclick = async (e) => {
        try { await navigator.clipboard.writeText(clientLink); e.target.textContent = tRaw('common.copied'); } catch { prompt('', clientLink); }
      };
    },
  };
}
