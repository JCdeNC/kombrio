// Fonction Supabase « aviso-email » (v56) : envoie les e-mails du cycle notés dans la boîte d'envoi (table mail_outbox).
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
    await admin(`/rest/v1/mail_outbox?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ attempts: (m.attempts || 0) + 1 }) });
    return json({ ok: true });
  } catch (e) {
    return json({ error: 'crash', detail: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }
});
