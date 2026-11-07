// Vérification d'un crachá de guide (v35) : la vendeuse scanne le QR du badge.
// Montre seulement le nom du crachá, le nom complet (qui confirme l'identité), la photo, le code, la ville et le statut. Jamais CPF, Pix, téléphone ou e-mail.
import { t } from '../i18n.js';
import { esc, fmtDay } from '../util.js';
import * as store from '../store.js';

export async function verifyView([token = '']) {
  const b = /^B-[a-f0-9]{32}$/.test(token) ? await store.guideBadge(token) : null;
  const now = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
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
      <ol class="vf-steps"><li>${t('vf.step1')}</li><li>${t('vf.step2')}</li></ol>
      <p class="hint" style="text-align:center">${t('vf.checked', { at: now })}</p>
    </div>`,
  };
}
