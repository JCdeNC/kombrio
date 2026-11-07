// Fonction Supabase « alerta-admin » (v52) : e-mail aux administrateurs quand un guide ou un partenaire envoie une alerte.
// Appelée par la base (déclencheur du script 026) avec le numéro interne de l'alerte, juste après sa création.
// Sûre même si quelqu'un l'appelle à la main : elle ne fait qu'envoyer l'e-mail d'une alerte existante, une seule fois
// (colonne alerts.notified_at). Secret déjà en place : BREVO_API_KEY.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const TOPICS: Record<string, string> = {
  late: 'Paiement en retard', amount: 'Montant contesté', noqr: 'QR non scanné', payout: 'Virement non reçu',
  pix: 'Clé Pix', offer: 'Offre du partenaire', conduct: 'Problème de comportement', howpay: 'Comment payer',
  wrong: 'Erreur de déclaration', rejected: 'Paiement refusé', disputed: 'Visite en examen', guide: 'Problème avec un guide',
  other: 'Autre sujet',
};

Deno.serve(async (req) => {
  try {
    const brevo = Deno.env.get('BREVO_API_KEY');
    if (!brevo) return json({ error: 'not_configured' }, 503);
    const { id } = await req.json().catch(() => ({}));
    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) return json({ error: 'alert' }, 400);

    // Réserve l'envoi : ne passe que si l'alerte n'a encore jamais été envoyée.
    const claim = await admin(`/rest/v1/alerts?id=eq.${id}&notified_at=is.null&select=num,author_kind,topic,message,guide_id,partner_id,created_at`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ notified_at: new Date().toISOString() }),
    });
    const a = (await claim.json())?.[0];
    if (!a) return json({ ok: true, skipped: true });

    const who = a.author_kind === 'guide'
      ? (await (await admin(`/rest/v1/guides?id=eq.${a.guide_id}&select=name,code`)).json())?.[0]
      : (await (await admin(`/rest/v1/partners?id=eq.${a.partner_id}&select=name`)).json())?.[0];
    const author = `${a.author_kind === 'guide' ? 'Guide' : 'Partenaire'} : ${who?.name ?? '?'}${who?.code ? ` (${who.code})` : ''}`;

    // Destinataires : tous les comptes administrateurs.
    const admins = await (await admin('/rest/v1/profiles?role=eq.admin&select=id')).json();
    const to: { email: string }[] = [];
    for (const p of admins ?? []) {
      const u = await (await admin(`/auth/v1/admin/users/${p.id}`)).json();
      if (u?.email) to.push({ email: u.email });
    }
    if (!to.length) return json({ error: 'no_admin' }, 500);

    const topic = TOPICS[a.topic] ?? a.topic;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#102C38;max-width:520px">
      <h2 style="margin:0 0 8px">Nouvelle alerte n° ${a.num} : ${esc(topic)}</h2>
      <p style="margin:0 0 4px"><b>${esc(author)}</b></p>
      <p style="margin:0 0 16px;color:#5B6F78">${new Date(a.created_at).toLocaleString('fr-FR', { timeZone: 'America/Sao_Paulo' })} (heure de Rio)</p>
      <blockquote style="margin:0 0 20px;padding:12px 16px;background:#F4F7F8;border-left:4px solid #F6B73C">${esc(a.message || '(sans message)').replace(/\n/g, '<br>')}</blockquote>
      <a href="https://app.kombrio.com.br/admin/" style="display:inline-block;padding:12px 20px;background:#007F65;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">Ouvrir l'admin › Alertes</a>
    </div>`;
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevo, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Kombrio Alertes', email: 'nao-responda@kombrio.com.br' },
        to, subject: `Kombrio · alerte n° ${a.num} : ${topic}`, htmlContent: html,
      }),
    });
    if (!r.ok) {
      // Envoi raté : on libère l'alerte pour pouvoir réessayer.
      await admin(`/rest/v1/alerts?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ notified_at: null }) });
      return json({ error: 'brevo', status: r.status }, 502);
    }
    return json({ ok: true, sent: to.length });
  } catch (e) {
    return json({ error: 'crash', detail: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }
});
