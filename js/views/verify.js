// Vérification d'un crachá de guide (v35) : la vendeuse scanne le QR du badge.
// Montre seulement le nom du crachá, le nom complet (qui confirme l'identité), la photo, le code, la ville et le statut. Jamais CPF, Pix, téléphone ou e-mail.
import { t } from '../i18n.js';
import { esc, fmtDay, notify, appLink } from '../util.js';
import * as store from '../store.js';

export async function verifyView([token = '']) {
  const b = /^B-[a-f0-9]{32}$/.test(token) ? await store.guideBadge(token) : null;
  const now = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date());
  if (!b) {
    return { html: `<div class="vf"><div class="vf-state bad"><b>${t('vf.none.title')}</b><span>${t('vf.none.text')}</span></div>
      <p class="hint" style="text-align:center">${t('vf.checked', { at: now })}</p></div>` };
  }
  const st = { ok: ['ok', 'vf.ok'], cadastur: ['warn', 'vf.cadastur'], suspended: ['bad', 'vf.suspended'] }[b.state] || ['bad', 'vf.suspended'];
  const shown = b.badge_name || b.name;
  const initials = String(shown || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return {
    html: `<div class="vf">
      <div class="vf-state ${st[0]}"><b>${t(`${st[1]}.title`)}</b><span>${t(`${st[1]}.text`)}</span></div>
      <div class="card vf-card">
        ${b.photo ? `<img class="vf-photo" src="${esc(b.photo)}" alt="${esc(t('vf.photo'))}">` : `<div class="vf-photo vf-initials" aria-hidden="true">${esc(initials)}</div>`}
        <h1>${esc(shown)}</h1>
        ${b.name && b.name !== shown ? `<p style="margin:0 0 4px">${t('vf.fullname', { name: b.name })}</p>` : ''}
        <p class="hint" style="margin:0">${t('vf.role')}${b.city ? ` · ${esc(b.city)}` : ''}</p>
        <div class="vf-code">${esc(b.code || '')}</div>
        ${b.cadastur_valid_until ? `<p class="hint" style="margin:0">${t('vf.cad', { date: fmtDay(b.cadastur_valid_until, 'pt') })}</p>` : ''}
        ${b.is_test ? `<p class="badge warn" style="margin-top:8px">${t('vf.test')}</p>` : ''}
      </div>
      ${partnerKey() && b.state === 'ok' ? `<div class="card no-print"><p style="margin:0 0 10px"><b>${t('ph.ask')}</b></p><button class="btn block" id="vf-present">${t('vf.present.yes')}</button>
        <button class="btn ghost block" id="vf-notme" style="margin-top:8px">${t('ph.ask.no')}</button>
        <p class="hint" style="margin:8px 0 0">${t('vf.present.hint')}</p><div id="vf-present-msg"></div>
        <a class="btn secondary block" style="margin-top:10px" href="${esc(appLink('partner', `p/${encodeURIComponent(partnerKey())}/venda/${token}`))}">${t('vd.from.badge')}</a></div>` : ''}
      <ol class="vf-steps"><li>${t('vf.step1')}</li><li>${t('vf.step2')}</li></ol>
      <p class="hint" style="text-align:center">${t('vf.checked', { at: now })}</p>
    </div>`,
    // v59 : téléphone relié à un partenaire → il peut enregistrer la présence du guide.
    mount(root) {
      const btn = root.querySelector('#vf-present');
      if (!btn) return;
      // v136 : la personne n'est pas celle de la photo → rien n'est enregistré, Kombrio est alertée.
      root.querySelector('#vf-notme').onclick = async (e) => {
        e.target.disabled = true; btn.disabled = true;
        await store.guidePhotoMismatch(partnerKey(), token).catch(() => null);
        root.querySelector('#vf-present-msg').innerHTML = `<div class="notice bad" style="margin-top:8px">${t('ph.no.done')}</div>`;
      };
      btn.onclick = async () => {
        btn.disabled = true;
        const box = root.querySelector('#vf-present-msg');
        try {
          const r = await store.markGuidePresent(partnerKey(), token);
          if (r && r.ok) box.innerHTML = `<div class="notice ok" style="margin-top:8px">${t('vf.present.ok', { name: r.name, n: r.visits })}</div>`;
          else if (r && r.reason === 'no_photo') box.innerHTML = `<div class="notice bad" style="margin-top:8px">${t('bill.err.no_photo')}</div>`;
          else if (r && r.reason === 'elsewhere') box.innerHTML = `<div class="notice bad" style="margin-top:8px">${t('vf.present.elsewhere', { n: r.minutes, place: r.place || '?' })}</div>`;
          else { btn.disabled = false; notify(t('vf.present.err')); }
        } catch { btn.disabled = false; notify(t('vf.present.err')); }
      };
    },
  };
}

function partnerKey() {
  try { return localStorage.getItem('kombrio-partner'); } catch { return null; }
}
