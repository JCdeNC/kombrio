// Admin › Avisos (v117, script 069) : écrire un message une fois, l'envoyer aux groupes Kombrio, suivre qui l'a lu.
//   Public : guides, Tour Companies, agences, gérants des partenaires, équipes des partenaires (avec la caisse).
//   Niveau : info (bandeau) · important (bandeau + e-mail) · legal (bandeau + e-mail + « Li e entendi » obligatoire).
import { t, tRaw, getLang } from '../i18n.js';
import { esc, fmtMoment, notify } from '../util.js';
import * as store from '../store.js';
import { bcPick, bcBody } from './broadcast.js';

const AUD = ['guide', 'tc', 'agency', 'partner', 'staff'];
const LEVELS = ['info', 'important', 'legal'];
const TR = ['fr', 'en', 'es', 'de'];

// Modèles prêts à adapter (portugais).
const TEMPLATES = {
  inss: { audience: ['guide', 'tc', 'agency'], level: 'legal',
    title: 'Nova alíquota de INSS a partir de 01/01/2027',
    body: 'A partir de 01/01/2027, a alíquota de INSS retida sobre os seus repasses passa de 11 % para X %, conforme [norma / portaria].\n\nO que muda para você: o valor retido aparece no detalhe de cada repasse e no recibo (RPA). Você não precisa fazer nada no aplicativo.\n\nDúvidas: Ajuda › Falar com a Kombrio.' },
  terms: { audience: ['guide', 'tc', 'agency', 'partner'], level: 'important',
    title: 'Atualização dos termos de uso',
    body: 'Os termos de uso da Kombrio foram atualizados. Na próxima vez que abrir o aplicativo, você verá o novo texto para aceitar.\n\nResumo das mudanças: [...]' },
  info: { audience: ['guide', 'tc', 'agency', 'partner', 'staff'], level: 'info',
    title: 'Novidade no aplicativo',
    body: '[Descreva a novidade em 2 ou 3 frases.]' },
};

const levelBadge = (l) => `<span class="badge ${l === 'legal' ? 'bad' : l === 'important' ? 'warn' : ''}">${t(`admin.bc.level.${l}`)}</span>`;

export async function avisosAdmin({ guides = [], partnerList = [] }) {
  const list = await store.adminBroadcasts();
  if (list === null) return { html: `<div class="card"><h2>${t('admin.tab.avisos')}</h2><div class="notice warn">${t('admin.bc.noscript')}</div></div>` };
  const lang = getLang();
  // Nombre de destinataires (hors équipes, que l'admin ne voit pas ici) et d'adresses e-mail.
  const count = (aud) => {
    const g = guides.filter((x) => x.status === 'validated' && aud.includes(x.actorKind || 'guide'));
    const p = aud.includes('partner') ? partnerList.filter((x) => x.status === 'active') : [];
    return { people: g.length + p.length, mails: g.filter((x) => x.email).length + p.filter((x) => x.managerEmail).length, staff: aud.includes('staff') };
  };
  const field = (l, kind) => kind === 'title'
    ? `<input name="title_${l}" maxlength="120"${l === 'pt' ? ' required' : ''} placeholder="${esc(tRaw(`admin.bc.title.ph`))}">`
    : `<textarea name="body_${l}" rows="${l === 'pt' ? 7 : 4}" maxlength="4000"${l === 'pt' ? ' required' : ''}></textarea>`;
  const active = list.filter((b) => !b.archivedAt);
  const archived = list.filter((b) => b.archivedAt);
  const item = (b) => {
    const tg = b.targets || 0;
    const pct = (n) => (tg ? Math.round((n / tg) * 100) : 0);
    return `<li class="bc-row" data-id="${esc(b.id)}">
      <div class="spread"><span><b>nº ${esc(b.num)} · ${esc(bcPick(b.title, lang))}</b></span>${levelBadge(b.level)}</div>
      <div class="hint">${fmtMoment(b.createdAt, lang)} · ${b.audience.map((a) => esc(tRaw(`admin.bc.aud.${a}`))).join(', ')}${b.emails ? ` · ${t('admin.bc.emails', { n: b.emails })}` : ''}</div>
      <div class="bc-stats">
        <span>${t('admin.bc.seen', { n: b.seen || 0, total: tg })}</span><i class="bc-bar"><i style="width:${pct(b.seen || 0)}%"></i></i>
        ${b.level === 'legal' ? `<span>${t('admin.bc.acked', { n: b.acked || 0, total: tg })}</span><i class="bc-bar ok"><i style="width:${pct(b.acked || 0)}%"></i></i>` : ''}
      </div>
      <details class="bc-det"><summary>${t('admin.bc.details')}</summary>
        <div class="bc-text">${bcBody(bcPick(b.body, lang))}</div>
        <p class="hint">${t('admin.bc.langs', { list: ['pt', ...TR].filter((l) => (b.title[l] || '').trim()).join(', ') })}</p>
        <div class="bc-readers" data-readers="${esc(b.id)}"><button type="button" class="btn small ghost" data-load="${esc(b.id)}">${t('admin.bc.who')}</button></div>
      </details>
      <p style="margin:6px 0 0;text-align:right"><button type="button" class="btn ghost small" data-arch="${esc(b.id)}" data-on="${b.archivedAt ? '' : '1'}">${t(b.archivedAt ? 'admin.bc.unarchive' : 'admin.bc.archive')}</button></p>
    </li>`;
  };

  return {
    html: `<div class="card">
        <h2>${t('admin.bc.new')}</h2>
        <p class="hint">${t('admin.bc.intro')}</p>
        <p class="row" style="gap:6px;flex-wrap:wrap">${t('admin.bc.tpl')} ${Object.keys(TEMPLATES).map((k) => `<button type="button" class="btn ghost small" data-tpl="${k}">${t(`admin.bc.tpl.${k}`)}</button>`).join('')}</p>
        <form id="bc-form">
          <fieldset class="bc-fs"><legend>${t('admin.bc.who.title')}</legend>
            <div class="bc-chips">${AUD.map((a) => `<label class="bc-chip"><input type="checkbox" name="aud" value="${a}"><span>${t(`admin.bc.aud.${a}`)}</span></label>`).join('')}</div>
            <p class="hint" id="bc-count"></p></fieldset>
          <fieldset class="bc-fs"><legend>${t('admin.bc.level.title')}</legend>
            <div class="bc-levels">${LEVELS.map((l) => `<label class="bc-lv bc-lv-${l}"><input type="radio" name="level" value="${l}"${l === 'info' ? ' checked' : ''}>
              <span><b>${t(`admin.bc.level.${l}`)}</b><small>${t(`admin.bc.level.${l}.hint`)}</small></span></label>`).join('')}</div></fieldset>
          <div class="field"><label>${t('admin.bc.title')} <span class="hint">(pt)</span></label>${field('pt', 'title')}</div>
          <div class="field"><label>${t('admin.bc.body')} <span class="hint">(pt)</span></label>${field('pt', 'body')}
            <p class="hint">${t('admin.bc.body.hint')}</p></div>
          <details class="bc-tr"><summary>${t('admin.bc.tr')}</summary>
            <p class="hint">${t('admin.bc.tr.hint')}</p>
            ${TR.map((l) => `<div class="bc-trl"><b>${l.toUpperCase()}</b>${field(l, 'title')}${field(l, 'body')}</div>`).join('')}
          </details>
          <div class="bc-preview" id="bc-prev" hidden></div>
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
            <button type="button" class="btn secondary" id="bc-see">${t('admin.bc.preview')}</button>
            <button class="btn">${t('admin.bc.send')}</button></div>
        </form></div>
      <div class="card"><h2>${t('admin.bc.sent')}</h2>
        ${active.length ? `<ul class="bc-list">${active.map(item).join('')}</ul>` : `<p class="hint">${t('admin.bc.none')}</p>`}
        ${archived.length ? `<details><summary class="hint">${t('admin.bc.archived', { n: archived.length })}</summary><ul class="bc-list">${archived.map(item).join('')}</ul></details>` : ''}
        <p class="hint">${t('admin.bc.mailnote')}</p></div>`,
    mount(root, ctx) {
      const f = root.querySelector('#bc-form');
      const aud = () => [...f.querySelectorAll('[name=aud]:checked')].map((x) => x.value);
      const level = () => f.querySelector('[name=level]:checked').value;
      const texts = (k) => Object.fromEntries(['pt', ...TR].map((l) => [l, (f[`${k}_${l}`].value || '').trim()]).filter(([, v]) => v));
      const refreshCount = () => {
        const a = aud(); const c = count(a); const el = root.querySelector('#bc-count');
        if (!a.length) { el.textContent = tRaw('admin.bc.count.none'); return; }
        el.textContent = tRaw('admin.bc.count', { n: c.people }) + (c.staff ? ` ${tRaw('admin.bc.count.staff')}` : '')
          + (level() === 'info' ? '' : ` · ${tRaw('admin.bc.count.mails', { n: c.mails })}`);
      };
      f.addEventListener('change', refreshCount); refreshCount();
      root.querySelectorAll('[data-tpl]').forEach((b) => { b.onclick = () => {
        const x = TEMPLATES[b.dataset.tpl];
        f.querySelectorAll('[name=aud]').forEach((c) => { c.checked = x.audience.includes(c.value); });
        f.querySelector(`[name=level][value=${x.level}]`).checked = true;
        f.title_pt.value = x.title; f.body_pt.value = x.body; refreshCount(); f.title_pt.focus();
      }; });
      root.querySelector('#bc-see').onclick = () => {
        const p = root.querySelector('#bc-prev'); const ti = texts('title'); const bo = texts('body');
        if (!ti.pt || !bo.pt) { notify(tRaw('admin.bc.err.pt')); return; }
        p.hidden = false;
        p.innerHTML = `<p class="hint">${t('admin.bc.preview.hint')}</p><div class="bc-banner bc-${level() === 'legal' ? 'important' : level()}">
          <div class="bc-head"><span class="bc-ico">${level() === 'info' ? 'i' : '!'}</span><div class="bc-main"><b>${esc(ti.pt)}</b><span class="hint">${t(`admin.bc.level.${level()}`)}</span></div></div>
          <div class="bc-text">${bcBody(bo.pt)}</div>${level() === 'legal' ? `<p class="bc-foot"><span class="btn small">${t('admin.bc.preview.ack')}</span></p>` : ''}</div>`;
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const a = aud(); const lv = level(); const ti = texts('title'); const bo = texts('body');
        if (!a.length) { notify(tRaw('admin.bc.err.aud')); return; }
        if (!ti.pt || !bo.pt) { notify(tRaw('admin.bc.err.pt')); return; }
        const c = count(a);
        const msg = tRaw('admin.bc.confirm', { title: ti.pt, level: tRaw(`admin.bc.level.${lv}`), who: a.map((x) => tRaw(`admin.bc.aud.${x}`)).join(', '), n: c.people })
          + (lv === 'info' ? '' : `\n${tRaw('admin.bc.confirm.mails', { n: c.mails })}`) + (lv === 'legal' ? `\n${tRaw('admin.bc.confirm.legal')}` : '');
        if (!confirm(msg)) return;
        const btn = f.querySelector('button.btn:not(.secondary)'); btn.disabled = true;
        try {
          const r = await store.adminBroadcastSend(a, lv, ti, bo);
          if (!r || !r.ok) throw new Error();
          ctx.refresh(tRaw('admin.bc.done', { num: r.num, n: r.emails || 0 }));
        } catch { btn.disabled = false; notify(tRaw('err.generic')); }
      };
      root.querySelectorAll('[data-load]').forEach((b) => { b.onclick = async () => {
        const box = root.querySelector(`[data-readers="${b.dataset.load}"]`);
        b.disabled = true;
        const rows = await store.adminBroadcastReaders(b.dataset.load).catch(() => null);
        if (!rows) { b.disabled = false; notify(tRaw('err.generic')); return; }
        const st = (r) => (r.acked_at ? `<span class="badge ok">${t('admin.bc.r.acked')}</span> <span class="hint">${fmtMoment(r.acked_at, lang)}</span>`
          : r.seen_at ? `<span class="badge">${t('admin.bc.r.seen')}</span> <span class="hint">${fmtMoment(r.seen_at, lang)}</span>` : `<span class="badge warn">${t('admin.bc.r.not')}</span>`);
        box.innerHTML = rows.length ? `<table class="bc-tbl"><tbody>${rows.map((r) => `<tr><td>${esc(r.name)} <span class="hint">· ${esc(tRaw(`admin.bc.aud.${r.group}`))}</span></td><td>${st(r)}</td></tr>`).join('')}</tbody></table>`
          : `<p class="hint">${t('admin.bc.r.empty')}</p>`;
      }; });
      root.querySelectorAll('[data-arch]').forEach((b) => { b.onclick = async () => {
        try { await store.adminBroadcastArchive(b.dataset.arch, !!b.dataset.on); ctx.refresh(); } catch { notify(tRaw('err.generic')); }
      }; });
    },
  };
}
