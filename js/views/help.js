// Bouton d'aide (v33) commun au guide et au partenaire.
// 1. La personne décrit son problème ou choisit un sujet : l'assistant répond avec la FAQ (mots-clés, pas d'IA).
// 2. Si la réponse ne suffit pas, elle envoie une alerte à Kombrio, jamais à l'autre partie.
import { t, tRaw } from '../i18n.js';
import { esc } from '../util.js';
import * as store from '../store.js';

export const HELP_TOPICS = {
  guide: ['late', 'amount', 'noqr', 'payout', 'pix', 'offer', 'conduct'],
  partner: ['howpay', 'late', 'wrong', 'noqr', 'rejected', 'disputed', 'guide'],
};
// Sujets sans réponse automatique : une personne de Kombrio doit les voir.
const HUMAN = ['offer', 'conduct', 'guide'];
const pre = (kind) => (kind === 'guide' ? 'help.g.' : 'help.p.');
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const topicLabel = (kind, k) => (HELP_TOPICS[kind].includes(k) ? tRaw(`${pre(kind)}${k}.l`) : tRaw('help.topic.other'));
export const alertStatus = (st) => tRaw(`alert.st.${st}`);

function findTopic(kind, q) {
  // Le mot-clé le plus long trouvé l'emporte (« não consigo pagar » plutôt que « pagar »).
  const text = plain(q);
  let best = null; let len = 0;
  HELP_TOPICS[kind].forEach((k) => tRaw(`${pre(kind)}${k}.k`).split('|').map(plain).forEach((w) => {
    if (w && text.includes(w) && w.length > len) { best = k; len = w.length; }
  }));
  return best;
}

// Petit bouton « ? Ajuda » à placer dans un en-tête.
export const helpButton = () => `<button type="button" class="btn ghost small no-print" data-help-open="">${t('help.btn')}</button>`;
// Lien « Um problema? » sous une ligne (commission ou visite).
export const problemLink = (visitId) => `<button type="button" class="link-btn no-print" data-help-open="${esc(visitId)}">${t('help.problem')}</button>`;

// Ouvre la fenêtre d'aide. send(topic, message, visitId) renvoie { ok, num, reason }.
export function openHelp({ kind, about = '', visitId = null, send, onSent }) {
  const st = { step: 'ask', q: '', topic: null, num: null };
  const o = document.createElement('div');
  o.className = 'overlay';
  const close = () => { o.remove(); if (st.step === 'sent' && onSent) onSent(); };
  const draw = () => {
    const f = st.topic && HELP_TOPICS[kind].includes(st.topic) ? st.topic : null;
    let body = '';
    if (st.step === 'ask') {
      body = `<div class="field"><label for="help-q">${t('help.describe')}</label>
          <textarea id="help-q" rows="2" maxlength="500" placeholder="${t(`help.ph.${kind}`)}">${esc(st.q)}</textarea></div>
        <button class="btn block" data-h="search">${t('help.search')}</button>
        <p class="hint" style="margin:10px 0 6px">${t('help.or')}</p>
        <div class="help-chips">${HELP_TOPICS[kind].map((k) => `<button type="button" data-topic="${k}">${t(`${pre(kind)}${k}.l`)}</button>`).join('')}</div>`;
    } else if (st.step === 'answer') {
      const auto = f && !HUMAN.includes(f);
      body = `<div class="help-ai"><b>${auto ? `${t('help.ai')} · ` : ''}${f ? t(`${pre(kind)}${f}.l`) : t('help.noanswer')}</b>
          <p>${auto ? t(`${pre(kind)}${f}.a`) : f ? t('help.human') : t('help.nomatch')}</p></div>
        <div class="row" style="gap:6px">${auto ? `<button class="btn" data-h="ok">${t('help.ok')}</button><button class="btn secondary" data-h="form">${t('help.no')}</button>`
          : `<button class="btn" data-h="form">${t('help.notify')}</button>`}</div>`;
    } else if (st.step === 'form') {
      body = `<div class="field"><label for="help-topic">${t('help.subject')}</label><select id="help-topic">
          ${HELP_TOPICS[kind].map((k) => `<option value="${k}"${k === f ? ' selected' : ''}>${t(`${pre(kind)}${k}.l`)}</option>`).join('')}
          <option value="other"${f ? '' : ' selected'}>${t('help.topic.other')}</option></select></div>
        <div class="field"><label for="help-msg">${t('help.message')}</label><textarea id="help-msg" rows="3" maxlength="1000" placeholder="${t('help.msg.ph')}">${esc(st.q)}</textarea></div>
        <p class="hint">${t(`help.only.${kind}`)}</p>
        <button class="btn block" data-h="send">${t('help.send')}</button>`;
    } else {
      body = `<div class="notice ok"><b>${t('help.sent', { num: st.num })}</b><br>${t('help.sent.text')}</div>
        <button class="btn block" data-h="close">${t('help.close')}</button>`;
    }
    o.innerHTML = `<div class="sheet help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="spread"><h2 id="help-title" style="margin:0">${t('help.title')}</h2><button class="btn ghost small" data-h="close">${t('help.close')}</button></div>
      ${about ? `<p class="hint" style="margin:0">${t('help.about', { what: about })}</p>` : ''}${body}</div>`;
    const q = o.querySelector('#help-q'); if (q) q.focus();
  };
  o.addEventListener('click', async (e) => {
    if (e.target === o) { close(); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.topic) { st.topic = b.dataset.topic; st.step = 'answer'; draw(); return; }
    const h = b.dataset.h;
    if (h === 'close') close();
    else if (h === 'search') { st.q = o.querySelector('#help-q').value.trim(); st.topic = findTopic(kind, st.q) || null; st.step = 'answer'; draw(); }
    else if (h === 'ok') { store.countFaqSolved(kind, st.topic); o.remove(); }
    else if (h === 'form') { st.step = 'form'; draw(); }
    else if (h === 'send') {
      b.disabled = true;
      const topic = o.querySelector('#help-topic').value; const msg = o.querySelector('#help-msg').value.trim();
      try {
        const r = await send(topic, msg, visitId);
        if (!r || !r.ok) { b.disabled = false; alertBox(o, r && r.reason === 'quota' ? 'help.quota' : 'err.generic'); return; }
        st.num = r.num; st.step = 'sent'; draw();
      } catch { b.disabled = false; alertBox(o, 'err.generic'); }
    }
  });
  document.addEventListener('keydown', function esc_(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc_); } });
  draw();
  document.body.appendChild(o);
}
function alertBox(o, key) {
  o.querySelector('.help-err')?.remove();
  const d = document.createElement('div'); d.className = 'notice bad help-err'; d.setAttribute('role', 'alert'); d.textContent = tRaw(key);
  o.querySelector('.sheet').appendChild(d);
}

// Relie les boutons « Ajuda » et « Um problema? » d'un écran. label(visitId) donne le texte « à propos de ».
export function mountHelp(root, { kind, send, label = () => '', onSent }) {
  root.querySelectorAll('[data-help-open]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const v = b.dataset.helpOpen || null; openHelp({ kind, visitId: v, about: v ? label(v) : '', send, onSent }); };
  });
}
