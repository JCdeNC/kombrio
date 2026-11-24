// v134 (« dossier Pierim », lot 1) : IMPORT DU RELEVÉ DU MOIS par le gérant.
// Le partenaire suit déjà les ventes des guides dans son logiciel ou sa planilha : il dépose le fichier (Excel, CSV),
// indique UNE fois quelle colonne est quoi (Kombrio retient le modèle), relie ses propres codes guides aux guides Kombrio,
// vérifie, puis importe. Chaque ligne devient une vente « guide présent » (mode 2) à sa date ; le paiement passe par « Pagar ».
// Seules les colonnes choisies sont envoyées (jamais le nom ou le CPF des clients). Compatible iOS 13.4 / Chrome 80.
import { t, tRaw, getLang } from '../i18n.js';
import { esc, cents, notify, todayIn } from '../util.js';
import * as store from '../store.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const MAX_ROWS = 2000;
// Champs Kombrio, dans l'ordre d'affichage ; « need » = obligatoire. Mots-clés pour deviner la colonne (sans accents, minuscules).
const FIELDS = [
  ['date', true, ['data', 'date', 'dia', 'emissao', 'venda em']],
  ['guide_code', false, ['cod guia', 'codigo guia', 'cod. guia', 'guia cod', 'code guide', 'id guia', 'cod guide', 'guia']],
  ['guide_name', false, ['nome guia', 'nome do guia', 'guide', 'guia nome', 'nom guide', 'guia']],
  ['invoice', true, ['valor', 'total', 'venda', 'montant', 'liquido', 'vlr']],
  ['commission', false, ['comissao', 'commission', 'com.']],
  ['ticket', false, ['ticket', 'cupom', 'nota', 'nf', 'pedido', 'n venda', 'numero', 'documento', 'doc']],
  ['seller', false, ['vendedor', 'vendedora', 'vendeuse', 'atendente', 'cod vend', 'vend.', 'vend']],
  ['people', false, ['pessoas', 'pax', 'clientes', 'qtd pessoas']],
  ['time', false, ['hora', 'heure', 'horario']],
];
const plain = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ---------- lecture du fichier ----------
const loadXlsx = () => new Promise((resolve, reject) => {
  if (window.XLSX) { resolve(window.XLSX); return; }
  const el = document.createElement('script'); el.src = XLSX_URL;
  el.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('xlsx')));
  el.onerror = reject; document.head.appendChild(el);
});
function parseCsv(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const sep = [';', '\t', ','].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function readTable(file) {
  const name = file.name || '';
  if (/\.(csv|txt)$/i.test(name)) return parseCsv(await file.text());
  const X = await loadXlsx();
  const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}
// Ligne d'en-têtes : la première, parmi les 15 premières, qui a au moins 3 cases de texte.
function headerIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if ((rows[i] || []).filter((c) => typeof c === 'string' && c.trim()).length >= 3) return i;
  }
  return 0;
}

// ---------- valeurs ----------
const pad = (n) => String(n).padStart(2, '0');
function toDay(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) {   // date Excel (jours depuis 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}
function toTime(v) {
  if (v instanceof Date && !isNaN(v)) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  if (typeof v === 'number' && v >= 0 && v < 1) { const mn = Math.round(v * 1440); return `${pad(Math.floor(mn / 60) % 24)}:${pad(mn % 60)}`; }
  const m = String(v == null ? '' : v).match(/(\d{1,2})[:hH](\d{2})/);
  return m && +m[1] < 24 ? `${pad(m[1])}:${m[2]}` : null;
}
function toCents(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v == null ? '' : v).replace(/R\$|BRL|€|\s/gi, '');
  if (!s) return null;
  const neg = /^-|^\(.*\)$/.test(s); s = s.replace(/[()\-+]/g, '');
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) s = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const c = Math.round(parseFloat(s) * 100);
  return neg ? -c : c;
}
const txt = (v) => String(v == null ? '' : (v instanceof Date ? toDay(v) : v)).trim();

// ---------- devinette des colonnes ----------
function guessMapping(headers, saved) {
  const map = {};
  const used = new Set();
  const keys = headers.map(plain);
  if (saved) {
    FIELDS.forEach(([f]) => {
      const want = plain(saved[f]); if (!want) return;
      const i = keys.indexOf(want); if (i >= 0 && !used.has(i)) { map[f] = i; used.add(i); }
    });
  }
  FIELDS.forEach(([f, , words]) => {
    if (map[f] != null) return;
    let best = -1;
    words.some((w) => { best = keys.findIndex((k, i) => !used.has(i) && k && (k === w || k.indexOf(w) >= 0)); return best >= 0; });
    if (best >= 0) { map[f] = best; used.add(best); }
  });
  return map;
}

// ---------- écran ----------
export async function importView(space, ctx) {
  const { partner, city, key } = space;
  const lang = getLang();
  const c = (n) => cents(n, city.currency, lang);
  const base = `#/p/${encodeURIComponent(key)}`;
  const info = await store.importSpace(key);
  if (!info) return { html: `<a class="ios-back" href="${base}"><span aria-hidden="true">‹</span> ${t('ios.back.home')}</a><div class="notice warn">${t('imp.unavailable')}</div>` };

  const today = todayIn(city.timezone);
  const months = [0, 1, 2].map((k) => { const d = new Date(`${today.slice(0, 7)}-15T12:00:00`); d.setMonth(d.getMonth() - k); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
  const defMonth = +today.slice(8, 10) <= 15 ? months[1] : months[0];
  const monthName = (ym) => new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-15T12:00:00Z`));
  const st = { month: defMonth, file: '', headers: [], rows: [], map: {}, guides: [], step: 'file' };

  const historyHtml = () => (info.imports || []).length ? `<div class="card"><h2>${t('imp.history')}</h2><ul class="list">${info.imports.map((i) => `<li class="spread">
      <span><b>${esc(monthName(String(i.month).slice(0, 7)))}</b> · ${esc(i.file || '')}<br><span class="hint">${t('imp.history.line', { ok: i.ok, total: i.total, com: c(i.commission_cents || 0) })}${i.status === 'cancelled' ? ` · ${t('imp.cancelled')}` : ''}</span></span>
      ${i.can_undo ? `<button type="button" class="btn ghost small" data-undo="${esc(i.id)}">${t('imp.undo')}</button>` : ''}</li>`).join('')}</ul></div>` : '';

  const fileStep = () => `<div class="card"><h1>${t('imp.title')}</h1><p class="hint">${t('imp.intro')}</p>
      <label for="imp-m">${t('imp.month')}</label><select id="imp-m">${months.map((m) => `<option value="${m}"${m === st.month ? ' selected' : ''}>${esc(monthName(m))}</option>`).join('')}</select>
      <label class="btn block" for="imp-f" style="margin-top:14px">${t('imp.file.btn')}</label>
      <input id="imp-f" type="file" accept=".xlsx,.xls,.ods,.csv,.txt,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
      <p class="hint">${t('imp.file.hint')}</p>
      ${info.mapping ? `<p class="hint">✓ ${t('imp.template.known')}</p>` : ''}
      ${(info.aliases || []).length ? `<p class="hint">✓ ${t('imp.aliases.known', { n: info.aliases.length })}</p>` : ''}</div>
    ${historyHtml()}`;

  const colOptions = (sel) => `<option value="">${t('imp.col.none')}</option>${st.headers.map((h, i) => {
    const sample = st.rows.slice(0, 3).map((r) => txt(r[i])).filter(Boolean).join(' · ');
    return `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(h || `${t('imp.col')} ${i + 1}`)}${sample ? ` — ${esc(sample.slice(0, 40))}` : ''}</option>`;
  }).join('')}`;
  const mapStep = () => `<div class="card"><h1>${t('imp.cols.title')}</h1><p class="hint">${t('imp.cols.intro', { n: st.rows.length, file: st.file })}</p>
      ${FIELDS.map(([f, need]) => `<label for="imp-c-${f}">${t(`imp.f.${f}`)}${need ? ' *' : ''}</label><select id="imp-c-${f}" data-f="${f}">${colOptions(st.map[f])}</select>`).join('')}
      <p class="hint">${t('imp.cols.guide')}</p>
      <div class="row" style="gap:8px;margin-top:14px"><button type="button" class="btn ghost" data-back>${t('imp.back')}</button><button type="button" class="btn" data-next>${t('imp.next')}</button></div></div>`;

  const refOf = (r) => ({ code: st.map.guide_code != null ? txt(r[st.map.guide_code]) : '', name: st.map.guide_name != null ? txt(r[st.map.guide_name]) : '' });
  const refKey = (ref) => (ref.code ? `c|${plain(ref.code)}` : `n|${plain(ref.name)}`);   // un code = un guide, quel que soit le nom écrit
  const guideLabel = (g) => g ? `${esc(g.badge_name || g.name)} · ${esc(g.code)}` : '';
  const guidesStep = () => {
    const done = st.guides.filter((g) => g.code && (g.via !== 'name' || g.confirmed)).length;
    return `<div class="card"><h1>${t('imp.guides.title')}</h1><p class="hint">${t('imp.guides.intro', { ok: done, n: st.guides.length })}</p>
      <ul class="list">${st.guides.map((g, i) => `<li>
        <div class="spread"><span><b>${esc(g.ref.code || g.ref.name)}</b>${g.ref.code && g.ref.name ? ` <span class="hint">${esc(g.ref.name)}</span>` : ''}<br><span class="hint">${t('imp.guides.lines', { n: g.lines })}</span></span>
        <span>${g.code ? `<span class="badge ${g.via === 'name' && !g.confirmed ? 'warn' : 'ok'}">${g.via === 'name' && !g.confirmed ? '?' : '✓'}</span>` : '<span class="badge bad">✗</span>'}</span></div>
        ${g.code ? `<p class="hint">${guideLabel(g.guide)}${g.via === 'alias' ? ` · ${t('imp.via.alias')}` : g.via === 'code' ? ` · ${t('imp.via.code')}` : ''}</p>` : ''}
        ${g.via === 'name' && !g.confirmed ? `<button type="button" class="btn small" data-ok="${i}">${t('imp.guides.confirm')}</button> ` : ''}
        ${!g.code || (g.via === 'name' && !g.confirmed) ? `<div class="row" style="gap:6px;margin-top:6px"><input data-q="${i}" placeholder="${esc(tRaw('imp.guides.search'))}" style="flex:1"><button type="button" class="btn ghost small" data-find="${i}">${t('imp.guides.find')}</button></div><div data-res="${i}"></div>` : ''}
        ${g.code && (g.via === 'manual' || (g.via === 'name' && g.confirmed)) ? `<label style="font-weight:400"><input type="checkbox" data-save="${i}" style="width:auto"${g.save ? ' checked' : ''}> ${t('imp.guides.save')}</label>` : ''}
      </li>`).join('')}</ul>
      <p class="hint">${t('imp.guides.unknown')}</p>
      <div class="row" style="gap:8px;margin-top:14px"><button type="button" class="btn ghost" data-back>${t('imp.back')}</button><button type="button" class="btn" data-next>${t('imp.next')}</button></div></div>`;
  };

  // Lignes prêtes à envoyer, avec la raison d'un refus prévisible (contrôlé encore par Kombrio à l'import).
  const prepared = () => {
    const byRef = {};
    st.guides.forEach((g) => { byRef[g.key] = g; });
    const seen = {};
    return st.rows.map((r, i) => {
      const line = st.lines[i];
      const day = toDay(r[st.map.date]);
      const inv = toCents(r[st.map.invoice]);
      const com = st.map.commission != null && txt(r[st.map.commission]) !== '' ? toCents(r[st.map.commission]) : null;
      const g = byRef[refKey(refOf(r))];
      const ticket = st.map.ticket != null ? txt(r[st.map.ticket]) : '';
      let why = '';
      if (!txt(r[st.map.date]) && !txt(r[st.map.invoice])) why = 'empty';
      else if (!day) why = 'date';
      else if (day.slice(0, 7) !== st.month) why = 'other_month';
      else if (day > today) why = 'future';
      else if (inv == null || inv <= 0) why = 'amount';
      else if (!g || !g.code || (g.via === 'name' && !g.confirmed)) why = 'guide';
      else if (ticket && seen[ticket]) why = 'duplicate';
      if (ticket) seen[ticket] = true;
      return { line, why, day, inv, com, ticket, g, r };
    }).filter((x) => x.why !== 'empty');
  };
  const checkStep = () => {
    const all = prepared(); const ok = all.filter((x) => !x.why); const ko = all.filter((x) => x.why);
    const sumInv = ok.reduce((s, x) => s + x.inv, 0);
    const est = ok.reduce((s, x) => s + (x.com != null ? x.com : Math.round(x.inv * (partner.commissionRate || 0))), 0);
    return `<div class="card"><h1>${t('imp.check.title')}</h1>
      <div class="pd-kpis ios-kpis"><div class="pd-kpi"><span>${t('imp.check.ok')}</span><b>${ok.length}</b><em>${t('imp.check.of', { n: all.length })}</em></div>
        <div class="pd-kpi"><span>${t('imp.check.sales')}</span><b>${c(sumInv)}</b><em>${esc(monthName(st.month))}</em></div>
        <div class="pd-kpi"><span>${t('imp.check.com')}</span><b>${c(est)}</b><em>${t('imp.check.est')}</em></div></div>
      ${ko.length ? `<h2>${t('imp.check.ko', { n: ko.length })}</h2><ul class="list">${ko.slice(0, 60).map((x) => `<li class="spread"><span>${t('imp.line', { n: x.line })}${x.ticket ? ` · ${esc(x.ticket)}` : ''}</span><span class="hint">${t(`imp.why.${x.why}`)}</span></li>`).join('')}</ul>${ko.length > 60 ? `<p class="hint">+ ${ko.length - 60}</p>` : ''}` : ''}
      <p class="hint">${t('imp.check.rules')}</p>
      <div class="row" style="gap:8px;margin-top:14px"><button type="button" class="btn ghost" data-back>${t('imp.back')}</button>
      ${ok.length ? `<button type="button" class="btn" data-go>${t('imp.check.go', { n: ok.length })}</button>` : ''}</div></div>`;
  };
  const doneStep = (res) => `<div class="card"><h1>${t('imp.done.title')}</h1>
      <p><b>${t('imp.done.line', { n: res.imported, total: res.total })}</b></p>
      <p>${t('imp.done.com', { com: c(res.commission_cents || 0), sales: c(res.invoice_cents || 0) })}</p>
      ${(res.rejected || []).length ? `<h2>${t('imp.check.ko', { n: res.rejected.length })}</h2><ul class="list">${res.rejected.slice(0, 60).map((x) => `<li class="spread"><span>${t('imp.line', { n: x.line })}</span><span class="hint">${t(`imp.why.${x.reason}`)}</span></li>`).join('')}</ul>` : ''}
      ${res.imported ? `<a class="btn block" href="${base}/pagar" style="margin-top:12px">${t('imp.done.pay')}</a>` : ''}
      <a class="btn ghost block" href="${base}/importar" style="margin-top:8px">${t('imp.done.again')}</a></div>`;

  return {
    html: `<a class="ios-back no-print" href="${base}"><span aria-hidden="true">‹</span> ${t('ios.back.home')}</a><div id="imp-root">${fileStep()}</div>`,
    mount(root) {
      const box = root.querySelector('#imp-root');
      const show = (html) => { box.innerHTML = html; bind(); window.scrollTo(0, 0); };
      const busy = (b, on) => { if (b) b.disabled = on; };
      function bind() {
        const q = (s) => box.querySelector(s);
        const all = (s) => Array.prototype.slice.call(box.querySelectorAll(s));
        if (q('#imp-m')) q('#imp-m').onchange = (e) => { st.month = e.target.value; };
        if (q('#imp-f')) q('#imp-f').onchange = async (e) => {
          const f = e.target.files && e.target.files[0]; if (!f) return;
          try {
            // N° de ligne du fichier d'origine gardé (les lignes vides sont sautées).
            const table = (await readTable(f)).map((r, i) => ({ r: r || [], n: i + 1 })).filter((x) => x.r.some((v) => txt(v) !== ''));
            const h = headerIndex(table.map((x) => x.r));
            st.file = f.name;
            st.headers = ((table[h] || {}).r || []).map((x) => txt(x));
            st.lines = table.slice(h + 1).map((x) => x.n);
            st.rows = table.slice(h + 1).map((x) => x.r);
            if (!st.rows.length) { notify(tRaw('imp.err.empty')); return; }
            if (st.rows.length > MAX_ROWS) { notify(tRaw('imp.err.big', { n: MAX_ROWS })); return; }
            st.map = guessMapping(st.headers, info.mapping);
            show(mapStep());
          } catch (err) { console.error(err); notify(tRaw('imp.err.read')); }
        };
        all('[data-undo]').forEach((b) => { b.onclick = async () => {
          if (!window.confirm(tRaw('imp.undo.confirm'))) return;
          busy(b, true);
          try { const r = await store.importUndo(key, b.dataset.undo); notify(tRaw(r.ok ? 'imp.undo.done' : 'imp.undo.paid', { n: r.cancelled || 0 })); ctx.refresh(); } catch { busy(b, false); notify(tRaw('err.generic')); }
        }; });
        all('[data-f]').forEach((s) => { s.onchange = () => { st.map[s.dataset.f] = s.value === '' ? null : +s.value; }; });
        all('[data-back]').forEach((b) => { b.onclick = () => show(st.step === 'guides' ? (st.step = 'map', mapStep()) : st.step === 'check' ? (st.step = 'guides', guidesStep()) : (st.step = 'file', fileStep())); });
        all('[data-ok]').forEach((b) => { b.onclick = () => { const g = st.guides[+b.dataset.ok]; g.confirmed = true; g.save = true; show(guidesStep()); }; });
        all('[data-save]').forEach((k) => { k.onchange = () => { st.guides[+k.dataset.save].save = k.checked; }; });
        all('[data-find]').forEach((b) => { b.onclick = async () => {
          const i = +b.dataset.find; const qv = (q(`[data-q="${i}"]`).value || '').trim(); if (qv.length < 3) return;
          busy(b, true);
          const list = await store.findGuides(key, qv).catch(() => []);
          busy(b, false);
          q(`[data-res="${i}"]`).innerHTML = list.length ? list.map((g) => `<button type="button" class="btn ghost small" data-pick="${i}" data-code="${esc(g.code)}" data-name="${esc(g.badge_name || g.name)}">${esc(g.badge_name || g.name)} · ${esc(g.code)}</button>`).join(' ') : `<p class="hint">${t('imp.guides.none')}</p>`;
          all(`[data-pick="${i}"]`).forEach((p) => { p.onclick = () => {
            const g = st.guides[i]; g.code = p.dataset.code; g.guide = { code: p.dataset.code, name: p.dataset.name }; g.via = 'manual'; g.confirmed = true; g.save = true; show(guidesStep());
          }; });
        }; });
        const next = q('[data-next]');
        if (next) next.onclick = async () => {
          if (st.step === 'file' || st.step === 'map') {
            if (st.map.date == null || st.map.invoice == null || (st.map.guide_code == null && st.map.guide_name == null)) { notify(tRaw('imp.err.cols')); return; }
            busy(next, true);
            const refs = {}; const order = [];
            st.rows.forEach((r) => { const ref = refOf(r); if (!ref.code && !ref.name) return; const k = refKey(ref); if (!refs[k]) { refs[k] = { key: k, ref, lines: 0 }; order.push(k); } refs[k].lines++; });
            try {
              const res = order.length ? await store.importMatchGuides(key, order.map((k) => refs[k].ref)) : [];
              st.guides = order.map((k, i) => { const m = res[i] || {}; return { ...refs[k], guide: m.guide || null, code: m.guide ? m.guide.code : '', via: m.via || null, confirmed: m.via !== 'name', save: false }; });
              st.step = 'guides'; show(guidesStep());
            } catch { busy(next, false); notify(tRaw('err.generic')); }
            return;
          }
          if (st.step === 'guides') { st.step = 'check'; show(checkStep()); }
        };
        const go = q('[data-go]');
        if (go) go.onclick = async () => {
          busy(go, true); go.textContent = tRaw('imp.sending');
          try {
            // 1. Modèle (noms des colonnes) et codes guides du partenaire à retenir.
            const tpl = {}; FIELDS.forEach(([f]) => { if (st.map[f] != null) tpl[f] = st.headers[st.map[f]] || ''; });
            await store.importTemplateSet(key, tpl).catch(() => null);
            for (const g of st.guides) {
              if (g.code && g.save && g.via !== 'alias') await store.importAliasSet(key, g.ref.code || g.ref.name, g.code).catch(() => null);
            }
            // 2. Les lignes : seules les colonnes choisies partent.
            const rows = prepared().filter((x) => !x.why).map((x) => ({
              line: x.line, day: x.day, guide: x.g.code, invoice_cents: x.inv,
              commission_cents: x.com, ticket: x.ticket || null,
              seller: st.map.seller != null ? txt(x.r[st.map.seller]).slice(0, 60) : null,
              people: st.map.people != null ? (parseInt(txt(x.r[st.map.people]), 10) || null) : null,
              time: st.map.time != null ? toTime(x.r[st.map.time]) : null,
            }));
            const res = await store.importSales(key, `${st.month}-01`, st.file, rows);
            if (!res || !res.ok) { busy(go, false); notify(tRaw(`imp.why.${(res && res.reason) || 'error'}`)); return; }
            show(doneStep(res));
          } catch (err) { console.error(err); busy(go, false); go.textContent = tRaw('imp.check.go', { n: '' }); notify(tRaw('err.generic')); }
        };
      }
      bind();
    },
  };
}
