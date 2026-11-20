// Fonction Supabase « aviso-email » (v56 ; bienvenue partenaire v91 ; rappel des passages v59 ; bilan hebdomadaire admin + n° Brevo v66) : envoie les e-mails du cycle notés dans la boîte d'envoi (table mail_outbox).
// Appelée par la base (script 031) avec le numéro interne de l'e-mail, juste après sa mise en file.
// Sûre même si quelqu'un l'appelle à la main : elle n'envoie qu'un e-mail existant, encore « queued », une seule fois.
// Secret déjà en place : BREVO_API_KEY.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const brl = (c: unknown) => (Number(c ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthLabel = (m: string) => { const [y, mo] = String(m).split('-').map(Number); return `${MONTHS[(mo || 1) - 1]} de ${y}`; };

const box = (title: string, body: string, link: string, label: string) => `<div style="font-family:Arial,Helvetica,sans-serif;color:#102C38;max-width:520px">
  <h2 style="margin:0 0 12px">${title}</h2>${body}
  <p style="margin:20px 0"><a href="${link}" style="display:inline-block;padding:12px 20px;background:#007F65;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">${label}</a></p>
  <p style="margin:0;color:#5B6F78;font-size:12px">Kombrio · e-mail automático, não responda. Dúvidas: contato@kombrio.com.br</p></div>`;
const row = (a: string, b: string, strong = false) =>
  `<tr><td style="padding:4px 12px 4px 0;color:#5B6F78">${a}</td><td style="padding:4px 0;text-align:right">${strong ? `<b>${b}</b>` : b}</td></tr>`;

function build(kind: string, p: Record<string, unknown>): { subject: string; html: string } | null {
  if (kind === 'payout_paid') {
    const inss = Number(p.inss_cents ?? 0) > 0;
    return {
      subject: `Kombrio · repasse nº ${p.num} enviado: ${brl(p.net_cents)}`,
      html: box(`Olá ${esc(p.name)}, seu repasse foi enviado`,
        `<table style="border-collapse:collapse;width:100%">${row('Repasse', `nº ${esc(p.num)}`)}${row('Valor bruto (sua parte)', brl(p.gross_cents))}
          ${inss ? row('INSS retido (em nome dos parceiros)', `− ${brl(p.inss_cents)}`) : ''}${row('Valor líquido por Pix', brl(p.net_cents), true)}
          ${p.reference ? row('Referência', esc(p.reference)) : ''}</table>
         <p style="margin:16px 0 0">Confirme o recebimento no aplicativo para liberar o próximo repasse.${inss ? ' O detalhe inclui o recibo (RPA) de cada parceiro, para imprimir.' : ''}</p>`,
        `https://app.kombrio.com.br/guide/#/repasse/${p.payout_id}`, 'Ver o detalhe e confirmar'),
    };
  }
  if (kind === 'payment_verified') {
    return {
      subject: `Kombrio · Pix nº ${p.num} confirmado`,
      html: box(`Pix recebido, obrigado${p.manager ? `, ${esc(p.manager)}` : ''}!`,
        `<p>Confirmamos o recebimento do seu Pix de <b>${brl(p.amount_cents)}</b> (pagamento nº ${esc(p.num)}, ${esc(p.partner)}).
         A Kombrio repassa agora a parte de cada guia, em seu nome.</p>`,
        'https://app.kombrio.com.br/partner/', 'Abrir meu espaço'),
    };
  }
  if (kind === 'payment_rejected') {
    return {
      subject: `Kombrio · Pix nº ${p.num} não confirmado`,
      html: box('Não conseguimos confirmar seu Pix',
        `<p>O pagamento nº ${esc(p.num)} de <b>${brl(p.amount_cents)}</b> (${esc(p.partner)}) não foi confirmado.</p>
         ${p.note ? `<blockquote style="margin:0;padding:12px 16px;background:#F4F7F8;border-left:4px solid #F6B73C">${esc(p.note)}</blockquote>` : ''}
         <p>As visitas voltaram para « a pagar ». Envie um novo Pix com o comprovante no seu espaço.</p>`,
        'https://app.kombrio.com.br/partner/', 'Abrir meu espaço'),
    };
  }
  if (kind === 'month_closed') {
    const due = Number(p.to_pay_cents ?? 0);
    return {
      subject: `Kombrio · demonstrativo de ${monthLabel(String(p.month))} (${p.doc_code})`,
      html: box(`Seu demonstrativo de ${monthLabel(String(p.month))} está pronto`,
        `<table style="border-collapse:collapse;width:100%">${row('Documento', `${esc(p.doc_code)} · versão ${esc(p.version)}`)}
          ${row('Comissões do mês', brl(p.commission_cents))}${due > 0 ? row('A pagar', brl(due), true) : ''}</table>
         <p style="margin:16px 0 0">Abra « Meu mês » no seu espaço para baixar o demonstrativo (PDF ou Excel). Seu contador o vê pelo link do relatório.</p>`,
        'https://app.kombrio.com.br/partner/', 'Abrir meu espaço'),
    };
  }
  if (kind === 'visits_pending') {
    const n = Number(p.count ?? 0);
    return {
      subject: `Kombrio · ${n} visita(s) sem valor de conta`,
      html: box(`Olá ${esc(p.manager || p.partner)}, faltam valores de conta`,
        `<p style="margin:0">${n} grupo(s) Kombrio passaram no ${esc(p.partner)} e ainda estão « Pendentes », sem o valor da conta.</p>
         <p style="margin:12px 0 0">Lance o valor (ou « Não consumiu ») em « Pendentes agora », no seu espaço: leva um minuto.</p>`,
        'https://app.kombrio.com.br/partner/', 'Lançar os valores'),
    };
  }
  if (kind === 'j1_reminder') {
    // v73 : rappel du matin (jours ouvrés) — virements J+1 du guide présent à faire.
    const rows = Array.isArray(p.rows) ? (p.rows as Record<string, unknown>[]) : [];
    const brl = (c: unknown) => `R$ ${(Number(c ?? 0) / 100).toFixed(2).replace('.', ',')}`;
    const lines = rows.map((r) => `<tr><td style="padding:6px 10px 6px 0">${esc(r.guide)}</td><td style="padding:6px 10px 6px 0;text-align:right"><b>${brl(r.cents)}</b></td>
      <td style="padding:6px 0;color:${r.late ? '#D64545' : '#5B6F78'}">${r.late ? 'aujourd’hui au plus tard' : `avant le ${esc(r.due)}`}</td></tr>`).join('');
    const late = rows.filter((r) => r.late).length;
    return {
      subject: `Kombrio · ${rows.length} virement(s) J+1 à faire${late ? ` (dont ${late} aujourd’hui)` : ''}`,
      html: box(`Virements J+1 du ${esc(p.date)}`,
        `<p>Le partenaire a payé : ces guides étaient présents avec leurs clients et doivent être payés au plus tard le jour ouvré suivant.</p>
         <table style="border-collapse:collapse;width:100%;font-size:14px">${lines}</table>
         <p style="margin:16px 0 0;color:#5B6F78;font-size:13px">Admin › Virements › « Virements J+1 » : Préparer le virement J+1, puis Envoyer par Inter.</p>`,
        'https://app.kombrio.com.br/admin/', 'Ouvrir l’admin'),
    };
  }
  if (kind === 'partner_welcome') {
    // v91 : bienvenue au partenaire validé, dans la langue de son inscription (portugais par défaut).
    const W: Record<string, { s: string; h: string; b: string; l: string; f: string }> = {
      pt: { s: 'Bem-vindo à Kombrio', h: 'Bem-vindo à Kombrio{m}!', b: 'O cadastro de <b>{p}</b> foi validado: o seu espaço de parceiro está ativo. Os guias já podem trazer clientes e você registra cada visita escaneando o QR do cliente.', l: 'Abrir meu espaço', f: 'Kombrio · e-mail automático, não responda. Dúvidas: contato@kombrio.com.br' },
      fr: { s: 'Bienvenue chez Kombrio', h: 'Bienvenue chez Kombrio{m} !', b: 'L’inscription de <b>{p}</b> est validée : votre espace partenaire est actif. Les guides peuvent maintenant vous amener des clients ; vous enregistrez chaque visite en scannant le QR du client.', l: 'Ouvrir mon espace', f: 'Kombrio · e-mail automatique, ne pas répondre. Questions : contato@kombrio.com.br' },
      en: { s: 'Welcome to Kombrio', h: 'Welcome to Kombrio{m}!', b: '<b>{p}</b> has been approved: your partner space is active. Guides can now bring you customers; you record each visit by scanning the customer’s QR code.', l: 'Open my space', f: 'Kombrio · automatic e-mail, do not reply. Questions: contato@kombrio.com.br' },
      es: { s: 'Bienvenido a Kombrio', h: '¡Bienvenido a Kombrio{m}!', b: 'El registro de <b>{p}</b> fue validado: su espacio de socio está activo. Los guías ya pueden traerle clientes; usted registra cada visita escaneando el QR del cliente.', l: 'Abrir mi espacio', f: 'Kombrio · e-mail automático, no responda. Dudas: contato@kombrio.com.br' },
    };
    const w = W[String(p.lang)] || (p.lang === 'de' ? W.en : W.pt);
    const m = p.manager ? `, ${esc(p.manager)}` : '';
    return {
      subject: `${w.s} · ${String(p.partner ?? '')}`,
      html: box(w.h.replace('{m}', m), `<p>${w.b.replace('{p}', esc(p.partner))}</p>`, 'https://app.kombrio.com.br/partner/', w.l)
        .replace('Kombrio · e-mail automático, não responda. Dúvidas: contato@kombrio.com.br', w.f),
    };
  }
  if (kind === 'broadcast') {
    // v117 : aviso de Kombrio (script 069), déjà dans la langue du destinataire (sinon en portugais).
    const L: Record<string, { hi: string; open: string; legal: string; imp: string; lgl: string; f: string }> = {
      pt: { hi: 'Olá', open: 'Abrir o aplicativo', legal: 'Abra o aplicativo para confirmar a leitura (« Li e entendi »).', imp: 'Importante', lgl: 'Aviso legal', f: 'Kombrio · e-mail automático, não responda. Dúvidas: contato@kombrio.com.br' },
      fr: { hi: 'Bonjour', open: 'Ouvrir l’application', legal: 'Ouvrez l’application pour confirmer la lecture (« J’ai lu et compris »).', imp: 'Important', lgl: 'Avis légal', f: 'Kombrio · e-mail automatique, ne pas répondre. Questions : contato@kombrio.com.br' },
      en: { hi: 'Hello', open: 'Open the app', legal: 'Open the app to confirm you have read it (“I have read and understood”).', imp: 'Important', lgl: 'Legal notice', f: 'Kombrio · automatic e-mail, do not reply. Questions: contato@kombrio.com.br' },
      es: { hi: 'Hola', open: 'Abrir la aplicación', legal: 'Abra la aplicación para confirmar la lectura (« Leí y entendí »).', imp: 'Importante', lgl: 'Aviso legal', f: 'Kombrio · e-mail automático, no responda. Dudas: contato@kombrio.com.br' },
      de: { hi: 'Hallo', open: 'App öffnen', legal: 'Öffnen Sie die App, um das Lesen zu bestätigen („Gelesen und verstanden“).', imp: 'Wichtig', lgl: 'Rechtlicher Hinweis', f: 'Kombrio · automatische E-Mail, bitte nicht antworten. Fragen: contato@kombrio.com.br' },
    };
    const w = L[String(p.lang)] || L.pt;
    const legal = p.level === 'legal';
    const paras = String(p.body ?? '').trim().split(/\n{2,}/).map((x) => `<p style="margin:0 0 12px;line-height:1.5">${esc(x).replace(/\n/g, '<br>')}</p>`).join('');
    const link = p.app === 'partner' ? 'https://app.kombrio.com.br/partner/' : 'https://app.kombrio.com.br/guide/';
    return {
      subject: `Kombrio · ${legal ? w.lgl : w.imp}: ${String(p.title ?? '')}`,
      html: box(esc(String(p.title ?? '')),
        `${p.name ? `<p style="margin:0 0 12px">${w.hi} ${esc(p.name)},</p>` : ''}${paras}
         ${legal ? `<p style="margin:12px 0 0;padding:10px 14px;background:#FDECEC;border-radius:10px"><b>${w.legal}</b></p>` : ''}`,
        link, w.open).replace('Kombrio · e-mail automático, não responda. Dúvidas: contato@kombrio.com.br', w.f),
    };
  }
  if (kind === 'admin_report') {
    // v66 : bilan hebdomadaire pour l'administration (en français), envoyé par la routine du lundi.
    const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
    const grave = Number(p.grave ?? 0), att = Number(p.attention ?? 0);
    const dot: Record<string, string> = { grave: '#D64545', attention: '#F6B73C', ok: '#007F65', info: '#8AA0A8' };
    const order: Record<string, number> = { grave: 0, attention: 1, ok: 2, info: 3 };
    const lines = [...items].sort((a, b) => (order[String(a.level)] ?? 9) - (order[String(b.level)] ?? 9))
      .map((i) => `<tr><td style="padding:6px 10px 6px 0;vertical-align:top"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dot[String(i.level)] ?? '#8AA0A8'}"></span></td><td style="padding:6px 0">${esc(i.text)}</td></tr>`).join('');
    const verdict = grave > 0 ? `${grave} problème(s) grave(s) à régler` : att > 0 ? `${att} point(s) à regarder` : 'tout va bien';
    // v84 : le rappel INSS (script 049) réutilise ce gabarit avec son propre objet, titre et pied.
    if (p.subject) {
      return {
        subject: String(p.subject),
        html: box(esc(String(p.title ?? p.subject)),
          `<table style="border-collapse:collapse;width:100%;font-size:14px">${lines}</table>
           <p style="margin:16px 0 0;color:#5B6F78;font-size:13px">${esc(String(p.footer ?? ''))}</p>`,
          'https://app.kombrio.com.br/admin/#/inss', 'Ouvrir l’admin › INSS'),
      };
    }
    return {
      subject: `Kombrio · bilan de la semaine : ${verdict}`,
      html: box(`Bilan du ${esc(p.date)} : ${verdict}`,
        `<table style="border-collapse:collapse;width:100%;font-size:14px">${lines}</table>
         <p style="margin:16px 0 0;color:#5B6F78;font-size:13px">Recevoir cet e-mail prouve que la chaîne complète marche : base → fonction → Brevo → boîte de réception.
         Pas de bilan un lundi = quelque chose est cassé (GitHub envoie aussi une alerte si la routine échoue).</p>`,
        'https://app.kombrio.com.br/admin/', 'Ouvrir l’admin'),
    };
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    const brevo = Deno.env.get('BREVO_API_KEY');
    if (!brevo) return json({ error: 'not_configured' }, 503);
    const { id } = await req.json().catch(() => ({}));
    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) return json({ error: 'mail' }, 400);

    // Réserve l'envoi : ne passe que si l'e-mail est encore en file.
    const claim = await admin(`/rest/v1/mail_outbox?id=eq.${id}&status=eq.queued&select=kind,to_email,payload,attempts`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString() }),
    });
    const m = (await claim.json())?.[0];
    if (!m) return json({ ok: true, skipped: true });
    const mail = build(m.kind, m.payload || {});
    const fail = async (err: string) => {
      await admin(`/rest/v1/mail_outbox?id=eq.${id}`, { method: 'PATCH',
        body: JSON.stringify({ status: 'failed', sent_at: null, attempts: (m.attempts || 0) + 1, last_error: err.slice(0, 300) }) });
    };
    if (!mail) { await fail(`kind ${m.kind}`); return json({ error: 'kind' }, 400); }

    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevo, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: 'Kombrio', email: 'nao-responda@kombrio.com.br' },
        to: [{ email: m.to_email }], subject: mail.subject, htmlContent: mail.html }),
    });
    if (!r.ok) { await fail(`brevo ${r.status} ${(await r.text()).slice(0, 200)}`); return json({ error: 'brevo', status: r.status }, 502); }
    const sent = await r.json().catch(() => ({}));
    await admin(`/rest/v1/mail_outbox?id=eq.${id}`, { method: 'PATCH',
      body: JSON.stringify({ attempts: (m.attempts || 0) + 1, provider_id: sent?.messageId ?? null }) });
    return json({ ok: true });
  } catch (e) {
    return json({ error: 'crash', detail: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }
});
