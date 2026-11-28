// v144 (lot J, décisions de JC 25/11) : CONTADORES PARCEIROS — un lien de parrainage, sans prime (Kombrio ne paie rien).
//   - #/contador : le comptable s'inscrit (nom, cabinet, CRC, e-mail) ; Kombrio le valide et lui envoie ses deux liens.
//   - #/a/<A-…> : son espace — son lien / QR de parrainage, ses établissements, leur relevé du mois s'ils le partagent.
//   - #/p/<G-…>/contador : le gérant voit son comptable, entre un code, coupe le partage ou retire le comptable.
//   - Admin, onglet « Comptables » : valider ou refuser, voir les établissements de chacun.
// Le comptable ne voit jamais les réglages, les paiements ni les données des guides.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, notify, qrSvg, appLink } from '../util.js';
import * as store from '../store.js';

const refLink = (code) => appLink('partner', `parceria/${code}`);

export async function accountantSignupView() {
  return {
    html: `<a class="ios-back no-print" href="#/"><span aria-hidden="true">‹</span> ${t('pm.title')}</a>
      <div class="card"><h1>${t('acc.su.title')}</h1><p>${t('acc.su.intro')}</p>
        <ul style="margin:8px 0 0;padding-left:18px"><li>${t('acc.su.b1')}</li><li>${t('acc.su.b2')}</li><li>${t('acc.su.b3')}</li></ul>
        <p class="hint" style="margin-top:8px">${t('acc.su.free')}</p></div>
      <form class="card" id="ctsu">
        <div class="grid2">
          <div class="field"><label for="ct-n">${t('acc.su.name')}</label><input id="ct-n" name="name" required maxlength="120" autocomplete="name"></div>
          <div class="field"><label for="ct-f">${t('acc.su.firm')}</label><input id="ct-f" name="firm" maxlength="120" autocomplete="organization"></div>
          <div class="field"><label for="ct-c">${t('acc.su.crc')}</label><input id="ct-c" name="crc" required maxlength="30" placeholder="RJ-123456/O-7"></div>
          <div class="field"><label for="ct-p">${t('acc.su.phone')}</label><input id="ct-p" name="phone" type="tel" maxlength="30" autocomplete="tel"></div>
        </div>
        <div class="field"><label for="ct-e">${t('auth.email')}</label><input id="ct-e" name="email" type="email" required maxlength="160" autocomplete="email"></div>
        <button class="btn block">${t('acc.su.send')}</button></form>`,
    mount(root, ctx) {
      root.querySelector('#ctsu').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const b = e.target.querySelector('button'); b.disabled = true;
        try {
          const r = await store.accountantSignup({ name: f.name.trim(), firm: f.firm.trim(), crc: f.crc.trim(), email: f.email.trim(), phone: f.phone.trim(), lang: getLang() });
          if (!r || !r.ok) { b.disabled = false; notify(tRaw(`acc.su.err.${(r && r.reason) || 'x'}`)); return; }
          ctx.go('', tRaw('acc.su.done'));
        } catch { b.disabled = false; notify(tRaw('err.generic')); }
      };
    },
  };
}

export async function accountantSpaceView([token]) {
  const d = token && await store.accountantSpace(token);
  if (!d) return { html: `<div class="notice bad">${t('acc.sp.notfound')}</div>` };
  const a = d.accountant;
  const link = refLink(a.ref_code);
  const msg = tRaw('acc.sp.msg', { firm: a.firm || a.name, link });
  const list = d.partners || [];
  return {
    html: `<div class="card"><h1>${t('acc.sp.title', { name: esc(a.firm || a.name) })}</h1><p class="hint">${t('acc.sp.hint')}</p></div>
      <div class="card" style="text-align:center"><h2>${t('acc.sp.link')}</h2>
        <div class="qr">${qrSvg(link)}</div>
        <p class="hint" style="word-break:break-all">${esc(link)}</p>
        <p><b>${t('acc.sp.code', { code: esc(a.ref_code) })}</b></p>
        <div class="row" style="gap:8px;justify-content:center">
          <button type="button" class="btn secondary" id="ct-copy">${t('acc.sp.copy')}</button>
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">WhatsApp</a></div></div>
      <div class="card"><h2>${t('acc.sp.places', { n: list.length })}</h2>
        ${list.length ? `<ul class="list">${list.map((p) => `<li class="spread"><span><b>${esc(p.name)}</b>${p.area ? ` <span class="hint">· ${esc(p.area)}</span>` : ''}
            ${p.status === 'pending' ? `<br><small class="hint">${t('acc.sp.pending')}</small>` : ''}</span>
          ${p.report_token ? `<a class="btn secondary small" href="#/r/${esc(p.report_token)}">${t('acc.sp.report')}</a>` : `<span class="badge">${t(p.status === 'pending' ? 'acc.sp.wait' : 'acc.sp.noshare')}</span>`}</li>`).join('')}</ul>`
          : `<p class="hint">${t('acc.sp.none')}</p>`}</div>`,
    mount(root) {
      root.querySelector('#ct-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(link); notify(tRaw('common.copied')); } catch { window.prompt('', link); }
      };
    },
  };
}

// Bandeau de la page d'inscription de l'établissement venu par le lien d'un comptable.
export async function signupRefBanner(code) {
  if (!code) return { html: '', ref: '' };
  const info = await store.accountantRefInfo(code).catch(() => null);
  if (!info) return { html: '', ref: '' };
  return {
    ref: code,
    html: `<div class="notice ok"><b>${t('acc.ps.by', { firm: esc(info.firm || info.name) })}</b>
      <label style="font-weight:400;display:flex;gap:10px;align-items:flex-start;margin:8px 0 0"><input type="checkbox" name="accountantShare" checked style="width:auto;margin-top:4px">
      <span>${t('acc.ps.share')}</span></label></div>`,
  };
}

export async function partnerAccountantView(space, ctx) {
  const { key } = space;
  const back = `<a class="ios-back no-print" href="#/p/${encodeURIComponent(key)}/config"><span aria-hidden="true">‹</span> ${t('pd.tab.config')}</a>`;
  const d = await store.partnerAccountant(key);
  if (d === undefined) return { html: `${back}<div class="notice warn">${t('acc.unavailable')}</div>` };
  const a = d && d.accountant;
  return {
    html: `${back}<div class="ios-head"><h1 class="ios-title">${t('acc.p.title')}</h1><p class="hint">${t('acc.p.hint')}</p></div>
      ${a ? `<form class="card" id="ct-cur"><h2>${esc(a.firm || a.name)}</h2><p class="hint">${esc(a.name)} · CRC ${esc(a.crc)}</p>
          <label style="font-weight:400;display:flex;gap:10px;align-items:flex-start;margin:4px 0 12px"><input type="checkbox" name="share" style="width:auto;margin-top:4px"${d.share ? ' checked' : ''}>
          <span>${t('acc.p.share')}</span></label>
          <div class="row" style="gap:8px"><button class="btn secondary">${t('common.save')}</button>
          <button type="button" class="btn ghost" id="ct-rm">${t('acc.p.remove')}</button></div></form>`
        : `<form class="card" id="ct-add"><h2>${t('acc.p.add')}</h2>
          <div class="field"><label for="ct-code">${t('acc.p.code')}</label><input id="ct-code" name="code" required maxlength="12" placeholder="CT-XXXXXX" autocapitalize="characters"></div>
          <label style="font-weight:400;display:flex;gap:10px;align-items:flex-start;margin:4px 0 12px"><input type="checkbox" name="share" checked style="width:auto;margin-top:4px">
          <span>${t('acc.p.share')}</span></label>
          <button class="btn">${t('acc.p.link')}</button></form>`}
      <p class="hint card">${t('acc.p.never')}</p>`,
    mount(root) {
      const run = async (code, share, msg) => {
        try {
          const r = await store.partnerAccountantSet(key, code, share);
          if (r && r.ok) ctx.refresh(tRaw(msg)); else notify(tRaw(r && r.reason === 'code' ? 'acc.p.err.code' : 'err.generic'));
        } catch { notify(tRaw('err.generic')); }
      };
      const add = root.querySelector('#ct-add');
      if (add) add.onsubmit = (e) => { e.preventDefault(); const c = add.code.value.trim().toUpperCase(); run(c.startsWith('CT-') ? c : `CT-${c}`, add.share.checked, 'acc.p.linked'); };
      const cur = root.querySelector('#ct-cur');
      if (cur) {
        cur.onsubmit = (e) => { e.preventDefault(); run(null, cur.share.checked, 'common.saved'); };
        root.querySelector('#ct-rm').onclick = () => { if (window.confirm(tRaw('acc.p.remove.confirm'))) run('', false, 'acc.p.removed'); };
      }
    },
  };
}

// Admin : onglet « Comptables ».
export async function accountantsAdmin() {
  const list = await store.adminAccountants();
  if (list === null) return { html: `<div class="notice warn">${t('acc.unavailable')}</div>` };
  const st = { pending: 'warn', active: 'ok', refused: 'bad' };
  return {
    html: `<div class="card"><h2 style="margin:0 0 4px">${t('acc.ad.title')}</h2><p class="hint">${t('acc.ad.hint')}</p></div>
      ${list.length ? list.map((a) => `<div class="card"><div class="spread"><h3 style="margin:0">${esc(a.firm || a.name)}</h3><span class="badge ${st[a.status]}">${t(`acc.ad.st.${a.status}`)}</span></div>
        <p class="hint" style="margin:4px 0">${esc(a.name)} · CRC ${esc(a.crc)} · ${esc(a.email)}${a.phone ? ` · ${esc(a.phone)}` : ''}</p>
        ${a.ref_code ? `<p style="margin:4px 0">${t('acc.ad.code')} <b>${esc(a.ref_code)}</b> · <a href="${esc(appLink('partner', `a/${a.space_token}`))}" target="_blank" rel="noopener">${t('acc.ad.space')}</a></p>` : ''}
        ${(a.partners || []).length ? `<p class="hint" style="margin:4px 0">${t('acc.ad.places', { n: a.partners.length })} ${a.partners.map((p) => `${esc(p.name)}${p.share ? ' ✓' : ''}`).join(' · ')}</p>` : ''}
        <div class="row" style="gap:8px">${a.status !== 'active' ? `<button type="button" class="btn small" data-ok="${esc(a.id)}">${t('acc.ad.ok')}</button>` : ''}
          ${a.status !== 'refused' ? `<button type="button" class="btn ghost small" data-no="${esc(a.id)}">${t('acc.ad.no')}</button>` : ''}</div></div>`).join('')
      : `<p class="hint card">${t('acc.ad.none')}</p>`}`,
    mount(root, ctx) {
      const act = (id, status) => async () => {
        if (status === 'refused' && !window.confirm(tRaw('acc.ad.no.confirm'))) return;
        try { await store.adminAccountantDecide(id, status); ctx.refresh(tRaw(status === 'active' ? 'acc.ad.done.ok' : 'acc.ad.done.no')); } catch { notify(tRaw('err.generic')); }
      };
      root.querySelectorAll('[data-ok]').forEach((b) => { b.onclick = act(b.dataset.ok, 'active'); });
      root.querySelectorAll('[data-no]').forEach((b) => { b.onclick = act(b.dataset.no, 'refused'); });
    },
  };
}
