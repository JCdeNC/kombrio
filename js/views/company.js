// v120 (script 071) : « Minha empresa » — le patron gère lui-même son groupe de lojas depuis l'app du gérant.
//   Créer l'entreprise, ajouter une nouvelle loja (validée ensuite par Kombrio) ou inviter une loja déjà dans Kombrio
//   (le gérant de l'autre loja accepte), propre ou franchise, Pix unique ou par loja, retirer, passer la main, quitter.
import { t, tRaw } from '../i18n.js';
import { esc, notify, appLink, confirmTwice } from '../util.js';
import * as store from '../store.js';

// Carte d'entrée dans Configurações.
export function companyEntryCard(space) {
  const g = space.group ? space.group.group.name : '';
  return `<div class="card co-entry"><div class="spread"><h2 style="margin:0">${t('co.title')}</h2>
      ${space.partner.groupId ? `<span class="badge">${space.partner.ownership === 'franchise' ? t('co.badge.franchise') : t('co.badge.own')}</span>` : ''}</div>
    <p class="hint">${space.partner.groupId ? t('co.entry.in', { name: g || '…' }) : t('co.entry.none')}</p>
    <a class="btn secondary" href="#/p/${encodeURIComponent(space.key)}/empresa">${t('co.entry.open')}</a></div>`;
}

// Lien d'invitation : ouvert sur le téléphone du gérant invité (#/grupo/CODE → sa loja enregistrée sur ce téléphone).
export const inviteLink = (code) => appLink('partner', `grupo/${code}`);

export async function companyView(space, code, ctx) {
  const key = space.key;
  const back = `<a class="ios-back no-print" href="#/p/${encodeURIComponent(key)}/config"><span aria-hidden="true">‹</span> ${t('pd.tab.config')}</a>`;
  const cs = await store.companySpace(key);
  if (cs === undefined) return { html: `<div class="dash-wide">${back}<div class="card"><h1>${t('co.title')}</h1><p class="hint">${t('co.soon')}</p></div></div>` };
  if (!cs) return { html: `<div class="dash-wide">${back}<div class="notice bad">${t('err.generic')}</div></div>` };
  const inv = code ? await store.companyInvitePeek(key, code).catch(() => ({ ok: false, reason: 'code' })) : null;
  const g = cs.group;
  const ownLabel = (o) => t(o === 'franchise' ? 'co.badge.franchise' : 'co.badge.own');

  // Invitation reçue (lien ou code tapé).
  const inviteCard = inv ? (inv.ok ? `<div class="card co-invite" id="co-inv"><h2>${t('co.inv.title')}</h2>
      <p>${t('co.inv.text', { group: inv.group, owner: inv.owner || inv.group, as: ownLabel(inv.ownership) })}</p>
      <div class="notice ${inv.ownership === 'franchise' ? 'ok' : 'warn'}">${t(inv.ownership === 'franchise' ? 'co.inv.share.franchise' : 'co.inv.share.own')}</div>
      ${inv.ownership === 'own' && inv.taxKnown && !inv.sameTax ? `<div class="notice warn">${t('co.inv.tax.diff')}</div>` : ''}
      ${inv.ownership === 'franchise' && inv.sameTax ? `<div class="notice warn">${t('co.inv.tax.same')}</div>` : ''}
      ${inv.sameGroup ? `<p class="hint">${t('co.inv.already')}</p>` : inv.inGroup ? `<div class="notice bad">${t('co.inv.ingroup')}</div>` : `<div class="row" style="gap:8px">
        <button type="button" class="btn" id="co-acc">${t('co.inv.accept')}</button><button type="button" class="btn ghost" id="co-ref">${t('co.inv.refuse')}</button></div>`}</div>`
    : `<div class="notice bad">${t(`co.inv.err.${['used', 'expired'].includes(inv.reason) ? inv.reason : 'code'}`)}</div>`) : '';

  let body = '';
  if (!g) {
    body = `<div class="card"><h2>${t('co.create.title')}</h2><p class="hint">${t('co.create.hint')}</p>
        <form id="co-create" class="row" style="gap:8px;align-items:flex-end"><div class="field" style="flex:1;margin:0"><label for="co-name">${t('co.name')}</label>
          <input id="co-name" maxlength="80" required placeholder="${esc(tRaw('co.name.ph'))}"></div><button class="btn">${t('co.create.go')}</button></form></div>
      <div class="card"><h2>${t('co.code.title')}</h2><p class="hint">${t('co.code.hint')}</p>
        <form id="co-code" class="row" style="gap:8px;align-items:flex-end"><div class="field" style="flex:1;margin:0"><label for="co-c">${t('co.code.label')}</label>
          <input id="co-c" maxlength="6" required autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.15em"></div><button class="btn secondary">${t('co.code.go')}</button></form></div>`;
  } else if (cs.me.ownership === 'franchise') {
    body = `<div class="card"><h2>${esc(g.name)}</h2><p>${t('co.fr.text', { group: g.name, owner: g.ownerName || g.name })}</p>
        <p class="hint">${t('co.fr.hint')}</p><button type="button" class="btn ghost" id="co-leave">${t('co.leave')}</button></div>`;
  } else {
    const rows = cs.members.map((m) => `<li class="co-m">
        <div class="spread"><span><b>${esc(m.name)}</b>${m.area ? ` <span class="hint">· ${esc(m.area)}</span>` : ''}</span>
          <span class="co-badges">${m.isOwner ? `<span class="badge ok">${t('co.owner')}</span>` : ''}${m.isMe ? `<span class="badge">${t('co.me')}</span>` : ''}<span class="badge">${ownLabel(m.ownership)}</span>${m.status === 'pending' ? `<span class="badge warn">${t('co.pending')}</span>` : m.status === 'paused' ? `<span class="badge warn">${t('co.paused')}</span>` : ''}</span></div>
        ${g.isOwner && !m.isMe ? `<div class="row co-act">${m.managerToken ? `<a class="btn ghost small" href="#/p/${encodeURIComponent(m.managerToken)}">${t('co.open')}</a>` : ''}
          ${m.ownership === 'own' && m.status !== 'pending' ? `<button type="button" class="btn ghost small" data-co-tr="${esc(m.id)}">${t('co.transfer')}</button>` : ''}
          <button type="button" class="btn ghost small" data-co-rm="${esc(m.id)}">${t('co.remove')}</button></div>` : ''}</li>`).join('');
    body = g.isOwner ? `
      <div class="card"><h2>${t('co.settings')}</h2>
        <form id="co-set"><div class="field"><label for="co-gn">${t('co.name')}</label><input id="co-gn" maxlength="80" required value="${esc(g.name)}"></div>
          <fieldset class="co-mode"><legend>${t('co.mode')}</legend>
            <label class="co-opt"><input type="radio" name="mode" value="each"${g.payMode === 'each' ? ' checked' : ''}><span><b>${t('co.mode.each')}</b><br><span class="hint">${t('co.mode.each.hint')}</span></span></label>
            <label class="co-opt"><input type="radio" name="mode" value="single"${g.payMode === 'single' ? ' checked' : ''}><span><b>${t('co.mode.single')}</b><br><span class="hint">${t('co.mode.single.hint')}</span></span></label>
          </fieldset><button class="btn secondary">${t('common.save')}</button></form></div>
      <div class="card"><h2>${t('co.shops', { n: cs.members.length })}</h2><ul class="list co-list">${rows}</ul></div>
      <div class="card" id="co-add"><h2>${t('co.add.title')}</h2>
        <div class="co-choice"><button type="button" class="btn secondary" data-co-tab="new">${t('co.add.new')}</button><button type="button" class="btn secondary" data-co-tab="inv">${t('co.add.existing')}</button></div>
        <form id="co-new" hidden><p class="hint">${t('co.new.hint')}</p>
          <div class="field"><label for="co-nn">${t('co.new.name')}</label><input id="co-nn" maxlength="120" required placeholder="${esc(tRaw('co.new.name.ph'))}"></div>
          <div class="field"><label for="co-na">${t('co.new.area')}</label><input id="co-na" maxlength="120" placeholder="${esc(tRaw('co.new.area.ph'))}"></div>
          <div class="field"><label for="co-nd">${t('co.new.address')}</label><input id="co-nd" maxlength="200"></div>
          <button class="btn">${t('co.new.go')}</button></form>
        <div id="co-inv-new" hidden><p class="hint">${t('co.invite.hint')}</p>
          <fieldset class="co-mode"><legend>${t('co.invite.as')}</legend>
            <label class="co-opt"><input type="radio" name="iown" value="own" checked><span><b>${t('co.badge.own')}</b><br><span class="hint">${t('co.invite.own.hint')}</span></span></label>
            <label class="co-opt"><input type="radio" name="iown" value="franchise"><span><b>${t('co.badge.franchise')}</b><br><span class="hint">${t('co.invite.fr.hint')}</span></span></label>
          </fieldset><button type="button" class="btn" id="co-mk">${t('co.invite.go')}</button><div id="co-made"></div></div>
        ${cs.invites.length ? `<h3 style="margin:16px 0 6px">${t('co.invites')}</h3><ul class="list">${cs.invites.map((i) => `<li class="spread"><span><b class="co-code">${esc(i.code)}</b> · ${ownLabel(i.ownership)}<br><span class="hint">${t('co.invite.until', { day: new Date(i.expiresAt).toLocaleDateString() })}</span></span>
          <span class="row" style="gap:6px"><button type="button" class="btn ghost small" data-co-share="${esc(i.code)}">${t('co.share')}</button><button type="button" class="btn ghost small" data-co-cx="${esc(i.id)}">${t('co.cancel')}</button></span></li>`).join('')}</ul>` : ''}
      </div>
      <div class="card"><h2>${t('co.leave.title')}</h2><p class="hint">${t(cs.members.length > 1 ? 'co.leave.owner' : 'co.leave.alone')}</p>
        ${cs.members.length > 1 ? '' : `<button type="button" class="btn ghost" id="co-leave">${t('co.close')}</button>`}</div>`
    : `<div class="card"><h2>${esc(g.name)}</h2><p class="hint">${g.hasOwner ? t('co.member.text', { owner: g.ownerName }) : t('co.member.noowner')}</p>
        <ul class="list co-list">${rows}</ul><button type="button" class="btn ghost" id="co-leave">${t('co.leave')}</button></div>`;
  }

  return {
    html: `<div class="dash-wide co">${back}<h1>${t('co.title')}</h1>${g ? `<p class="hint">${t('co.sub', { name: g.name })}</p>` : `<p class="hint">${t('co.intro')}</p>`}
      ${inviteCard}${body}</div>`,
    mount(root) {
      const $ = (s) => root.querySelector(s);
      const go = (msg) => ctx.replace(`p/${key}/empresa`, msg);
      const run = async (btn, fn, okMsg) => {
        if (btn) btn.disabled = true;
        try { const r = await fn(); if (!r || !r.ok) throw r || {}; go(okMsg); return r; }
        catch (e) { if (btn) btn.disabled = false; notify(tRaw(e && e.reason && tRaw(`co.err.${e.reason}`) !== `co.err.${e.reason}` ? `co.err.${e.reason}` : 'err.generic')); return null; }
      };
      // Invitation
      if ($('#co-acc')) $('#co-acc').onclick = () => run($('#co-acc'), () => store.companyInviteAnswer(key, code, true), tRaw('co.inv.joined'));
      if ($('#co-ref')) confirmTwice($('#co-ref'), tRaw('co.inv.refuse.sure'), async () => { const r = await store.companyInviteAnswer(key, code, false); if (!r || !r.ok) throw new Error(); go(tRaw('co.inv.refused')); }, tRaw('err.generic'));
      // Sans groupe
      if ($('#co-create')) $('#co-create').onsubmit = (e) => { e.preventDefault(); run(e.submitter, () => store.companyCreate(key, $('#co-name').value.trim()), tRaw('co.created')); };
      if ($('#co-code')) $('#co-code').onsubmit = (e) => { e.preventDefault(); const c = $('#co-c').value.trim().toUpperCase(); if (c) location.hash = `#/p/${encodeURIComponent(key)}/empresa/${encodeURIComponent(c)}`; };
      // Responsável
      if ($('#co-set')) $('#co-set').onsubmit = (e) => { e.preventDefault(); const f = e.target; run(e.submitter, () => store.companyUpdate(key, $('#co-gn').value.trim(), f.mode.value), tRaw('common.saved')); };
      root.querySelectorAll('[data-co-tab]').forEach((b) => { b.onclick = () => {
        root.querySelectorAll('[data-co-tab]').forEach((x) => x.classList.toggle('on', x === b));
        $('#co-new').hidden = b.dataset.coTab !== 'new'; $('#co-inv-new').hidden = b.dataset.coTab !== 'inv';
      }; });
      if ($('#co-new')) $('#co-new').onsubmit = (e) => { e.preventDefault();
        run(e.submitter, () => store.companyAddShop(key, { name: $('#co-nn').value.trim(), area: $('#co-na').value.trim(), address: $('#co-nd').value.trim() }), tRaw('co.new.done')); };
      const share = async (c) => {
        const url = inviteLink(c); const text = tRaw('co.share.text', { group: g ? g.name : '', code: c, url });
        try { if (navigator.share) { await navigator.share({ text }); return; } } catch { return; }
        try { await navigator.clipboard.writeText(text); notify(tRaw('co.copied')); } catch { window.prompt(tRaw('co.copy'), text); }
      };
      if ($('#co-mk')) $('#co-mk').onclick = async () => {
        const b = $('#co-mk'); b.disabled = true;
        try {
          const r = await store.companyInvite(key, root.querySelector('[name="iown"]:checked').value);
          if (!r || !r.ok) throw r || {};
          $('#co-made').innerHTML = `<div class="notice ok co-made"><p>${t('co.invite.made')}</p><p class="co-big">${esc(r.code)}</p>
            <p class="hint" style="word-break:break-all">${esc(inviteLink(r.code))}</p><button type="button" class="btn" id="co-sh">${t('co.share')}</button></div>`;
          $('#co-sh').onclick = () => share(r.code);
        } catch (e) { notify(tRaw(e && e.reason === 'too_many' ? 'co.err.too_many' : 'err.generic')); }
        b.disabled = false;
      };
      root.querySelectorAll('[data-co-share]').forEach((b) => { b.onclick = () => share(b.dataset.coShare); });
      root.querySelectorAll('[data-co-cx]').forEach((b) => { b.onclick = () => run(b, () => store.companyInviteCancel(key, b.dataset.coCx), tRaw('co.cancelled')); });
      root.querySelectorAll('[data-co-rm]').forEach((b) => confirmTwice(b, tRaw('co.remove.sure'), async () => { const r = await store.companyRemove(key, b.dataset.coRm); if (!r || !r.ok) throw new Error(); go(tRaw('co.removed')); }, tRaw('err.generic')));
      root.querySelectorAll('[data-co-tr]').forEach((b) => confirmTwice(b, tRaw('co.transfer.sure'), async () => { const r = await store.companyTransfer(key, b.dataset.coTr); if (!r || !r.ok) throw new Error(); go(tRaw('co.transferred')); }, tRaw('err.generic')));
      if ($('#co-leave')) confirmTwice($('#co-leave'), tRaw('co.leave.sure'), async () => { const r = await store.companyLeave(key); if (!r || !r.ok) throw new Error(r && r.reason); go(tRaw('co.left')); }, tRaw('co.err.owner'));
    },
  };
}

// #/grupo/CODE : le lien envoyé par le responsável. On ouvre la loja enregistrée sur ce téléphone, sinon on explique.
export function groupInviteView([code = ''], ctx, meKey) {
  let mine = null;
  try { mine = localStorage.getItem(meKey); } catch { /* rien */ }
  const c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (mine && mine.startsWith('G-')) return { html: '', mount: () => ctx.replace(`p/${mine}/empresa/${c}`) };
  return { html: `<div class="card co-invite"><h1>${t('co.inv.title')}</h1><p>${t('co.inv.nophone')}</p><p class="co-big">${esc(c)}</p>
    <p class="hint">${t('co.inv.nophone.hint')}</p><a class="btn" href="#/">${t('co.inv.login')}</a></div>` };
}
