// v117 : avisos de Kombrio (script 069) — affichage côté guide, TC/agence, partenaire et équipe.
//   info / important : bandeau qu'on ferme (lu) ; legal : écran de lecture obligatoire « Li e entendi » avant de continuer.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, fmtDay } from '../util.js';

// Texte dans la langue de l'app, sinon en portugais.
export const bcPick = (o, lang = getLang()) => String((o && (o[lang] || '').trim()) ? o[lang] : (o && o.pt) || '');
// Texte simple → paragraphes (aucun HTML accepté).
export const bcBody = (s) => esc(String(s || '').trim()).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

// Premier aviso légal pas encore confirmé → écran bloquant ; sinon null.
export function broadcastGate(list, ack) {
  const b = (list || []).filter((x) => x.level === 'legal' && !x.ackedAt).sort((a, c) => new Date(a.createdAt) - new Date(c.createdAt))[0];
  if (!b) return null;
  const more = list.filter((x) => x.level === 'legal' && !x.ackedAt).length - 1;
  return {
    html: `<article class="card bc-gate">
      <p class="bc-kicker"><span class="badge bad">${t('bc.level.legal')}</span> <span class="hint">${t('bc.from', { date: fmtDay(String(b.createdAt).slice(0, 10), getLang()) })}</span></p>
      <h1>${esc(bcPick(b.title))}</h1>
      <div class="bc-text">${bcBody(bcPick(b.body))}</div>
      <form id="bc-ack" style="margin-top:16px">
        <label class="bc-check"><input type="checkbox" name="ok" required><span>${t('bc.ack.check')}</span></label>
        <button class="btn block">${t('bc.ack.btn')}</button>
        <p class="hint bc-err" hidden style="color:var(--bad)">${t('err.generic')}</p>
      </form>
      ${more > 0 ? `<p class="hint" style="text-align:center;margin:10px 0 0">${t('bc.ack.more', { n: more })}</p>` : ''}
    </article>`,
    mount(root, ctx) {
      const f = root.querySelector('#bc-ack');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button'); btn.disabled = true;
        const r = await ack(b.id).catch(() => null);
        if (r && r.ok) return ctx.refresh();
        btn.disabled = false; f.querySelector('.bc-err').hidden = false;
      };
    },
  };
}

// Bandeaux des avisos pas encore lus (info, important).
export function broadcastBanners(list) {
  const open = (list || []).filter((x) => x.level !== 'legal' && !x.seenAt);
  if (!open.length) return '';
  return `<div class="bc-banners no-print">${open.map((b) => {
    const body = bcPick(b.body); const long = body.length > 220;
    return `<div class="bc-banner bc-${esc(b.level)}" data-bc="${esc(b.id)}">
      <div class="bc-head"><span class="bc-ico" aria-hidden="true">${b.level === 'important' ? '!' : 'i'}</span>
        <div class="bc-main"><b>${esc(bcPick(b.title))}</b>
          <span class="hint">${t(`bc.level.${b.level}`)} · ${fmtDay(String(b.createdAt).slice(0, 10), getLang())}</span></div>
        <button type="button" class="bc-close" data-bc-close aria-label="${esc(tRaw('bc.close'))}">×</button></div>
      ${long ? `<details class="bc-more"><summary>${esc(body.slice(0, 200).replace(/\s+\S*$/, ''))}… <u>${t('bc.read')}</u></summary><div class="bc-text">${bcBody(body)}</div></details>`
        : `<div class="bc-text">${bcBody(body)}</div>`}
      <p class="bc-foot"><button type="button" class="btn small secondary" data-bc-close>${t('bc.ok')}</button></p></div>`;
  }).join('')}</div>`;
}

export function mountBroadcastBanners(root, seen) {
  root.querySelectorAll('[data-bc]').forEach((el) => {
    el.querySelectorAll('[data-bc-close]').forEach((b) => { b.onclick = () => { seen(el.dataset.bc).catch(() => null); el.remove(); }; });
  });
}
